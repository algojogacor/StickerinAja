const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

const { ffmpegQueue } = require('../../utils/cache');

function getMediaKind(message) {
    if (message?.stickerMessage) return 'sticker';
    if (message?.imageMessage) return 'image';
    if (message?.videoMessage) return message.videoMessage.gifPlayback ? 'gif/video' : 'video';
    return 'unknown';
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function ffprobeFile(filePath) {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(filePath, (err, data) => resolve(err ? null : data));
    });
}

async function stickerInfo({ sock, msg, remoteJid, quotedMsg, quotedStanza, logger, downloadFn, TEMP_DIR }) {
    const target = quotedMsg || msg.message;
    const kind = getMediaKind(target);
    if (kind === 'unknown') {
        return sock.sendMessage(remoteJid, { text: 'Reply gambar/video/GIF/stiker lalu ketik *!sinfo*.' }, { quoted: msg });
    }

    let buffer = await downloadFn(sock, msg, quotedMsg, quotedStanza);
    if (!buffer) return sock.sendMessage(remoteJid, { text: '❌ Gagal download media.' }, { quoted: msg });

    const lines = [
        '*Info Media/Stiker*',
        `Jenis: ${kind}`,
        `Ukuran file: ${formatBytes(buffer.length)}`
    ];

    try {
        const metadata = await sharp(buffer, { animated: true }).metadata();
        if (metadata.format) lines.push(`Format: ${metadata.format}`);
        if (metadata.width && metadata.height) lines.push(`Dimensi: ${metadata.width}x${metadata.height}`);
        if (metadata.pages) lines.push(`Frame/pages: ${metadata.pages}`);
    } catch {}

    if (kind.includes('video') || kind === 'sticker') {
        const time = Date.now();
        const tempInput = path.join(TEMP_DIR, `info_${time}.bin`);
        await fs.promises.writeFile(tempInput, buffer);
        buffer = null;
        try {
            const probe = await ffprobeFile(tempInput);
            const stream = probe?.streams?.find(s => s.codec_type === 'video');
            if (stream?.codec_name) lines.push(`Codec: ${stream.codec_name}`);
            if (stream?.duration) lines.push(`Durasi: ${Number(stream.duration).toFixed(2)}s`);
            if (stream?.avg_frame_rate && stream.avg_frame_rate !== '0/0') lines.push(`FPS: ${stream.avg_frame_rate}`);
        } finally {
            try { fs.unlinkSync(tempInput); } catch {}
        }
    }

    if (target?.stickerMessage?.isAnimated) lines.push('Animated: ya');
    await sock.sendMessage(remoteJid, { text: lines.join('\n') }, { quoted: msg });
    logger.info(`✅ Sticker info sent to ${remoteJid}`);
}

async function toImage({ sock, msg, remoteJid, quotedMsg, quotedStanza, logger, downloadFn, TEMP_DIR }) {
    if (!quotedMsg?.stickerMessage) {
        return sock.sendMessage(remoteJid, { text: '⚠️ Balas stiker dengan *!toimg*' }, { quoted: msg });
    }

    await sock.sendMessage(remoteJid, { text: '⏳ Mengubah stiker ke gambar...' }, { quoted: msg });

    let buffer = await downloadFn(sock, msg, quotedMsg, quotedStanza);
    if (!buffer) return sock.sendMessage(remoteJid, { text: '❌ Gagal download stiker' }, { quoted: msg });

    const time = Date.now();
    const tempInput = path.join(TEMP_DIR, `stk_${time}.webp`);
    const tempOutput = path.join(TEMP_DIR, `img_${time}.png`);
    await fs.promises.writeFile(tempInput, buffer);
    buffer = null;

    try {
        await new Promise((resolve, reject) => {
            ffmpeg(tempInput)
                .outputOptions(['-vframes 1', '-vcodec png'])
                .on('end', resolve).on('error', reject)
                .save(tempOutput);
        });
        const imgBuffer = await fs.promises.readFile(tempOutput);
        await sock.sendMessage(remoteJid, { image: imgBuffer, caption: '🖼️ Hasil konversi' }, { quoted: msg });
    } catch (err) {
        logger.error({ err }, 'ToImg error');
        await sock.sendMessage(remoteJid, { text: '❌ Gagal. Stiker animasi tidak didukung.' }, { quoted: msg });
    } finally {
        try { fs.unlinkSync(tempInput); } catch {}
        try { fs.unlinkSync(tempOutput); } catch {}
    }
}

async function toGif({ sock, msg, remoteJid, quotedMsg, quotedStanza, logger, downloadFn, TEMP_DIR }) {
    if (!quotedMsg?.stickerMessage) {
        return sock.sendMessage(remoteJid, { text: '⚠️ Balas stiker animasi dengan *!togif*' }, { quoted: msg });
    }

    await sock.sendMessage(remoteJid, { text: '⏳ Mengubah stiker animasi ke GIF...' }, { quoted: msg });

    let buffer = await downloadFn(sock, msg, quotedMsg, quotedStanza);
    if (!buffer) return sock.sendMessage(remoteJid, { text: '❌ Gagal download stiker' }, { quoted: msg });

    await ffmpegQueue.add(async () => {
        const time = Date.now();
        const tempInput = path.join(TEMP_DIR, `stk_${time}.webp`);
        const tempOutput = path.join(TEMP_DIR, `gif_${time}.gif`);
        await fs.promises.writeFile(tempInput, buffer);
        buffer = null;

        try {
            await new Promise((resolve, reject) => {
                ffmpeg(tempInput)
                    .outputOptions([
                        '-vf fps=15,scale=512:512:force_original_aspect_ratio=decrease',
                        '-loop 0'
                    ])
                    .on('end', resolve)
                    .on('error', reject)
                    .save(tempOutput);
            });
            const gifBuffer = await fs.promises.readFile(tempOutput);
            await sock.sendMessage(remoteJid, {
                document: gifBuffer,
                mimetype: 'image/gif',
                fileName: 'sticker.gif'
            }, { quoted: msg });
            logger.info(`✅ Animated sticker converted to GIF for ${remoteJid}`);
        } catch (err) {
            logger.error({ err }, 'ToGif error');
            await sock.sendMessage(remoteJid, { text: '❌ Gagal mengubah stiker animasi ke GIF.' }, { quoted: msg });
        } finally {
            try { fs.unlinkSync(tempInput); } catch {}
            try { fs.unlinkSync(tempOutput); } catch {}
        }
    });
}

async function toMp4({ sock, msg, remoteJid, quotedMsg, quotedStanza, logger, downloadFn, TEMP_DIR }) {
    if (!quotedMsg?.stickerMessage) {
        return sock.sendMessage(remoteJid, { text: '⚠️ Balas stiker animasi dengan *!tomp4*' }, { quoted: msg });
    }

    await sock.sendMessage(remoteJid, { text: '⏳ Mengubah stiker animasi ke MP4...' }, { quoted: msg });

    let buffer = await downloadFn(sock, msg, quotedMsg, quotedStanza);
    if (!buffer) return sock.sendMessage(remoteJid, { text: '❌ Gagal download stiker' }, { quoted: msg });

    await ffmpegQueue.add(async () => {
        const time = Date.now();
        const tempInput = path.join(TEMP_DIR, `stk_${time}.webp`);
        const tempOutput = path.join(TEMP_DIR, `mp4_${time}.mp4`);
        await fs.promises.writeFile(tempInput, buffer);
        buffer = null;

        try {
            await new Promise((resolve, reject) => {
                ffmpeg(tempInput)
                    .outputOptions([
                        '-vf fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p',
                        '-vcodec libx264',
                        '-movflags +faststart',
                        '-an'
                    ])
                    .on('end', resolve)
                    .on('error', reject)
                    .save(tempOutput);
            });
            const mp4Buffer = await fs.promises.readFile(tempOutput);
            await sock.sendMessage(remoteJid, {
                video: mp4Buffer,
                caption: '🎞️ Hasil konversi stiker animasi'
            }, { quoted: msg });
            logger.info(`✅ Animated sticker converted to MP4 for ${remoteJid}`);
        } catch (err) {
            logger.error({ err }, 'ToMp4 error');
            await sock.sendMessage(remoteJid, { text: '❌ Gagal mengubah stiker animasi ke MP4.' }, { quoted: msg });
        } finally {
            try { fs.unlinkSync(tempInput); } catch {}
            try { fs.unlinkSync(tempOutput); } catch {}
        }
    });
}

module.exports = {
    getMediaKind,
    formatBytes,
    ffprobeFile,
    stickerInfo,
    toImage,
    toGif,
    toMp4
};
