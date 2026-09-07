const sharp = require('sharp');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

// In-memory active PDF creation sessions (keyed by user JID)
const pdfSessions = new Map();
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes TTL
const MAX_PAGES = 10; // OOM guard: max 10 pages per PDF on 512MB RAM

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

            // Safe generous margin (3.5% padding so headers/margins are never clipped)
            const padX = Math.round(width * 0.035);
            const padY = Math.round(height * 0.035);

            const cropLeft = Math.max(0, Math.round(startX * scaleX) - padX);
            const cropTop = Math.max(0, Math.round(startY * scaleY) - padY);
            const cropWidth = Math.min(width - cropLeft, Math.round((endX - startX) * scaleX) + padX * 2);
            const cropHeight = Math.min(height - cropTop, Math.round((endY - startY) * scaleY) + padY * 2);

            const cropArea = cropWidth * cropHeight;
            const totalArea = width * height;
            const areaRatio = cropArea / totalArea;

            // Only crop if document is clearly framed inside background (between 25% and 88% area)
            // If the document already fills > 88% of the camera shot, do not crop to preserve edges
            if (areaRatio > 0.25 && areaRatio < 0.88 && cropWidth > width * 0.4 && cropHeight > height * 0.4) {
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
 * Prepares image in its authentic, original state (100% untouched pixel colors/ink).
 * Only applies EXIF auto-rotation and safe dimension scaling for PDF compatibility.
 */
async function prepareOriginalImage(buffer) {
    try {
        return await sharp(buffer)
            .rotate() // Auto-orient based on camera EXIF
            .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 90 })
            .toBuffer();
    } catch {
        return buffer;
    }
}

/**
 * Gentle Document Enhancement (Filter Ringan)
 * Levels background shadows gently and enhances text contrast without bleaching.
 * Darkens pen/pencil ink strokes instead of cutting them off, so handwriting is 100% preserved.
 */
async function applyGentleScan(buffer) {
    try {
        const pipeline = sharp(buffer)
            .rotate()
            .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
            .removeAlpha();

        const meta = await pipeline.metadata();
        const width = meta.width || 800;
        const height = meta.height || 600;

        const rawOrig = await pipeline.raw().toBuffer();

        // Background illumination map via large blur (low-pass filter)
        const downW = Math.max(16, Math.round(width / 32));
        const downH = Math.max(16, Math.round(height / 32));

        const rawBg = await sharp(rawOrig, { raw: { width, height, channels: 3 } })
            .resize(downW, downH, { fit: 'fill' })
            .blur(14)
            .resize(width, height, { fit: 'fill' })
            .raw()
            .toBuffer();

        const totalPixels = width * height;
        const outBuf = Buffer.alloc(totalPixels * 3);

        for (let i = 0; i < totalPixels; i++) {
            const idx = i * 3;

            const origY = 0.299 * rawOrig[idx] + 0.587 * rawOrig[idx + 1] + 0.114 * rawOrig[idx + 2];
            const bgY = Math.max(0.299 * rawBg[idx] + 0.587 * rawBg[idx + 1] + 0.114 * rawBg[idx + 2], 25);

            // Normalized ratio (0.0 = dark ink, 1.0 = paper background)
            const ratio = Math.min(1.0, origY / bgY);

            // Gamma curve (1.45): darkens handwriting strokes (pencil/ballpoint) rather than bleaching them
            let enhancedLuma = Math.pow(ratio, 1.45) * 255;

            // Smoothly whiten paper background only when ratio is very close to paper (> 0.94)
            if (ratio > 0.94) {
                const paperFactor = (ratio - 0.94) / 0.06;
                enhancedLuma = enhancedLuma * (1 - paperFactor) + 255 * paperFactor;
            }

            // Luminance scaling factor preserves colored ink, stamps, and highlighters
            const factor = origY > 0 ? (enhancedLuma / origY) : 1;

            for (let c = 0; c < 3; c++) {
                const val = Math.round(rawOrig[idx + c] * factor);
                outBuf[idx + c] = Math.min(255, Math.max(0, val));
            }
        }

        return await sharp(outBuf, { raw: { width, height, channels: 3 } })
            .sharpen({ sigma: 0.6, m1: 0.3, m2: 1.2 }) // subtle acutance pop for crisp letters
            .jpeg({ quality: 90 })
            .toBuffer();
    } catch {
        return await prepareOriginalImage(buffer);
    }
}

/**
 * CamScanner-Grade Illumination Normalization
 * Backward-compatible alias that now delegates to non-destructive gentle scanning.
 */
async function applyMagicScan(buffer, mode = 'magic') {
    return await applyGentleScan(buffer);
}

const SCANNER_URL = process.env.SCANNER_URL || '';
const SCANNER_TIMEOUT_MS = parseInt(process.env.SCANNER_TIMEOUT_MS || '15000', 10);

/**
 * Dispatches document image to scanner processor
 * with graceful fallback to local non-destructive gentle processing.
 */
async function callScanner(buffer, mode = 'filter', logger) {
    if (mode === 'original' || mode === 'asli' || mode === 'raw') {
        return await prepareOriginalImage(buffer);
    }

    if (!SCANNER_URL) {
        return await applyGentleScan(await autoCropDocument(buffer));
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
        return await applyGentleScan(await autoCropDocument(buffer));
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
    applyGentleScan,
    prepareOriginalImage,
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
        if (session.rawBuffers.length >= MAX_PAGES) {
            await sock.sendMessage(remoteJid, {
                text: `⚠️ *Batas Maksimal Halaman Tercapai (${MAX_PAGES} Halaman)!*\n\n` +
                      `Silakan ketik \`${PREFIX}pdfdone\` untuk memproses PDF atau \`${PREFIX}pdfcancel\` untuk membatalkan.`
            }, { quoted: msg });
            return true;
        }

        const compressed = await sharp(imageBuffer)
            .rotate()
            .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 88 })
            .toBuffer();
        session.rawBuffers.push(compressed);
        session.lastActive = Date.now();

        const count = session.rawBuffers.length;
        await sock.sendMessage(remoteJid, {
            text: `✅ *Halaman ${count} Tersimpan!*\n\n` +
                  `• Total Halaman: *${count}*\n\n` +
                  `Silakan kirim foto berikutnya, atau ketik:\n` +
                  `• \`${PREFIX}pdfdone\` : Selesai & Dapatkan 2 Versi PDF (Original & Filter Ringan)\n` +
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

        // 2. FINISH & GENERATE DUAL PDF OUTPUT (Original & Filter Ringan)
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
                        text: `⏳ *Menggabungkan ${totalPages} halaman & menyiapkan 2 versi PDF (Original & Filter Ringan)...*`
                    }, { quoted: msg });

                    const finalTitle = customTitle || session.title || '';
                    const baseFileName = getCleanFileName(finalTitle, 'Dokumen_Scan');
                    const baseNameNoExt = baseFileName.replace(/\.pdf$/i, '');

                    // Process Version 1: Original / Tanpa Filter (Asli)
                    const v1Buffers = [];
                    for (const raw of session.rawBuffers) {
                        const original = await prepareOriginalImage(raw);
                        v1Buffers.push(original);
                    }
                    const pdfV1 = await imagesToPdf(v1Buffers);

                    // Process Version 2: Gentle Filter (Filter Ringan)
                    const v2Buffers = [];
                    for (const raw of session.rawBuffers) {
                        const enhanced = await applyGentleScan(await autoCropDocument(raw));
                        v2Buffers.push(enhanced);
                    }
                    const pdfV2 = await imagesToPdf(v2Buffers);

                    // Send PDF 1 (Original / Tanpa Filter)
                    await sock.sendMessage(remoteJid, {
                        document: pdfV1,
                        mimetype: 'application/pdf',
                        fileName: `${baseNameNoExt}_Original.pdf`,
                        caption: `📄 *DOKUMEN PDF (VERSI 1 — ORIGINAL / TANPA FILTER)*\n\n` +
                                 `📑 *Total Halaman:* ${totalPages}\n` +
                                 `📷 *Mode:* Foto Asli (Tanpa Filter)\n` +
                                 `✨ *Fitur:* 100% mempertahankan foto asli jepretan kamera, tulisan tangan/pensil dijamin utuh & jelas terbaca.\n\n` +
                                 `_Pilih versi yang paling pas dengan lembar dokumen Anda._`
                    }, { quoted: msg });

                    // Brief pause before sending PDF 2
                    await new Promise(r => setTimeout(r, 1200));

                    // Send PDF 2 (Filter Ringan)
                    await sock.sendMessage(remoteJid, {
                        document: pdfV2,
                        mimetype: 'application/pdf',
                        fileName: `${baseNameNoExt}_Filter.pdf`,
                        caption: `📄 *DOKUMEN PDF (VERSI 2 — FILTER RINGAN)*\n\n` +
                                 `📑 *Total Halaman:* ${totalPages}\n` +
                                 `🎨 *Mode:* Dokumen Bersih (Gentle Filter)\n` +
                                 `✨ *Fitur:* Bayangan diratakan & kontras tulisan dipertajam secara halus tanpa merusak/memudarkan tulisan tangan.\n\n` +
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
                    await sock.sendMessage(remoteJid, { text: '⏳ Sedang mengolah dokumen & menyiapkan 2 versi PDF (Original & Filter Ringan)...' }, { quoted: msg });

                    const baseFileName = getCleanFileName(customTitle, 'Dokumen_Scan');
                    const baseNameNoExt = baseFileName.replace(/\.pdf$/i, '');

                    // Version 1: Original / Tanpa Filter (Asli)
                    const originalBuf = await prepareOriginalImage(imageBuffer);
                    const pdfV1 = await imagesToPdf([originalBuf]);

                    // Version 2: Filter Ringan
                    const enhancedBuf = await applyGentleScan(await autoCropDocument(imageBuffer));
                    const pdfV2 = await imagesToPdf([enhancedBuf]);

                    // Send PDF 1 (Original / Tanpa Filter)
                    await sock.sendMessage(remoteJid, {
                        document: pdfV1,
                        mimetype: 'application/pdf',
                        fileName: `${baseNameNoExt}_Original.pdf`,
                        caption: `📄 *DOKUMEN PDF (VERSI 1 — ORIGINAL / TANPA FILTER)*\n\n` +
                                 `📑 *Halaman:* 1 Halaman\n` +
                                 `📷 *Mode:* Foto Asli (Tanpa Filter)\n` +
                                 `✨ *Fitur:* 100% mempertahankan foto asli jepretan kamera, tulisan tangan/pensil dijamin utuh & jelas terbaca.`
                    }, { quoted: msg });

                    await new Promise(r => setTimeout(r, 1200));

                    // Send PDF 2 (Filter Ringan)
                    return sock.sendMessage(remoteJid, {
                        document: pdfV2,
                        mimetype: 'application/pdf',
                        fileName: `${baseNameNoExt}_Filter.pdf`,
                        caption: `📄 *DOKUMEN PDF (VERSI 2 — FILTER RINGAN)*\n\n` +
                                 `📑 *Halaman:* 1 Halaman\n` +
                                 `🎨 *Mode:* Dokumen Bersih (Gentle Filter)\n` +
                                 `✨ *Fitur:* Bayangan diratakan & kontras tulisan dipertajam secara halus tanpa merusak/memudarkan tulisan tangan.\n\n` +
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
                if (session.rawBuffers.length >= MAX_PAGES) {
                    return sock.sendMessage(remoteJid, {
                        text: `⚠️ *Batas Maksimal Halaman Tercapai (${MAX_PAGES} Halaman)!*\n\n` +
                              `Silakan ketik \`${PREFIX}pdfdone\` untuk memproses PDF atau \`${PREFIX}pdfcancel\` untuk membatalkan.`
                    }, { quoted: msg });
                }
                const compressed = await sharp(imageBuffer)
                    .rotate()
                    .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 88 })
                    .toBuffer();
                session.rawBuffers.push(compressed);
                return sock.sendMessage(remoteJid, {
                    text: `✅ *Halaman ${session.rawBuffers.length} Tersimpan!*\n\nKirim gambar berikutnya atau ketik *${PREFIX}pdfdone* untuk menyelesaikan dan download 2 versi PDF (Original & Filter Ringan).`
                }, { quoted: msg });
            } else {
                return sock.sendMessage(remoteJid, {
                    text: `📑 *Sesi PDF Sedang Aktif*\n\n` +
                          `• Halaman tersimpan: *${session.rawBuffers.length}*\n\n` +
                          `Silakan kirim gambar lagi, atau ketik:\n` +
                          `• \`${PREFIX}pdfdone\` : Selesai & Dapatkan 2 Versi PDF (Original & Filter Ringan)\n` +
                          `• \`${PREFIX}pdfcancel\` : Batalkan sesi`
                }, { quoted: msg });
            }
        }

        // Case C: Start new multi-page PDF session
        let initialBuffer = null;
        if (imageBuffer) {
            initialBuffer = await sharp(imageBuffer)
                .rotate()
                .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 88 })
                .toBuffer();
        }

        pdfSessions.set(sender, {
            title: customTitle || '',
            rawBuffers: initialBuffer ? [initialBuffer] : [],
            lastActive: Date.now(),
            createdAt: Date.now()
        });

        const initialCount = imageBuffer ? 1 : 0;
        return sock.sendMessage(remoteJid, {
            text: `📑 *SESI PEMBUATAN PDF DIMULAI!*\n\n` +
                  (customTitle ? `📝 *Judul Dokumen:* ${customTitle}\n` : '') +
                  (initialCount > 0 ? `• Halaman 1 tersimpan!\n` : '') +
                  `\nSilakan kirim foto/dokumen satu per satu secara berurutan.\nSaat selesai, bot akan mengirimkan 2 versi PDF:\n` +
                  `1. *Original (Tanpa Filter)* (100% foto asli jepretan kamera, tulisan tangan/pensil terjamin utuh)\n` +
                  `2. *Filter Ringan* (Bayangan diratakan & kontras tulisan dipertajam tanpa memudarkan tulisan)\n\n` +
                  `📌 *Perintah Kontrol:*\n` +
                  `• \`${PREFIX}pdfdone\` : Selesai & download 2 versi PDF\n` +
                  `• \`${PREFIX}pdfcancel\` : Batalkan sesi`
        }, { quoted: msg });
    }
};
