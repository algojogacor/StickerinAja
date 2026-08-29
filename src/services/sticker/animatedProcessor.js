const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);
const fs = require('fs');
const path = require('path');
const { ffmpegQueue } = require('../../utils/cache');

const TEMP_DIR = path.join(__dirname, '../../../temp');

async function createAnimated({
    sock, msg, args, remoteJid, quotedMsg, quotedStanza, session, logger,
    downloadFn, parseArgsFn, MAX_FILE_SIZE
}) {
    let buffer = await downloadFn(sock, msg, quotedMsg, quotedStanza);
    if (!buffer) return sock.sendMessage(remoteJid, { text: '🎬 Balas video dengan *!sgif*' }, { quoted: msg });
    if (buffer.length > MAX_FILE_SIZE) {
        return sock.sendMessage(remoteJid, { text: '⚠️ Video terlalu besar! Maks 10MB' }, { quoted: msg });
    }

    const time = Date.now();
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

    const tempInput = path.join(TEMP_DIR, `vid_in_${time}.mp4`);
    const tempOutput = path.join(TEMP_DIR, `vid_out_${time}.webp`);

    await fs.promises.writeFile(tempInput, buffer);
    buffer = null;

    await sock.sendMessage(remoteJid, { text: '⏳ Membuat stiker animasi...' }, { quoted: msg });

    await ffmpegQueue.add(async () => {
        try {
            await new Promise((resolve, reject) => {
                ffmpeg(tempInput)
                    .inputFormat('mp4')
                    .outputOptions([
                        '-vcodec libwebp',
                        '-vf scale=512:512:force_original_aspect_ratio=decrease,fps=15,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0,split[a][b];[a]palettegen=reserve_transparent=on:transparency_color=ffffff[p];[b][p]paletteuse',
                        '-loop 0',
                        '-ss 00:00:00',
                        '-t 00:00:05',
                        '-preset default',
                        '-an',
                        '-vsync 0',
                        '-q:v 50'
                    ])
                    .toFormat('webp')
                    .on('end', resolve)
                    .on('error', reject)
                    .save(tempOutput);
            });

            const stickerBuffer = await fs.promises.readFile(tempOutput);
            await sock.sendMessage(remoteJid, { sticker: stickerBuffer }, { quoted: msg });
            logger.info(`✅ Animated sticker sent to ${remoteJid}`);
        } catch (err) {
            logger.error({ err }, 'Animated sticker conversion error');
            await sock.sendMessage(remoteJid, { text: '❌ Gagal. Video mungkin corrupt atau FFmpeg error.' }, { quoted: msg });
        } finally {
            try { fs.unlinkSync(tempInput); } catch {}
            try { fs.unlinkSync(tempOutput); } catch {}
        }
    });
}

module.exports = {
    createAnimated
};
