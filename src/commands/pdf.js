const sharp = require('sharp');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

// In-memory active PDF creation sessions (keyed by user JID)
const pdfSessions = new Map();
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes TTL

function cleanExpiredSessions() {
    const now = Date.now();
    for (const [key, session] of pdfSessions.entries()) {
        if (now - (session.lastActive || session.createdAt || 0) > SESSION_TTL_MS) {
            pdfSessions.delete(key);
        }
    }
}

/**
 * Intelligent Document Auto-Crop
 * Detects document boundaries (bright paper vs darker background) with safe padding.
 */
async function autoCropDocument(buffer) {
    try {
        const metadata = await sharp(buffer).metadata();
        const { width, height } = metadata;
        if (!width || !height) return buffer;

        // Work on 200-wide thumbnail for ultra fast detection (sub-10ms)
        const thumbW = 200;
        const thumbH = Math.round((height / width) * 200);

        const thumb = await sharp(buffer)
            .resize(thumbW, thumbH)
            .raw()
            .toBuffer();

        // Check row-by-row and col-by-col paper concentration
        const rowWhite = new Array(thumbH).fill(0);
        const colWhite = new Array(thumbW).fill(0);

        for (let y = 0; y < thumbH; y++) {
            for (let x = 0; x < thumbW; x++) {
                const idx = (y * thumbW + x) * 3;
                const r = thumb[idx];
                const g = thumb[idx + 1];
                const b = thumb[idx + 2];
                const luma = 0.299 * r + 0.587 * g + 0.114 * b;
                // Paper has high luminance and neutral color balance
                const isPaper = (luma > 150 && Math.abs(r - g) < 30 && Math.abs(r - b) < 30);
                if (isPaper) {
                    rowWhite[y]++;
                    colWhite[x]++;
                }
            }
        }

        // Find contiguous document span
        let startY = -1, endY = -1;
        for (let y = 0; y < thumbH; y++) {
            const ratio = rowWhite[y] / thumbW;
            if (ratio > 0.40 && startY === -1) startY = y;
            if (ratio > 0.40) endY = y;
        }

        let startX = -1, endX = -1;
        for (let x = 0; x < thumbW; x++) {
            const ratio = colWhite[x] / thumbH;
            if (ratio > 0.30 && startX === -1) startX = x;
            if (ratio > 0.30) endX = x;
        }

        if (startX >= 0 && endX > startX && startY >= 0 && endY > startY) {
            const scaleX = width / thumbW;
            const scaleY = height / thumbH;

            // Safe margin (1.5%)
            const padX = Math.round(width * 0.015);
            const padY = Math.round(height * 0.015);

            const cropLeft = Math.max(0, Math.round(startX * scaleX) - padX);
            const cropTop = Math.max(0, Math.round(startY * scaleY) - padY);
            const cropWidth = Math.min(width - cropLeft, Math.round((endX - startX) * scaleX) + padX * 2);
            const cropHeight = Math.min(height - cropTop, Math.round((endY - startY) * scaleY) + padY * 2);

            const cropArea = cropWidth * cropHeight;
            const totalArea = width * height;
            const areaRatio = cropArea / totalArea;

            if (areaRatio > 0.20 && areaRatio < 0.96 && cropWidth > width * 0.3 && cropHeight > height * 0.3) {
                return sharp(buffer)
                    .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
                    .toBuffer();
            }
        }

        return buffer;
    } catch {
        return buffer;
    }
}

/**
 * CamScanner-Grade Illumination Normalization & Magic Filter
 * Uses Retinex-based illumination division to eliminate uneven shadows,
 * whiten document paper backgrounds, and preserve/boost colored stamps and text.
 *
 * @param {Buffer} buffer - Image buffer
 * @param {'magic'|'bw'} mode - 'magic' (Magic Color) or 'bw' (Clear B&W)
 */
async function applyMagicScan(buffer, mode = 'magic') {
    try {
        // 1. Auto-orient based on EXIF and cap resolution at 2048px (high-res scan, memory safe for Koyeb)
        const pipeline = sharp(buffer)
            .rotate()
            .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
            .removeAlpha();

        const meta = await pipeline.metadata();
        const width = meta.width || 800;
        const height = meta.height || 600;

        const rawOrig = await pipeline.raw().toBuffer();

        // 2. Generate smooth low-frequency background illumination map
        // Large-scale downsample + blur + upsample acts as an ultra-fast large-kernel low-pass filter
        const downW = Math.max(16, Math.round(width / 32));
        const downH = Math.max(16, Math.round(height / 32));

        const rawBg = await sharp(rawOrig, { raw: { width, height, channels: 3 } })
            .resize(downW, downH, { fit: 'fill' })
            .blur(12)
            .resize(width, height, { fit: 'fill' })
            .raw()
            .toBuffer();

        const totalPixels = width * height;
        const outBuf = Buffer.alloc(totalPixels * 3);

        const isMagicColor = (mode === 'magic' || mode === 'color');

        if (isMagicColor) {
            // MODE 1: CAMSCANNER MAGIC COLOR
            // Retinex illumination division: I_norm = (I_orig / I_bg) * 255
            // Whitens paper, erases shadows, keeps stamps, ink, and photos vibrant
            const whitePoint = 225;
            const blackPoint = 35;
            const range = whitePoint - blackPoint;

            for (let i = 0; i < totalPixels; i++) {
                const idx = i * 3;
                for (let c = 0; c < 3; c++) {
                    const origVal = rawOrig[idx + c];
                    const bgVal = Math.max(rawBg[idx + c], 25); // prevent divide by zero

                    let norm = (origVal / bgVal) * 255;

                    if (norm >= whitePoint) {
                        norm = 255;
                    } else if (norm <= blackPoint) {
                        norm = 0;
                    } else {
                        norm = ((norm - blackPoint) / range) * 255;
                    }

                    outBuf[idx + c] = Math.min(255, Math.max(0, Math.round(norm)));
                }
            }

            return sharp(outBuf, { raw: { width, height, channels: 3 } })
                .modulate({ saturation: 1.2 }) // enhance stamps & signature color
                .sharpen({ sigma: 0.8, m1: 0.5, m2: 1.5 })
                .jpeg({ quality: 88 })
                .toBuffer();

        } else {
            // MODE 2: CLEAR B&W (DOKUMEN HITAM PUTIH BERSIH)
            // High-contrast document binarization with anti-aliased text edges (zero muddy shadows)
            for (let i = 0; i < totalPixels; i++) {
                const idx = i * 3;
                const origY = 0.299 * rawOrig[idx] + 0.587 * rawOrig[idx + 1] + 0.114 * rawOrig[idx + 2];
                const bgY = Math.max(0.299 * rawBg[idx] + 0.587 * rawBg[idx + 1] + 0.114 * rawBg[idx + 2], 25);

                const norm = (origY / bgY) * 255;

                let val = 255;
                if (norm < 190) {
                    val = Math.max(0, Math.round(((norm - 40) / (190 - 40)) * 255));
                }

                outBuf[idx] = val;
                outBuf[idx + 1] = val;
                outBuf[idx + 2] = val;
            }

            return sharp(outBuf, { raw: { width, height, channels: 3 } })
                .sharpen({ sigma: 1.0, m1: 0.8, m2: 2.0 })
                .jpeg({ quality: 85 })
                .toBuffer();
        }
    } catch {
        // Safe fallback in case of corrupted buffer
        return sharp(buffer).jpeg({ quality: 90 }).toBuffer();
    }
}

const SCANNER_URL = process.env.SCANNER_URL || '';
const SCANNER_TIMEOUT_MS = parseInt(process.env.SCANNER_TIMEOUT_MS || '15000', 10);

/**
 * Dispatches document image to Python FastAPI scanner microservice (OpenCV 4-point warp + adaptive threshold)
 * with graceful fallback to local Retinex processing on error or timeout.
 */
async function callScanner(buffer, mode = 'bw', logger) {
    if (!SCANNER_URL) {
        const isColor = (mode === 'color' || mode === 'magic');
        return await applyMagicScan(await autoCropDocument(buffer), isColor ? 'magic' : 'bw');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SCANNER_TIMEOUT_MS);

    try {
        const formData = new FormData();
        const blob = new Blob([buffer], { type: 'image/jpeg' });
        formData.append('image', blob, 'document.jpg');

        const scanMode = (mode === 'color' || mode === 'magic') ? 'color' : 'bw';
        const endpoint = `${SCANNER_URL.replace(/\/+$/, '')}/scan?mode=${scanMode}`;
        const res = await fetch(endpoint, {
            method: 'POST',
            body: formData,
            signal: controller.signal
        });

        if (!res.ok) {
            throw new Error(`Scanner microservice returned HTTP ${res.status}`);
        }

        const arrayBuf = await res.arrayBuffer();
        return Buffer.from(arrayBuf);
    } catch (err) {
        if (logger?.warn) {
            logger.warn({ err: err.message }, '[PDF Scanner] Microservice call failed or timed out, falling back to local');
        }
        const isColor = (mode === 'color' || mode === 'magic');
        return await applyMagicScan(await autoCropDocument(buffer), isColor ? 'magic' : 'bw');
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Creates a valid multi-page PDF-1.4 buffer directly from JPEG image buffers.
 */
async function imagesToPdf(imageBuffers) {
    const pages = [];

    for (const buf of imageBuffers) {
        const metadata = await sharp(buf).metadata();
        const jpegBuffer = (metadata.format === 'jpeg')
            ? buf
            : await sharp(buf).jpeg({ quality: 90 }).toBuffer();
        const { width, height } = await sharp(jpegBuffer).metadata();
        pages.push({
            width: width || 800,
            height: height || 600,
            buffer: jpegBuffer
        });
    }

    const objects = [];
    const offsets = [];

    let currentObj = 1;
    const catalogObjNum = currentObj++;
    const pagesObjNum = currentObj++;

    const pageObjNums = [];
    const contentObjNums = [];
    const imageObjNums = [];

    for (let i = 0; i < pages.length; i++) {
        pageObjNums.push(currentObj++);
        contentObjNums.push(currentObj++);
        imageObjNums.push(currentObj++);
    }

    let pdf = `%PDF-1.4\n%\xE2\xE3\xCF\xD3\n`;

    function addObj(content, stream) {
        offsets.push(Buffer.byteLength(pdf, 'latin1'));
        if (stream) {
            pdf += `${objects.length + 1} 0 obj\n${content}\nstream\n`;
            pdf += stream.toString('latin1');
            pdf += `\nendstream\nendobj\n`;
        } else {
            pdf += `${objects.length + 1} 0 obj\n${content}\nendobj\n`;
        }
        objects.push(true);
    }

    addObj(`<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>`);
    addObj(`<< /Type /Pages /Kids [${pageObjNums.map(n => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`);

    for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const contentNum = contentObjNums[i];
        const imgNum = imageObjNums[i];

        const contentStream = `q ${page.width} 0 0 ${page.height} 0 0 cm /Im0 Do Q`;
        const contentLen = Buffer.byteLength(contentStream, 'latin1');

        // Page object — Contents references a separate indirect object
        addObj(`<< /Type /Page /Parent ${pagesObjNum} 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /XObject << /Im0 ${imgNum} 0 R >> >> /Contents ${contentNum} 0 R >>`);
        // Content stream as its own indirect object
        addObj(`<< /Length ${contentLen} >>`, Buffer.from(contentStream, 'latin1'));
        // Image XObject
        addObj(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.buffer.length} >>`, page.buffer);
    }

    const startXref = Buffer.byteLength(pdf, 'latin1');
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
        pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
    }

    pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObjNum} 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;

    return Buffer.from(pdf, 'latin1');
}

function getCleanFileName(customTitle, defaultPrefix) {
    if (customTitle && customTitle.trim()) {
        const sanitized = customTitle.trim().replace(/[/\\?%*:|"<>]/g, '_').replace(/\s+/g, '_');
        return sanitized.toLowerCase().endsWith('.pdf') ? sanitized : `${sanitized}.pdf`;
    }
    return `${defaultPrefix}.pdf`;
}

function getSender(msg, sock) {
    if (msg?.key?.fromMe) {
        return sock?.user?.id?.replace(/:.*@/, '@') || msg?.key?.remoteJid;
    }
    return msg?.key?.participant || msg?.key?.remoteJid;
}

async function extractImageBuffer(msg, logger) {
    try {
        let m = msg?.message;
        if (!m) return null;
        if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
        if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
        if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
        if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;

        if (m.imageMessage || (m.documentMessage && m.documentMessage.mimetype?.startsWith('image/'))) {
            return await downloadMediaMessage(
                { key: msg.key, message: m },
                'buffer',
                {},
                { logger: logger || console }
            );
        }

        const quoted = m.extendedTextMessage?.contextInfo?.quotedMessage;
        if (quoted?.imageMessage || (quoted?.documentMessage && quoted.documentMessage.mimetype?.startsWith('image/'))) {
            return await downloadMediaMessage(
                {
                    key: { remoteJid: msg.key?.remoteJid, id: m.extendedTextMessage?.contextInfo?.stanzaId },
                    message: quoted
                },
                'buffer',
                {},
                { logger: logger || console }
            );
        }
    } catch (err) {
        if (logger?.warn) logger.warn({ err }, '[PDF] Media download error');
    }
    return null;
}

function normalizeParams(sockOrOpts, msg, args, ctx) {
    if (sockOrOpts && sockOrOpts.sock) {
        return {
            sock: sockOrOpts.sock,
            msg: sockOrOpts.msg,
            args: sockOrOpts.args || [],
            cmdName: sockOrOpts.cmdName,
            remoteJid: sockOrOpts.remoteJid || sockOrOpts.msg?.key?.remoteJid,
            senderJid: sockOrOpts.senderJid,
            logger: sockOrOpts.logger,
            PREFIX: sockOrOpts.PREFIX || process.env.PREFIX || '!'
        };
    }
    return {
        sock: sockOrOpts,
        msg,
        args: args || [],
        cmdName: args?._command || 'pdf',
        remoteJid: msg?.key?.remoteJid,
        senderJid: getSender(msg, sockOrOpts),
        logger: ctx?.logger,
        PREFIX: process.env.PREFIX || '!'
    };
}

module.exports = {
    names: ['pdf', 'topdf', 'scan', 'pdfdone', 'donepdf', 'pdfcancel'],
    imagesToPdf,
    autoCropDocument,
    applyMagicScan,
    callScanner,
    pdfSessions,
    handleActiveSession: async ({ sock, msg, senderJid, remoteJid, logger, messageText, PREFIX }) => {
        cleanExpiredSessions();
        if (!pdfSessions.has(senderJid)) return false;

        // If message is an explicit command starting with PREFIX (e.g. !pdfdone, !pdfcancel, !scan), let normal router handle it
        if (messageText && messageText.startsWith(PREFIX)) {
            return false;
        }

        const imageBuffer = await extractImageBuffer(msg, logger);
        if (!imageBuffer) return false;

        const session = pdfSessions.get(senderJid);
        session.rawBuffers.push(imageBuffer);
        session.lastActive = Date.now();

        const count = session.rawBuffers.length;
        await sock.sendMessage(remoteJid, {
            text: `✅ *Halaman ${count} Tersimpan!*\n\n` +
                  `• Total Halaman: *${count}*\n\n` +
                  `Silakan kirim foto berikutnya, atau ketik:\n` +
                  `• \`${PREFIX}pdfdone\` : Selesai & Dapatkan 2 Versi PDF (Magic Color & Clear B&W)\n` +
                  `• \`${PREFIX}pdfcancel\` : Batalkan sesi`
        }, { quoted: msg });

        return true;
    },
    execute: async (sockOrOpts, rawMsg, rawArgs, ctx) => {
        const { sock, msg, args, cmdName, remoteJid, senderJid, logger, PREFIX } = normalizeParams(sockOrOpts, rawMsg, rawArgs, ctx);
        const sender = senderJid || getSender(msg, sock);
        const command = (cmdName || args._command || 'pdf').toLowerCase();
        const customTitle = args.join(' ').trim();

        cleanExpiredSessions();

        // 1. CANCEL SESSION
        if (command === 'pdfcancel') {
            if (pdfSessions.has(sender)) {
                pdfSessions.delete(sender);
                return sock.sendMessage(remoteJid, { text: '🗑️ *Sesi pembuatan PDF telah dibatalkan.*' }, { quoted: msg });
            }
            return sock.sendMessage(remoteJid, { text: 'ℹ️ Tidak ada sesi PDF aktif.' }, { quoted: msg });
        }

        // 2. FINISH & GENERATE DUAL PDF OUTPUT (Magic Color & Clear B&W)
        if (command === 'pdfdone' || command === 'donepdf') {
            const session = pdfSessions.get(sender);
            if (!session || session.rawBuffers.length === 0) {
                return sock.sendMessage(remoteJid, {
                    text: '❌ *Belum ada gambar dalam sesi!*' +
                          `\nKirim/reply gambar terlebih dahulu dengan \`${PREFIX}topdf\` atau \`${PREFIX}scan\`.`
                }, { quoted: msg });
            }

            const { heavyTaskQueue } = require('../utils/cache');
            return heavyTaskQueue.add(async () => {
                try {
                    const totalPages = session.rawBuffers.length;
                    await sock.sendMessage(remoteJid, {
                        text: `⏳ *Menggabungkan ${totalPages} halaman & menyiapkan 2 versi PDF (Magic Color & Clear B&W)...*`
                    }, { quoted: msg });

                    const finalTitle = customTitle || session.title || '';
                    const baseFileName = getCleanFileName(finalTitle, 'Dokumen_Scan');
                    const baseNameNoExt = baseFileName.replace(/\.pdf$/i, '');

                    // Process Version 1: CamScanner Magic Color
                    const v1Buffers = [];
                    for (const raw of session.rawBuffers) {
                        const enhanced = await callScanner(raw, 'color', logger);
                        v1Buffers.push(enhanced);
                    }
                    const pdfV1 = await imagesToPdf(v1Buffers);

                    // Process Version 2: CamScanner Clear B&W
                    const v2Buffers = [];
                    for (const raw of session.rawBuffers) {
                        const enhanced = await callScanner(raw, 'bw', logger);
                        v2Buffers.push(enhanced);
                    }
                    const pdfV2 = await imagesToPdf(v2Buffers);

                    // Send PDF 1 (Magic Color)
                    await sock.sendMessage(remoteJid, {
                        document: pdfV1,
                        mimetype: 'application/pdf',
                        fileName: `${baseNameNoExt}_MagicColor.pdf`,
                        caption: `📄 *DOKUMEN PDF (VERSI 1 — MAGIC COLOR)*\n\n` +
                                 `📑 *Total Halaman:* ${totalPages}\n` +
                                 `🎨 *Mode:* CamScanner Magic Color\n` +
                                 `✨ *Fitur:* Kertas putih bersih bebas bayangan, stempel & tanda tangan warna tetap hidup.\n\n` +
                                 `_Pilih versi yang paling pas dengan lembar dokumen Anda._`
                    }, { quoted: msg });

                    // Brief pause before sending PDF 2
                    await new Promise(r => setTimeout(r, 1200));

                    // Send PDF 2 (Clear B&W)
                    await sock.sendMessage(remoteJid, {
                        document: pdfV2,
                        mimetype: 'application/pdf',
                        fileName: `${baseNameNoExt}_ClearBW.pdf`,
                        caption: `📄 *DOKUMEN PDF (VERSI 2 — CLEAR B&W)*\n\n` +
                                 `📑 *Total Halaman:* ${totalPages}\n` +
                                 `🎨 *Mode:* Dokumen Hitam-Putih Bersih (Clear B&W)\n` +
                                 `✨ *Fitur:* Teks hitam pekat tajam, latar belakang 100% bersih tanpa bintik (ideal untuk print/fotokopi).\n\n` +
                                 `_Pilih versi yang paling pas dengan lembar dokumen Anda._`
                    }, { quoted: msg });

                    pdfSessions.delete(sender);
                    return;
                } catch (err) {
                    logger?.error({ err }, '[PDF] Failed to generate PDF');
                    return sock.sendMessage(remoteJid, { text: `❌ *Gagal membuat file PDF:* ${err.message}` }, { quoted: msg });
                }
            });
        }

        // 3. CHECK FOR IMAGE MEDIA (Direct or Quoted)
        const imageBuffer = await extractImageBuffer(msg, logger);

        // Case A: Reply 1 image directly -> generate and send both versions immediately!
        if (imageBuffer && !pdfSessions.has(sender)) {
            const { heavyTaskQueue } = require('../utils/cache');
            return heavyTaskQueue.add(async () => {
                try {
                    await sock.sendMessage(remoteJid, { text: '⏳ Sedang mengolah dokumen & menyiapkan 2 versi PDF (Magic Color & Clear B&W)...' }, { quoted: msg });

                    const baseFileName = getCleanFileName(customTitle, 'Dokumen_Scan');
                    const baseNameNoExt = baseFileName.replace(/\.pdf$/i, '');

                    // Version 1: CamScanner Magic Color
                    const enhancedV1 = await callScanner(imageBuffer, 'color', logger);
                    const pdfV1 = await imagesToPdf([enhancedV1]);

                    // Version 2: CamScanner Clear B&W
                    const enhancedV2 = await callScanner(imageBuffer, 'bw', logger);
                    const pdfV2 = await imagesToPdf([enhancedV2]);

                    // Send PDF 1 (Magic Color)
                    await sock.sendMessage(remoteJid, {
                        document: pdfV1,
                        mimetype: 'application/pdf',
                        fileName: `${baseNameNoExt}_MagicColor.pdf`,
                        caption: `📄 *DOKUMEN PDF (VERSI 1 — MAGIC COLOR)*\n\n` +
                                 `📑 *Halaman:* 1 Halaman\n` +
                                 `🎨 *Mode:* CamScanner Magic Color\n` +
                                 `✨ *Fitur:* Kertas putih bersih bebas bayangan, stempel & tanda tangan warna tetap hidup.`
                    }, { quoted: msg });

                    await new Promise(r => setTimeout(r, 1200));

                    // Send PDF 2 (Clear B&W)
                    return sock.sendMessage(remoteJid, {
                        document: pdfV2,
                        mimetype: 'application/pdf',
                        fileName: `${baseNameNoExt}_ClearBW.pdf`,
                        caption: `📄 *DOKUMEN PDF (VERSI 2 — CLEAR B&W)*\n\n` +
                                 `📑 *Halaman:* 1 Halaman\n` +
                                 `🎨 *Mode:* Dokumen Hitam-Putih Bersih (Clear B&W)\n` +
                                 `✨ *Fitur:* Teks hitam pekat tajam, latar belakang 100% bersih tanpa bintik (ideal untuk print/fotokopi).\n\n` +
                                 `_Tips: Untuk banyak foto jadi 1 file PDF, ketik \`${PREFIX}topdf\` atau \`${PREFIX}scan\`, kirim foto berurutan, lalu ketik \`${PREFIX}pdfdone\`._`
                    }, { quoted: msg });

                } catch (err) {
                    return sock.sendMessage(remoteJid, { text: `❌ *Gagal membuat PDF:* ${err.message}` }, { quoted: msg });
                }
            });
        }

        // Case B: Session already active -> add raw image to session
        if (pdfSessions.has(sender)) {
            const session = pdfSessions.get(sender);
            session.lastActive = Date.now();

            if (imageBuffer) {
                session.rawBuffers.push(imageBuffer);
                return sock.sendMessage(remoteJid, {
                    text: `✅ *Halaman ${session.rawBuffers.length} Tersimpan!*\n\nKirim gambar berikutnya atau ketik *${PREFIX}pdfdone* untuk menyelesaikan dan download 2 versi PDF (Magic Color & Clear B&W).`
                }, { quoted: msg });
            } else {
                return sock.sendMessage(remoteJid, {
                    text: `📑 *Sesi PDF Sedang Aktif*\n\n` +
                          `• Halaman tersimpan: *${session.rawBuffers.length}*\n\n` +
                          `Silakan kirim gambar lagi, atau ketik:\n` +
                          `• \`${PREFIX}pdfdone\` : Selesai & Dapatkan 2 Versi PDF\n` +
                          `• \`${PREFIX}pdfcancel\` : Batalkan sesi`
                }, { quoted: msg });
            }
        }

        // Case C: Start new multi-page PDF session
        pdfSessions.set(sender, {
            title: customTitle || '',
            rawBuffers: imageBuffer ? [imageBuffer] : [],
            lastActive: Date.now(),
            createdAt: Date.now()
        });

        const initialCount = imageBuffer ? 1 : 0;
        return sock.sendMessage(remoteJid, {
            text: `📑 *SESI PEMBUATAN PDF DIMULAI!*\n\n` +
                  (customTitle ? `📝 *Judul Dokumen:* ${customTitle}\n` : '') +
                  (initialCount > 0 ? `• Halaman 1 tersimpan!\n` : '') +
                  `\nSilakan kirim foto/dokumen satu per satu secara berurutan.\nSaat selesai, bot akan mengirimkan 2 versi PDF:\n` +
                  `1. *Magic Color* (Warna asli dokumen diperjelas + kertas putih bersih bebas bayangan)\n` +
                  `2. *Clear B&W* (Hitam putih pekat kontras tinggi siap cetak/print)\n\n` +
                  `📌 *Perintah Kontrol:*\n` +
                  `• \`${PREFIX}pdfdone\` : Selesai & download 2 versi PDF\n` +
                  `• \`${PREFIX}pdfcancel\` : Batalkan sesi`
        }, { quoted: msg });
    }
};
