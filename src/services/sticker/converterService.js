const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

const crypto = require('crypto');
const { ffmpegQueue, imageQueue } = require('../../utils/cache');

function unwrapMessage(m) {
    if (!m) return null;
    if (m.ephemeralMessage?.message) return unwrapMessage(m.ephemeralMessage.message);
    if (m.viewOnceMessage?.message) return unwrapMessage(m.viewOnceMessage.message);
    if (m.viewOnceMessageV2?.message) return unwrapMessage(m.viewOnceMessageV2.message);
    if (m.viewOnceMessageV2Extension?.message) return unwrapMessage(m.viewOnceMessageV2Extension.message);
    if (m.documentWithCaptionMessage?.message) return unwrapMessage(m.documentWithCaptionMessage.message);
    return m;
}

function getMediaKind(message) {
    const m = unwrapMessage(message);
    if (m?.stickerMessage) return 'sticker';
    if (m?.imageMessage) return 'image';
    if (m?.videoMessage) return m.videoMessage.gifPlayback ? 'gif/video' : 'video';
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
    const target = unwrapMessage(quotedMsg) || unwrapMessage(msg.message);
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
        const uniqueId = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
        const tempInput = path.join(TEMP_DIR, `info_${uniqueId}.bin`);
        await fs.promises.writeFile(tempInput, buffer);
        buffer = null;
        try {
            const probe = await ffprobeFile(tempInput);
            const stream = probe?.streams?.find(s => s.codec_type === 'video');
            if (stream?.codec_name) lines.push(`Codec: ${stream.codec_name}`);
            if (stream?.duration) lines.push(`Durasi: ${Number(stream.duration).toFixed(2)}s`);
            if (stream?.avg_frame_rate && stream.avg_frame_rate !== '0/0') lines.push(`FPS: ${stream.avg_frame_rate}`);
        } finally {
            try { if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput); } catch {}
        }
    }

    if (target?.stickerMessage?.isAnimated) lines.push('Animated: ya');
    await sock.sendMessage(remoteJid, { text: lines.join('\n') }, { quoted: msg });
    logger.info(`✅ Sticker info sent to ${remoteJid}`);
}

async function toImage({ sock, msg, remoteJid, quotedMsg, quotedStanza, logger, downloadFn, TEMP_DIR }) {
    const unwrappedQuoted = unwrapMessage(quotedMsg);
    if (!unwrappedQuoted?.stickerMessage) {
        return sock.sendMessage(remoteJid, { text: '⚠️ Balas stiker dengan *!toimg*' }, { quoted: msg });
    }

    await sock.sendMessage(remoteJid, { text: '⏳ Mengubah stiker ke gambar...' }, { quoted: msg });

    await imageQueue.add(async () => {
        let buffer = await downloadFn(sock, msg, quotedMsg, quotedStanza);
        if (!buffer) return sock.sendMessage(remoteJid, { text: '❌ Gagal download stiker' }, { quoted: msg });

        const uniqueId = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
        const tempInput = path.join(TEMP_DIR, `stk_${uniqueId}.webp`);
        const tempOutput = path.join(TEMP_DIR, `img_${uniqueId}.png`);

        try {
            await fs.promises.writeFile(tempInput, buffer);
            buffer = null;

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
            try { if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput); } catch {}
            try { if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput); } catch {}
        }
    });
}

async function toGif({ sock, msg, remoteJid, quotedMsg, quotedStanza, logger, downloadFn, TEMP_DIR }) {
    const unwrappedQuoted = unwrapMessage(quotedMsg);
    if (!unwrappedQuoted?.stickerMessage) {
        return sock.sendMessage(remoteJid, { text: '⚠️ Balas stiker animasi dengan *!togif*' }, { quoted: msg });
    }

    await sock.sendMessage(remoteJid, { text: '⏳ Mengubah stiker animasi ke GIF...' }, { quoted: msg });

    await ffmpegQueue.add(async () => {
        let buffer = await downloadFn(sock, msg, quotedMsg, quotedStanza);
        if (!buffer) return sock.sendMessage(remoteJid, { text: '❌ Gagal download stiker' }, { quoted: msg });

        const uniqueId = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
        const tempInput = path.join(TEMP_DIR, `stk_${uniqueId}.webp`);
        const tempOutput = path.join(TEMP_DIR, `gif_${uniqueId}.gif`);

        try {
            await fs.promises.writeFile(tempInput, buffer);
            buffer = null;

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
            try { if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput); } catch {}
            try { if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput); } catch {}
        }
    });
}

async function toMp4({ sock, msg, remoteJid, quotedMsg, quotedStanza, logger, downloadFn, TEMP_DIR }) {
    const unwrappedQuoted = unwrapMessage(quotedMsg);
    if (!unwrappedQuoted?.stickerMessage) {
        return sock.sendMessage(remoteJid, { text: '⚠️ Balas stiker animasi dengan *!tomp4*' }, { quoted: msg });
    }

    await sock.sendMessage(remoteJid, { text: '⏳ Mengubah stiker animasi ke MP4...' }, { quoted: msg });

    await ffmpegQueue.add(async () => {
        let buffer = await downloadFn(sock, msg, quotedMsg, quotedStanza);
        if (!buffer) return sock.sendMessage(remoteJid, { text: '❌ Gagal download stiker' }, { quoted: msg });

        const uniqueId = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
        const tempInput = path.join(TEMP_DIR, `stk_${uniqueId}.webp`);
        const tempOutput = path.join(TEMP_DIR, `mp4_${uniqueId}.mp4`);

        try {
            await fs.promises.writeFile(tempInput, buffer);
            buffer = null;

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
            try { if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput); } catch {}
            try { if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput); } catch {}
        }
    });
}

/**
 * Reveals and extracts View Once media (photos/videos/audio) in its original resolution and format (not WebP).
 */
async function revealViewOnce({ sock, msg, remoteJid, quotedMsg, quotedStanza, logger, downloadFn }) {
    const hasDirectMedia = Boolean(
        msg?.message?.imageMessage ||
        msg?.message?.videoMessage ||
        msg?.message?.audioMessage ||
        msg?.message?.viewOnceMessage ||
        msg?.message?.viewOnceMessageV2 ||
        msg?.message?.viewOnceMessageV2Extension ||
        msg?.message?.ephemeralMessage
    );

    if (!quotedMsg && !hasDirectMedia) {
        return sock.sendMessage(remoteJid, {
            text: '👁️ *REVEAL VIEW ONCE*\n\nBalas/reply pesan foto atau video *Sekali Lihat (View Once)* dengan perintah *!reveal* untuk menyimpan dan membuka isinya dalam resolusi/kualitas asli (bukan WebP).'
        }, { quoted: msg });
    }

    const rawTarget = quotedMsg || msg?.message;
    const unwrapped = unwrapMessage(rawTarget);
    const isImage = Boolean(unwrapped?.imageMessage);
    const isVideo = Boolean(unwrapped?.videoMessage);
    const isAudio = Boolean(unwrapped?.audioMessage);

    if (!isImage && !isVideo && !isAudio) {
        return sock.sendMessage(remoteJid, {
            text: '⚠️ Pesan yang dibalas bukan foto, video, atau audio Sekali Lihat (View Once).'
        }, { quoted: msg });
    }

    await sock.sendMessage(remoteJid, { text: '⏳ Membuka media View Once...' }, { quoted: msg });

    try {
        const buffer = await downloadFn(sock, msg, quotedMsg, quotedStanza);
        if (!buffer || !buffer.length) {
            return sock.sendMessage(remoteJid, {
                text: '❌ Gagal mengunduh media View Once. Kemungkinan media sudah kedaluwarsa di server WhatsApp atau belum terunduh.'
            }, { quoted: msg });
        }

        const mediaObj = unwrapped.imageMessage || unwrapped.videoMessage || unwrapped.audioMessage;
        const rawCaption = mediaObj?.caption ? String(mediaObj.caption).trim() : '';
        const caption = rawCaption ? `🔓 *[View Once]*\n\n${rawCaption}` : '🔓 *View Once Revealed*';

        if (isImage) {
            await sock.sendMessage(remoteJid, {
                image: buffer,
                caption,
                mimetype: mediaObj?.mimetype || 'image/jpeg'
            }, { quoted: msg });
        } else if (isVideo) {
            await sock.sendMessage(remoteJid, {
                video: buffer,
                caption,
                mimetype: mediaObj?.mimetype || 'video/mp4'
            }, { quoted: msg });
        } else if (isAudio) {
            await sock.sendMessage(remoteJid, {
                audio: buffer,
                mimetype: mediaObj?.mimetype || 'audio/ogg; codecs=opus',
                ptt: Boolean(mediaObj?.ptt)
            }, { quoted: msg });
        }

        logger?.info?.({ remoteJid, isImage, isVideo, isAudio, bytes: buffer.length }, 'View Once media revealed successfully');
    } catch (err) {
        logger?.error?.({ err }, 'Error in revealViewOnce');
        await sock.sendMessage(remoteJid, {
            text: `❌ Gagal membuka View Once: ${err.message || 'Terjadi kesalahan sistem'}`
        }, { quoted: msg });
    }
}

module.exports = {
    unwrapMessage,
    getMediaKind,
    formatBytes,
    ffprobeFile,
    stickerInfo,
    toImage,
    toGif,
    toMp4,
    revealViewOnce
};
