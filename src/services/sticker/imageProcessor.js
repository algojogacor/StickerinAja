const sharp = require('sharp');
const { imageQueue } = require('../../utils/cache');
const { addExifToWebp } = require('../../utils/exifHelper');

async function createFromMedia({ sock, msg, args, remoteJid, quotedMsg, quotedStanza, session, logger, downloadFn, parseArgsFn, MAX_FILE_SIZE }) {
    await sock.sendMessage(remoteJid, { text: '⏳ Membuat stiker...' }, { quoted: msg });

    await imageQueue.add(async () => {
        let buffer = await downloadFn(sock, msg, quotedMsg, quotedStanza);
        if (!buffer) return sock.sendMessage(remoteJid, { text: '📸 Balas/kirim foto dengan caption *!s*' }, { quoted: msg });
        if (buffer.length > MAX_FILE_SIZE) {
            return sock.sendMessage(remoteJid, { text: '⚠️ File terlalu besar! Maks 10MB' }, { quoted: msg });
        }

        try {
            const webpBuffer = await sharp(buffer)
                .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .webp({ quality: 80 })
                .toBuffer();
            buffer = null;

            const stickerWithMetadata = addExifToWebp(webpBuffer, session?.pack, session?.author);
            await sock.sendMessage(remoteJid, { sticker: stickerWithMetadata }, { quoted: msg });
            logger.info(`✅ Sticker with EXIF (pack: "${session?.pack}", author: "${session?.author}") sent to ${remoteJid}`);
        } catch (err) {
            logger.error({ err }, 'Sticker conversion error');
            await sock.sendMessage(remoteJid, { text: '❌ Gagal membuat stiker.' }, { quoted: msg });
        }
    });
}

module.exports = {
    createFromMedia
};
