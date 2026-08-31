const sharp = require('sharp');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

// In-memory active PDF creation sessions (keyed by user JID)
const pdfSessions = new Map();

/**
 * Creates a valid multi-page PDF-1.4 buffer directly from JPEG image buffers.
 * Zero external dependencies, ultra-fast and lightweight.
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
    const imageObjNums = [];

    for (let i = 0; i < pages.length; i++) {
        pageObjNums.push(currentObj++);
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

    // Catalog
    addObj(`<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>`);

    // Pages tree
    addObj(`<< /Type /Pages /Kids [${pageObjNums.map(n => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`);

    // Pages and Images
    for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const pageNum = pageObjNums[i];
        const imgNum = imageObjNums[i];

        const contentStream = `q ${page.width} 0 0 ${page.height} 0 0 cm /Im0 Do Q`;
        const contentLen = Buffer.byteLength(contentStream, 'latin1');

        addObj(`<< /Type /Page /Parent ${pagesObjNum} 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /XObject << /Im0 ${imgNum} 0 R >> >> /Contents [<< /Length ${contentLen} >>\nstream\n${contentStream}\nendstream] >>`);
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

/**
 * Apply CamScanner-style enhancement to document image buffer (B&W high contrast).
 */
async function applyScanFilter(buffer) {
    return sharp(buffer)
        .grayscale()
        .linear(1.4, -20)
        .sharpen()
        .jpeg({ quality: 90 })
        .toBuffer();
}

function getSender(msg, sock) {
    if (msg?.key?.fromMe) {
        return sock?.user?.id?.replace(/:.*@/, '@') || msg?.key?.remoteJid;
    }
    return msg?.key?.participant || msg?.key?.remoteJid;
}

module.exports = {
    names: ['pdf', 'topdf', 'scan', 'pdfdone', 'donepdf', 'pdfcancel'],
    imagesToPdf,
    applyScanFilter,
    execute: async (sock, msg, args, ctx) => {
        const remoteJid = msg.key?.remoteJid;
        const sender = getSender(msg, sock);
        const command = (args._command || 'pdf').toLowerCase();

        // 1. CANCEL SESSION
        if (command === 'pdfcancel') {
            if (pdfSessions.has(sender)) {
                pdfSessions.delete(sender);
                return sock.sendMessage(remoteJid, { text: '🗑️ *Sesi pembuatan PDF telah dibatalkan.*' }, { quoted: msg });
            }
            return sock.sendMessage(remoteJid, { text: 'ℹ️ Tidak ada sesi PDF aktif.' }, { quoted: msg });
        }

        // 2. FINISH & GENERATE PDF
        if (command === 'pdfdone' || command === 'donepdf') {
            const session = pdfSessions.get(sender);
            if (!session || session.buffers.length === 0) {
                return sock.sendMessage(remoteJid, {
                    text: '❌ *Belum ada gambar dalam sesi!*' +
                          '\nKirim/reply gambar terlebih dahulu dengan `!topdf` atau `!scan`.'
                }, { quoted: msg });
            }

            try {
                await sock.sendMessage(remoteJid, {
                    text: `⏳ *Menggabungkan ${session.buffers.length} halaman menjadi PDF...*`
                }, { quoted: msg });

                const pdfBuffer = await imagesToPdf(session.buffers);
                const modeName = session.mode === 'scan' ? 'Dokumen_Scan' : 'Dokumen';
                const fileName = `${modeName}_${Date.now()}.pdf`;

                await sock.sendMessage(remoteJid, {
                    document: pdfBuffer,
                    mimetype: 'application/pdf',
                    fileName,
                    caption: `📄 *DOKUMEN PDF BERHASIL DIBUAT*\n\n` +
                             `📑 *Total Halaman:* ${session.buffers.length}\n` +
                             `🎨 *Mode:* ${session.mode === 'scan' ? 'Dokumen Scan (B&W High Contrast)' : 'Warna Asli'}\n` +
                             `📦 *Ukuran File:* ${(pdfBuffer.length / 1024).toFixed(1)} KB\n\n` +
                             `_Powered by StickerinAja_`
                }, { quoted: msg });

                pdfSessions.delete(sender);
                return;
            } catch (err) {
                ctx?.logger?.error({ err }, '[PDF] Failed to generate PDF');
                return sock.sendMessage(remoteJid, { text: `❌ *Gagal membuat file PDF:* ${err.message}` }, { quoted: msg });
            }
        }

        // 3. CHECK FOR IMAGE MEDIA (Direct or Quoted)
        let imageBuffer = null;
        try {
            const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quotedMsg?.imageMessage || quotedMsg?.documentMessage?.mimetype?.startsWith('image/')) {
                imageBuffer = await downloadMediaMessage({
                    key: { remoteJid, id: msg.message.extendedTextMessage.contextInfo.stanzaId },
                    message: quotedMsg
                }, 'buffer', {}, { logger: ctx?.logger || console });
            } else if (msg.message?.imageMessage) {
                imageBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: ctx?.logger || console });
            }
        } catch (e) {
            ctx?.logger?.warn({ err: e }, '[PDF] Media download error');
        }

        const isScanMode = (command === 'scan');

        // Case A: Reply 1 image directly -> convert to PDF immediately!
        if (imageBuffer && !pdfSessions.has(sender)) {
            try {
                let processedBuffer = imageBuffer;
                if (isScanMode) {
                    processedBuffer = await applyScanFilter(imageBuffer);
                }

                await sock.sendMessage(remoteJid, { text: '⏳ Sedang mengonversi gambar menjadi PDF...' }, { quoted: msg });
                const pdfBuffer = await imagesToPdf([processedBuffer]);
                const fileName = `${isScanMode ? 'Scan' : 'Dokumen'}_${Date.now()}.pdf`;

                return sock.sendMessage(remoteJid, {
                    document: pdfBuffer,
                    mimetype: 'application/pdf',
                    fileName,
                    caption: `📄 *DOKUMEN PDF SIAP!*\n\n` +
                             `📑 *Halaman:* 1 Halaman\n` +
                             `🎨 *Mode:* ${isScanMode ? 'Dokumen Scan (B&W)' : 'Warna Asli'}\n\n` +
                             `_Tips: Untuk menggabungkan banyak foto sekaligus jadi 1 PDF, ketik \`!topdf\` lalu kirim gambar berturut-turut, kemudian ketik \`!pdfdone\`._`
                }, { quoted: msg });
            } catch (err) {
                return sock.sendMessage(remoteJid, { text: `❌ *Gagal membuat PDF:* ${err.message}` }, { quoted: msg });
            }
        }

        // Case B: Session already active -> add this image to session
        if (pdfSessions.has(sender)) {
            const session = pdfSessions.get(sender);
            if (imageBuffer) {
                let finalBuf = imageBuffer;
                if (session.mode === 'scan') {
                    finalBuf = await applyScanFilter(imageBuffer);
                }
                session.buffers.push(finalBuf);
                return sock.sendMessage(remoteJid, {
                    text: `✅ *Halaman ${session.buffers.length} Tersimpan!*\n\nKirim gambar berikutnya atau ketik *!pdfdone* untuk menyelesaikan dan download PDF.`
                }, { quoted: msg });
            } else {
                return sock.sendMessage(remoteJid, {
                    text: `📑 *Sesi PDF Sedang Aktif*\n\n` +
                          `• Halaman tersimpan: *${session.buffers.length}*\n` +
                          `• Mode: *${session.mode === 'scan' ? 'Scan Dokumen (B&W)' : 'Warna Asli'}*\n\n` +
                          `Silakan kirim gambar lagi, atau ketik:\n` +
                          `• \`!pdfdone\` : Selesai & Buat File PDF\n` +
                          `• \`!pdfcancel\` : Batalkan sesi`
                }, { quoted: msg });
            }
        }

        // Case C: Start new multi-page PDF session
        pdfSessions.set(sender, {
            mode: isScanMode ? 'scan' : 'color',
            buffers: [],
            createdAt: Date.now()
        });

        return sock.sendMessage(remoteJid, {
            text: `📑 *SESI PEMBUATAN PDF DIMULAI!*\n\n` +
                  `🎨 *Mode:* ${isScanMode ? 'Dokumen Scan (B&W High Contrast)' : 'Warna Asli'}\n\n` +
                  `Silakan kirim foto/dokumen satu per satu (bisa banyak halaman).\n\n` +
                  `📌 *Perintah Kontrol:*\n` +
                  `• \`!pdfdone\` : Selesai & download dokumen PDF\n` +
                  `• \`!pdfcancel\` : Batalkan sesi`
        }, { quoted: msg });
    }
};
