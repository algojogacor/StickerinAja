const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

const { renderTextOverlaySvg } = require('./svgRenderer');
const { ffmpegQueue } = require('../../utils/cache');

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(Math.max(number, min), max);
}

function getAnimatedEncodeAttempts(parsedArgs, session) {
    const baseFps = clampNumber(parsedArgs.fps, 6, 24, 15);
    const baseQuality = clampNumber(parsedArgs.quality || session.quality, 1, 100, 80);
    const baseDuration = clampNumber(parsedArgs.duration, 1, 10, 10);
    const profiles = [
        { fps: baseFps, quality: baseQuality, duration: baseDuration },
        { fps: Math.min(baseFps, 12), quality: Math.min(baseQuality, 70), duration: Math.min(baseDuration, 8) },
        { fps: Math.min(baseFps, 10), quality: Math.min(baseQuality, 60), duration: Math.min(baseDuration, 6) },
        { fps: Math.min(baseFps, 8), quality: Math.min(baseQuality, 50), duration: Math.min(baseDuration, 5) },
        { fps: Math.min(baseFps, 6), quality: Math.min(baseQuality, 42), duration: Math.min(baseDuration, 4) }
    ];

    const seen = new Set();
    return profiles.filter((profile) => {
        const key = `${profile.fps}-${profile.quality}-${profile.duration}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function encodeAnimatedSticker({ inputPath, outputPath, overlayPath, parsedArgs, attempt }) {
    const baseFilter = `fps=${attempt.fps},scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p`;
    const hasOverlay = !!parsedArgs.overlayText;
    const outputOptions = [
        `-t ${attempt.duration}`,
        '-vcodec libwebp_anim',
        '-loop 0',
        '-preset default',
        '-an',
        '-vsync 0',
        '-compression_level 6',
        `-q:v ${attempt.quality}`
    ];

    await new Promise((resolve, reject) => {
        const command = ffmpeg(inputPath);
        if (parsedArgs.start) command.inputOptions([`-ss ${parsedArgs.start}`]);
        if (hasOverlay) {
            command
                .input(overlayPath)
                .complexFilter(`[0:v]${baseFilter}[base];[base][1:v]overlay=0:0:format=auto,format=yuva420p[out]`, 'out');
        } else {
            outputOptions.unshift(`-vf ${baseFilter}`);
        }
        command
            .outputOptions(outputOptions)
            .toFormat('webp')
            .on('end', resolve)
            .on('error', reject)
            .save(outputPath);
    });
}

async function createAnimated({
    sock, msg, args, remoteJid, quotedMsg, quotedStanza, session, logger,
    downloadFn, parseArgsFn, TEMP_DIR, MAX_FILE_SIZE, ANIMATED_STICKER_TARGET_BYTES
}) {
    let buffer = await downloadFn(sock, msg, quotedMsg, quotedStanza);
    const parsedArgs = parseArgsFn(args);
    if (!buffer) return sock.sendMessage(remoteJid, { text: '🎬 Balas video dengan *!sgif*' }, { quoted: msg });
    if (buffer.length > MAX_FILE_SIZE) {
        return sock.sendMessage(remoteJid, { text: '⚠️ Video terlalu besar! Maks 10MB' }, { quoted: msg });
    }

    await sock.sendMessage(remoteJid, { text: '⏳ Membuat stiker animasi...' }, { quoted: msg });

    await ffmpegQueue.add(async () => {
        const time = Date.now();
        const tempInput = path.join(TEMP_DIR, `vid_${time}.bin`);
        const tempOverlay = path.join(TEMP_DIR, `overlay_${time}.png`);
        const tempOutputs = [];
        await fs.promises.writeFile(tempInput, buffer);
        buffer = null;

        try {
            if (parsedArgs.overlayText) {
                const overlaySvg = renderTextOverlaySvg(parsedArgs.overlayText, parsedArgs);
                if (overlaySvg) {
                    const overlayPng = await sharp(overlaySvg).png().toBuffer();
                    await fs.promises.writeFile(tempOverlay, overlayPng);
                }
            }

            const attempts = getAnimatedEncodeAttempts(parsedArgs, session);
            let bestResult = null;

            for (let i = 0; i < attempts.length; i++) {
                const attempt = attempts[i];
                const tempOutput = path.join(TEMP_DIR, `sticker_${time}_${i}.webp`);
                tempOutputs.push(tempOutput);

                await encodeAnimatedSticker({
                    inputPath: tempInput,
                    outputPath: tempOutput,
                    overlayPath: tempOverlay,
                    parsedArgs,
                    attempt
                });

                const stat = await fs.promises.stat(tempOutput);
                const result = { path: tempOutput, size: stat.size, attempt, index: i + 1 };
                logger.info({
                    attempt: result.index,
                    size: result.size,
                    target: ANIMATED_STICKER_TARGET_BYTES,
                    fps: attempt.fps,
                    quality: attempt.quality,
                    duration: attempt.duration
                }, 'Animated sticker encode attempt');

                if (!bestResult || result.size < bestResult.size) {
                    bestResult = result;
                }

                if (result.size <= ANIMATED_STICKER_TARGET_BYTES) {
                    bestResult = result;
                    break;
                }
            }

            if (!bestResult) throw new Error('No animated sticker output was generated');

            const stickerBuffer = await fs.promises.readFile(bestResult.path);
            await sock.sendMessage(remoteJid, { sticker: stickerBuffer }, { quoted: msg });
            logger.info({
                size: bestResult.size,
                attempt: bestResult.index,
                fps: bestResult.attempt.fps,
                quality: bestResult.attempt.quality,
                duration: bestResult.attempt.duration
            }, `✅ Animated sticker sent to ${remoteJid}`);
        } catch (err) {
            logger.error({ err }, 'FFmpeg error');
            await sock.sendMessage(remoteJid, { text: '❌ Gagal proses video. Mungkin terlalu panjang atau corrupt.' }, { quoted: msg });
        } finally {
            try { fs.unlinkSync(tempInput); } catch {}
            try { fs.unlinkSync(tempOverlay); } catch {}
            for (const tempOutput of tempOutputs) {
                try { fs.unlinkSync(tempOutput); } catch {}
            }
        }
    });
}

module.exports = {
    clampNumber,
    getAnimatedEncodeAttempts,
    encodeAnimatedSticker,
    createAnimated
};
