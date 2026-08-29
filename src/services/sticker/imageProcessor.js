const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);
const fs = require('fs');
const path = require('path');
const { imageQueue } = require('../../utils/cache');
const { addExifToWebp } = require('../../utils/exifHelper');

const TEMP_DIR = path.join(__dirname, '../../../temp');

async function createFromMedia({ sock, msg, args, remoteJid, quotedMsg, quotedStanza, session, logger, downloadFn, parseArgsFn, MAX_FILE_SIZE }) {
    let buffer = await downloadFn(sock, msg, quotedMsg, quotedStanza);
    if (!buffer) return sock.sendMessage(remoteJid, { text: '📸 Balas/kirim foto dengan caption *!s*' }, { quoted: msg });
    if (buffer.length > MAX_FILE_SIZE) {
        return sock.sendMessage(remoteJid, { text: '⚠️ File terlalu besar! Maks 10MB' }, { quoted: msg });
    }

    const time = Date.now();
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

    const tempInput = path.join(TEMP_DIR, `img_in_${time}.jpg`);
    const tempOutput = path.join(TEMP_DIR, `img_out_${time}.webp`);

    await fs.promises.writeFile(tempInput, buffer);
    buffer = null;

    await sock.sendMessage(remoteJid, { text: '⏳ Membuat stiker...' }, { quoted: msg });

    await imageQueue.add(async () => {
        try {
            await new Promise((resolve, reject) => {
                ffmpeg(tempInput)
                    .outputOptions([
                        '-vcodec libwebp',
                        '-vf scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0,split[a][b];[a]palettegen=reserve_transparent=on:transparency_color=ffffff[p];[b][p]paletteuse'
                    ])
                    .toFormat('webp')
                    .on('end', resolve)
                    .on('error', reject)
                    .save(tempOutput);
            });

            const rawStickerBuffer = await fs.promises.readFile(tempOutput);
            const stickerWithMetadata = addExifToWebp(rawStickerBuffer, session?.pack, session?.author);
            await sock.sendMessage(remoteJid, { sticker: stickerWithMetadata }, { quoted: msg });
            logger.info(`✅ Sticker with EXIF (pack: "${session?.pack}", author: "${session?.author}") sent to ${remoteJid}`);
        } catch (err) {
            logger.error({ err }, 'Sticker conversion error');
            await sock.sendMessage(remoteJid, { text: '❌ Gagal membuat stiker.' }, { quoted: msg });
        } finally {
            try { fs.unlinkSync(tempInput); } catch {}
            try { fs.unlinkSync(tempOutput); } catch {}
        }
    });
}

module.exports = {
    createFromMedia
};
