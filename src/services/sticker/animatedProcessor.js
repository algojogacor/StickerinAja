const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);
const fs = require('fs');
const path = require('path');
const { ffmpegQueue } = require('../../utils/cache');
const { addExifToWebp } = require('../../utils/exifHelper');

const TEMP_DIR = path.join(__dirname, '../../../temp');
const MAX_STICKER_BYTES = 950 * 1024; // 950KB safe limit for WhatsApp

function runFfmpegEncode(inputPath, outputPath, { duration = 8, fps = 15, quality = 50 } = {}) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .inputFormat('mp4')
            .outputOptions([
                '-vcodec libwebp',
                `-vf scale=512:512:force_original_aspect_ratio=decrease,fps=${fps},pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0,split[a][b];[a]palettegen=reserve_transparent=on:transparency_color=ffffff[p];[b][p]paletteuse`,
                '-loop 0',
                '-ss 00:00:00',
                `-t 00:00:0${duration}`,
                '-preset default',
                '-an',
                '-vsync 0',
                `-q:v ${quality}`
            ])
            .toFormat('webp')
            .on('end', resolve)
            .on('error', reject)
            .save(outputPath);
    });
}

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
            // Attempt 1: Adaptive up to 8s, 15fps, quality 50
            await runFfmpegEncode(tempInput, tempOutput, { duration: 8, fps: 15, quality: 50 });
            let stat = await fs.promises.stat(tempOutput);

            // Attempt 2: If > 950KB (over WA limit), re-encode with 6s, 12fps, quality 40
            if (stat.size > MAX_STICKER_BYTES) {
                logger.info({ size: stat.size }, 'Animated sticker exceeded 950KB, optimizing...');
                try { fs.unlinkSync(tempOutput); } catch {}
                await runFfmpegEncode(tempInput, tempOutput, { duration: 6, fps: 12, quality: 40 });
                stat = await fs.promises.stat(tempOutput);
            }

            const rawStickerBuffer = await fs.promises.readFile(tempOutput);
            const stickerWithMetadata = addExifToWebp(rawStickerBuffer, session?.pack, session?.author);
            await sock.sendMessage(remoteJid, { sticker: stickerWithMetadata }, { quoted: msg });
            logger.info({ size: stat.size }, `✅ Animated sticker with EXIF (pack: "${session?.pack}", author: "${session?.author}") sent to ${remoteJid}`);
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
    runFfmpegEncode,
    createAnimated
};
