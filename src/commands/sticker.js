const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const { renderTextToWebP } = require('../utils/textRenderer');
const { stickerCache, textStickerCache, ffmpegQueue, imageQueue } = require('../utils/cache');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);
const TEMP_DIR = path.join(__dirname, '../../temp');
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '10485760');

module.exports = {
    names: ['s', 'sticker', 'stiker', 'sgif', 'stickergif', 'stikergif',
            'scircle', 'scrop', 'srounded',
            'toimg'],

    async execute({ sock, msg, args, cmdName, remoteJid, quotedMsg, quotedStanza, session, logger, PREFIX }) {
        // ─────────────────────────────────────────────
        // TOIMG — Convert sticker back to image
        // ─────────────────────────────────────────────
        if (cmdName === 'toimg') {
            return await this.toImage({ sock, msg, remoteJid, quotedMsg, quotedStanza, logger });
        }

        // ─────────────────────────────────────────────
        // SCIRCLE / SCROP / SROUNDED — Shortcut stickers
        // ─────────────────────────────────────────────
        const shortcutCmds = ['scircle', 'scrop', 'srounded'];
        if (shortcutCmds.includes(cmdName)) {
            const typeMap = { scircle: 'circle', scrop: 'crop', srounded: 'rounded' };
            session.type = typeMap[cmdName];
            return await this.createFromMedia({ sock, msg, args, remoteJid, quotedMsg, quotedStanza, session, logger });
        }

        // ─────────────────────────────────────────────
        // SGIF / STICKERGIF — Animated sticker (video)
        // ─────────────────────────────────────────────
        const gifCmds = ['sgif', 'stickergif', 'stikergif'];
        if (gifCmds.includes(cmdName)) {
            return await this.createAnimated({ sock, msg, args, remoteJid, quotedMsg, quotedStanza, session, logger });
        }

        // ─────────────────────────────────────────────
        // TEXT STICKER — Create sticker from text
        // ─────────────────────────────────────────────
        const text = args.join(' ');
        if (text && !this.hasMedia(msg, quotedMsg)) {
            return await this.createFromText({ sock, msg, text, remoteJid, session, logger });
        }

        // ─────────────────────────────────────────────
        // IMAGE/VIDEO STICKER — Default
        // ─────────────────────────────────────────────
        // Parse quality & type from args
        const parsedArgs = this.parseArgs(args);
        if (parsedArgs.type) session.type = parsedArgs.type;
        if (parsedArgs.quality) session.quality = parsedArgs.quality;

        const isVideo = !!(msg.message.videoMessage ||
            quotedMsg?.videoMessage ||
            quotedMsg?.extendedTextMessage?.contextInfo?.quotedMessage?.videoMessage);

        if (isVideo) {
            await this.createAnimated({ sock, msg, args, remoteJid, quotedMsg, quotedStanza, session, logger });
        } else {
            await this.createFromMedia({ sock, msg, args, remoteJid, quotedMsg, quotedStanza, session, logger });
        }
    },

    hasMedia(msg, quotedMsg) {
        return !!(msg.message.imageMessage || msg.message.videoMessage ||
            quotedMsg?.imageMessage || quotedMsg?.videoMessage ||
            quotedMsg?.stickerMessage);
    },

    parseArgs(args) {
        const result = {};
        for (let i = 0; i < args.length; i++) {
            const a = args[i].toLowerCase();
            if (['--crop', '-c'].includes(a)) result.type = 'crop';
            else if (['--circle', '-o'].includes(a)) result.type = 'circle';
            else if (['--rounded', '-r'].includes(a)) result.type = 'rounded';
            else if (['--full', '-f'].includes(a)) result.type = 'full';
            else if (['--quality', '-q'].includes(a) && args[i + 1]) {
                result.quality = parseInt(args[++i]);
                if (isNaN(result.quality)) result.quality = 80;
            }
        }
        return result;
    },

    getType(typeStr) {
        const map = {
            'crop': StickerTypes.CROPPED,
            'full': StickerTypes.FULL,
            'circle': StickerTypes.CIRCLE,
            'rounded': StickerTypes.ROUNDED,
            'default': StickerTypes.DEFAULT
        };
        return map[typeStr] || StickerTypes.FULL;
    },

    async download(sock, msg, quotedMsg, quotedStanza) {
        try {
            if (quotedMsg) {
                return await downloadMediaMessage(
                    { key: { id: quotedStanza, remoteJid: msg.key.remoteJid }, message: quotedMsg },
                    'buffer', {}, { logger: console }
                );
            }
            return await downloadMediaMessage(msg, 'buffer', {}, { logger: console });
        } catch {
            return null;
        }
    },

    async createFromMedia({ sock, msg, args, remoteJid, quotedMsg, quotedStanza, session, logger }) {
        const buffer = await this.download(sock, msg, quotedMsg, quotedStanza);
        if (!buffer) return sock.sendMessage(remoteJid, { text: '📸 Balas/kirim foto dengan caption *!s*' }, { quoted: msg });
        if (buffer.length > MAX_FILE_SIZE) {
            return sock.sendMessage(remoteJid, { text: '⚠️ File terlalu besar! Maks 10MB' }, { quoted: msg });
        }

        // Hash-based cache key (content-aware, file-size collision safe)
        const hash = crypto.createHash('md5').update(buffer).digest('hex');
        const cacheKey = `${session.type}-${session.quality}-${hash}`;
        const cached = stickerCache.get(cacheKey);
        if (cached) {
            await sock.sendMessage(remoteJid, { sticker: cached }, { quoted: msg });
            return logger.info(`✅ Sticker (cached) sent to ${remoteJid}`);
        }

        await sock.sendMessage(remoteJid, { text: '⏳ Membuat stiker...' }, { quoted: msg });

        // Queue to limit concurrent processing
        await imageQueue.add(async () => {
            const sticker = new Sticker(buffer, {
                pack: session.pack,
                author: session.author,
                type: this.getType(session.type),
                quality: session.quality,
                background: { r: 0, g: 0, b: 0, alpha: 0 }
            });

            const msgData = await sticker.toMessage();
            stickerCache.set(cacheKey, msgData.sticker);
            await sock.sendMessage(remoteJid, msgData, { quoted: msg });
            session.type = 'default';
            logger.info(`✅ Sticker sent to ${remoteJid}`);
        });
    },

    async createAnimated({ sock, msg, args, remoteJid, quotedMsg, quotedStanza, session, logger }) {
        let buffer = await this.download(sock, msg, quotedMsg, quotedStanza);
        if (!buffer) return sock.sendMessage(remoteJid, { text: '🎬 Balas video dengan *!sgif*' }, { quoted: msg });
        if (buffer.length > MAX_FILE_SIZE) {
            return sock.sendMessage(remoteJid, { text: '⚠️ Video terlalu besar! Maks 10MB' }, { quoted: msg });
        }

        await sock.sendMessage(remoteJid, { text: '⏳ Membuat stiker animasi...' }, { quoted: msg });

        // Queue FFmpeg — max 1 at a time (memory saver)
        await ffmpegQueue.add(async () => {
            const time = Date.now();
            const tempInput = path.join(TEMP_DIR, `vid_${time}.bin`);
            const tempOutput = path.join(TEMP_DIR, `sticker_${time}.webp`);
            // ⚡ Async I/O — avoids blocking event loop on large video buffers
            await fs.promises.writeFile(tempInput, buffer);
            // ⚡ Release source buffer (~up to 10MB) before heavy FFmpeg processing
            buffer = null;

            try {
                const quality = Math.max(1, Math.min(100, session.quality || 80));
                await new Promise((resolve, reject) => {
                    ffmpeg(tempInput)
                        .outputOptions([
                            '-t 00:00:10',
                            '-vcodec libwebp_anim',
                            '-vf fps=15,scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p',
                            '-loop 0',
                            '-preset default',
                            '-an',
                            '-vsync 0',
                            '-compression_level 6',
                            `-q:v ${quality}`
                        ])
                        .toFormat('webp')
                        .on('end', resolve)
                        .on('error', reject)
                        .save(tempOutput);
                });

                // ⚡ Async read — keeps event loop free while reading output
                const stickerBuffer = await fs.promises.readFile(tempOutput);
                await sock.sendMessage(remoteJid, { sticker: stickerBuffer }, { quoted: msg });
                logger.info(`✅ Animated sticker sent to ${remoteJid}`);
            } catch (err) {
                logger.error({ err }, 'FFmpeg error');
                await sock.sendMessage(remoteJid, { text: '❌ Gagal proses video. Mungkin terlalu panjang atau corrupt.' }, { quoted: msg });
            } finally {
                try { fs.unlinkSync(tempInput); } catch {}
                try { fs.unlinkSync(tempOutput); } catch {}
            }
        });
    },

    async createFromText({ sock, msg, text, remoteJid, session, logger }) {
        // Parse --bg color if provided
        let bgColor = '#FFFFFF';
        let displayText = text;
        if (text.includes('--bg ')) {
            const match = text.match(/--bg\s+(#[0-9a-fA-F]{6,8})/);
            if (match) {
                bgColor = match[1];
                displayText = text.replace(/--bg\s+#[0-9a-fA-F]{6,8}/g, '').trim();
            }
        }

        const textColor = bgColor === '#FFFFFF' || bgColor === '#FFF' || bgColor === '#FFFFFFFF' ? '#222222' : '#FFFFFF';

        // Check text sticker cache
        const textCacheKey = `${displayText}-${bgColor}-${session.quality}`;
        const cachedText = textStickerCache.get(textCacheKey);
        if (cachedText) {
            await sock.sendMessage(remoteJid, { sticker: cachedText }, { quoted: msg });
            return logger.info(`✅ Text sticker (cached) sent: "${displayText.slice(0, 30)}..."`);
        }

        await sock.sendMessage(remoteJid, { text: '⏳ Membuat stiker teks...' }, { quoted: msg });

        // Render text with justify via canvas
        const imgBuffer = await renderTextToWebP(displayText, {
            bgColor,
            textColor,
            quality: session.quality || 90
        });

        // Send as sticker directly (bypass Sticker class to avoid memory issues)
        await sock.sendMessage(remoteJid, { sticker: imgBuffer }, { quoted: msg });
        textStickerCache.set(textCacheKey, imgBuffer);
        logger.info(`✅ Text sticker sent: "${displayText.slice(0, 30)}..."`);
    },

    async toImage({ sock, msg, remoteJid, quotedMsg, quotedStanza, logger }) {
        if (!quotedMsg?.stickerMessage) {
            return sock.sendMessage(remoteJid, { text: '⚠️ Balas stiker dengan *!toimg*' }, { quoted: msg });
        }

        await sock.sendMessage(remoteJid, { text: '⏳ Mengubah stiker ke gambar...' }, { quoted: msg });

        let buffer = await this.download(sock, msg, quotedMsg, quotedStanza);
        if (!buffer) return sock.sendMessage(remoteJid, { text: '❌ Gagal download stiker' }, { quoted: msg });

        const time = Date.now();
        const tempInput = path.join(TEMP_DIR, `stk_${time}.webp`);
        const tempOutput = path.join(TEMP_DIR, `img_${time}.png`);
        // ⚡ Async I/O — avoids blocking event loop on sticker buffer write
        await fs.promises.writeFile(tempInput, buffer);
        // ⚡ Release source buffer before FFmpeg processing
        buffer = null;

        try {
            await new Promise((resolve, reject) => {
                ffmpeg(tempInput)
                    .outputOptions(['-vframes 1', '-vcodec png'])
                    .on('end', resolve).on('error', reject)
                    .save(tempOutput);
            });
            // ⚡ Async read — keeps event loop free during image conversion
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
};
