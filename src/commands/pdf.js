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

        const thumbWidth = 200;
        const thumbHeight = Math.round((height / width) * 200);

        const thumb = await sharp(buffer)
            .resize(thumbWidth, thumbHeight)
            .grayscale()
            .raw()
            .toBuffer();

        let total = 0;
        for (let i = 0; i < thumb.length; i++) total += thumb[i];
        const avg = total / thumb.length;
        const threshold = Math.max(avg * 0.9, 100);

        let minX = thumbWidth, maxX = 0, minY = thumbHeight, maxY = 0;
        let count = 0;

        for (let y = 0; y < thumbHeight; y++) {
            for (let x = 0; x < thumbWidth; x++) {
                const val = thumb[y * thumbWidth + x];
                if (val >= threshold) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                    count++;
                }
            }
        }

        const areaRatio = count / (thumbWidth * thumbHeight);
        if (areaRatio > 0.3 && areaRatio < 0.98 && maxX > minX && maxY > minY) {
            const scaleX = width / thumbWidth;
            const scaleY = height / thumbHeight;

            const padX = Math.round(width * 0.02);
            const padY = Math.round(height * 0.02);

            const cropLeft = Math.max(0, Math.round(minX * scaleX) - padX);
            const cropTop = Math.max(0, Math.round(minY * scaleY) - padY);
            const cropWidth = Math.min(width - cropLeft, Math.round((maxX - minX) * scaleX) + padX * 2);
            const cropHeight = Math.min(height - cropTop, Math.round((maxY - minY) * scaleY) + padY * 2);

            if (cropWidth > width * 0.4 && cropHeight > height * 0.4) {
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
 * Apply CamScanner Magic Color & Paper Whitening
 */
async function applyMagicScan(buffer, mode = 'scan') {
    if (mode === 'scan') {
        return sharp(buffer)
            .grayscale()
            .normalise()
            .linear(1.45, -45)
            .sharpen({ sigma: 1.2, m1: 1.0, m2: 2.0 })
            .jpeg({ quality: 90 })
            .toBuffer();
    } else {
        return sharp(buffer)
            .normalise()
            .linear(1.25, -25)
            .sharpen({ sigma: 1.0, m1: 0.8, m2: 1.5 })
            .jpeg({ quality: 90 })
            .toBuffer();
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
                  `• Mode: *${session.mode === 'scan' ? 'Scan Dokumen (B&W)' : 'Warna Asli'}*\n` +
                  `• Total Halaman: *${count}*\n\n` +
                  `Silakan kirim foto berikutnya, atau ketik:\n` +
                  `• \`${PREFIX}pdfdone\` : Selesai & Download 2 Versi PDF\n` +
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

        // 2. FINISH & GENERATE DUAL PDF OUTPUT (AutoCrop + FullFrame)
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
                        text: `⏳ *Menggabungkan ${totalPages} halaman & menyiapkan 2 versi PDF dokumen...*`
                    }, { quoted: msg });

                    const mode = session.mode;
                    const prefix = mode === 'scan' ? 'Dokumen_Scan' : 'Dokumen';
                    const finalTitle = customTitle || session.title || '';
                    const fileName = getCleanFileName(finalTitle, prefix);

                    // Process Version 1: Auto-Crop + MagicScan
                    const v1Buffers = [];
                    for (const raw of session.rawBuffers) {
                        const cropped = await autoCropDocument(raw);
                        const enhanced = await applyMagicScan(cropped, mode);
                        v1Buffers.push(enhanced);
                    }
                    const pdfV1 = await imagesToPdf(v1Buffers);

                    // Process Version 2: Full-Frame + MagicScan
                    const v2Buffers = [];
                    for (const raw of session.rawBuffers) {
                        const enhanced = await applyMagicScan(raw, mode);
                        v2Buffers.push(enhanced);
                    }
                    const pdfV2 = await imagesToPdf(v2Buffers);

                    // Send PDF 1
                    await sock.sendMessage(remoteJid, {
                        document: pdfV1,
                        mimetype: 'application/pdf',
                        fileName,
                        caption: `📄 *DOKUMEN PDF (VERSI 1)*\n\n` +
                                 `📑 *Total Halaman:* ${totalPages}\n` +
                                 `🎨 *Mode:* ${mode === 'scan' ? 'Dokumen Scan (B&W High Contrast)' : 'Warna Asli'}\n` +
                                 `✨ *Format:* Auto-Crop & Pembersih Dokumen\n\n` +
                                 `_Pilih versi yang paling pas dengan lembar dokumen Anda._`
                    }, { quoted: msg });

                    // Brief pause before sending PDF 2
                    await new Promise(r => setTimeout(r, 1200));

                    // Send PDF 2
                    await sock.sendMessage(remoteJid, {
                        document: pdfV2,
                        mimetype: 'application/pdf',
                        fileName,
                        caption: `📄 *DOKUMEN PDF (VERSI 2)*\n\n` +
                                 `📑 *Total Halaman:* ${totalPages}\n` +
                                 `🎨 *Mode:* ${mode === 'scan' ? 'Dokumen Scan (B&W High Contrast)' : 'Warna Asli'}\n` +
                                 `✨ *Format:* Full-Frame & Pembersih Dokumen\n\n` +
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
        const isScanMode = (command === 'scan');
        const mode = isScanMode ? 'scan' : 'color';

        // Case A: Reply 1 image directly -> generate and send both versions immediately!
        if (imageBuffer && !pdfSessions.has(sender)) {
            const { heavyTaskQueue } = require('../utils/cache');
            return heavyTaskQueue.add(async () => {
                try {
                    await sock.sendMessage(remoteJid, { text: '⏳ Sedang mengolah dokumen & menyiapkan 2 versi PDF...' }, { quoted: msg });

                    const prefix = isScanMode ? 'Dokumen_Scan' : 'Dokumen';
                    const fileName = getCleanFileName(customTitle, prefix);

                    // Version 1: Auto-Crop + MagicScan
                    const cropped = await autoCropDocument(imageBuffer);
                    const enhancedV1 = await applyMagicScan(cropped, mode);
                    const pdfV1 = await imagesToPdf([enhancedV1]);

                    // Version 2: Full-Frame + MagicScan
                    const enhancedV2 = await applyMagicScan(imageBuffer, mode);
                    const pdfV2 = await imagesToPdf([enhancedV2]);

                    // Send PDF 1
                    await sock.sendMessage(remoteJid, {
                        document: pdfV1,
                        mimetype: 'application/pdf',
                        fileName,
                        caption: `📄 *DOKUMEN PDF (VERSI 1)*\n\n` +
                                 `📑 *Halaman:* 1 Halaman\n` +
                                 `🎨 *Mode:* ${isScanMode ? 'Dokumen Scan (B&W High Contrast)' : 'Warna Asli'}\n` +
                                 `✨ *Format:* Auto-Crop & Pembersih Dokumen`
                    }, { quoted: msg });

                    await new Promise(r => setTimeout(r, 1200));

                    // Send PDF 2
                    return sock.sendMessage(remoteJid, {
                        document: pdfV2,
                        mimetype: 'application/pdf',
                        fileName,
                        caption: `📄 *DOKUMEN PDF (VERSI 2)*\n\n` +
                                 `📑 *Halaman:* 1 Halaman\n` +
                                 `🎨 *Mode:* ${isScanMode ? 'Dokumen Scan (B&W High Contrast)' : 'Warna Asli'}\n` +
                                 `✨ *Format:* Full-Frame & Pembersih Dokumen\n\n` +
                                 `_Tips: Untuk banyak foto jadi 1 PDF, ketik \`${PREFIX}topdf\` atau \`${PREFIX}scan\`, kirim foto berurutan, lalu ketik \`${PREFIX}pdfdone\`._`
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
                    text: `✅ *Halaman ${session.rawBuffers.length} Tersimpan!*\n\nKirim gambar berikutnya atau ketik *${PREFIX}pdfdone* untuk menyelesaikan dan download 2 versi PDF.`
                }, { quoted: msg });
            } else {
                return sock.sendMessage(remoteJid, {
                    text: `📑 *Sesi PDF Sedang Aktif*\n\n` +
                          `• Halaman tersimpan: *${session.rawBuffers.length}*\n` +
                          `• Mode: *${session.mode === 'scan' ? 'Scan Dokumen (B&W)' : 'Warna Asli'}*\n\n` +
                          `Silakan kirim gambar lagi, atau ketik:\n` +
                          `• \`${PREFIX}pdfdone\` : Selesai & Download 2 Versi PDF\n` +
                          `• \`${PREFIX}pdfcancel\` : Batalkan sesi`
                }, { quoted: msg });
            }
        }

        // Case C: Start new multi-page PDF session
        pdfSessions.set(sender, {
            mode,
            title: customTitle || '',
            rawBuffers: imageBuffer ? [imageBuffer] : [],
            lastActive: Date.now(),
            createdAt: Date.now()
        });

        const initialCount = imageBuffer ? 1 : 0;
        return sock.sendMessage(remoteJid, {
            text: `📑 *SESI PEMBUATAN PDF DIMULAI!*\n\n` +
                  `🎨 *Mode:* ${isScanMode ? 'Dokumen Scan (B&W High Contrast)' : 'Warna Asli'}\n` +
                  (customTitle ? `📝 *Judul Dokumen:* ${customTitle}\n` : '') +
                  (initialCount > 0 ? `• Halaman 1 tersimpan!\n` : '') +
                  `\nSilakan kirim foto/dokumen satu per satu secara berurutan.\nSaat selesai, bot akan mengirimkan 2 versi PDF (Auto-Crop & Full-Frame) dengan nama bersih yang siap dikumpulkan.\n\n` +
                  `📌 *Perintah Kontrol:*\n` +
                  `• \`${PREFIX}pdfdone\` : Selesai & download PDF\n` +
                  `• \`${PREFIX}pdfcancel\` : Batalkan sesi`
        }, { quoted: msg });
    }
};
