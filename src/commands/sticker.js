const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const { renderTextToWebP } = require('../utils/textRenderer');
const { stickerCache, textStickerCache, ffmpegQueue, imageQueue } = require('../utils/cache');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { createCanvas, loadImage } = require('canvas');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);
const TEMP_DIR = path.join(__dirname, '../../temp');
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '10485760');

module.exports = {
    names: ['s', 'sticker', 'stiker', 'sgif', 'stickergif', 'stikergif',
            'scircle', 'scrop', 'srounded',
            'meme', 'smeme', 'stext',
            'toimg', 'togif'],

    async execute({ sock, msg, args, cmdName, remoteJid, quotedMsg, quotedStanza, session, logger, PREFIX }) {
        // ─────────────────────────────────────────────
        // TOIMG — Convert sticker back to image
        // ─────────────────────────────────────────────
        if (cmdName === 'toimg') {
            return await this.toImage({ sock, msg, remoteJid, quotedMsg, quotedStanza, logger });
        }

        if (cmdName === 'togif') {
            return await this.toGif({ sock, msg, remoteJid, quotedMsg, quotedStanza, logger });
        }

        if (['meme', 'smeme'].includes(cmdName)) {
            return await this.createMeme({ sock, msg, args, remoteJid, quotedMsg, quotedStanza, session, logger });
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
            else if (['--gray', '--grayscale', '--bw'].includes(a)) result.gray = true;
            else if (['--invert', '--negative'].includes(a)) result.invert = true;
            else if (['--sharpen', '--sharp'].includes(a)) result.sharpen = true;
            else if (['--sepia'].includes(a)) result.sepia = true;
            else if (['--flip'].includes(a)) result.flip = true;
            else if (['--flop', '--mirror'].includes(a)) result.flop = true;
            else if (['--rmbg', '--removebg', '--transparent'].includes(a)) result.removeBg = true;
            else if (['--blur'].includes(a)) {
                const next = parseFloat(args[i + 1]);
                result.blur = Number.isFinite(next) ? Math.min(Math.max(next, 1), 20) : 4;
                if (Number.isFinite(next)) i++;
            }
            else if (['--rotate'].includes(a) && args[i + 1]) {
                const rotate = parseInt(args[++i]);
                if (!isNaN(rotate)) result.rotate = rotate;
            }
            else if (['--start', '-ss'].includes(a) && args[i + 1]) {
                const start = parseFloat(args[++i]);
                if (!isNaN(start)) result.start = Math.max(0, start);
            }
            else if (['--dur', '--duration', '-d'].includes(a) && args[i + 1]) {
                const duration = parseFloat(args[++i]);
                if (!isNaN(duration)) result.duration = Math.min(Math.max(duration, 1), 10);
            }
            else if (['--fps'].includes(a) && args[i + 1]) {
                const fps = parseInt(args[++i]);
                if (!isNaN(fps)) result.fps = Math.min(Math.max(fps, 6), 24);
            }
            else if (['--text', '-t'].includes(a)) {
                const words = [];
                while (args[i + 1] && !args[i + 1].startsWith('--')) {
                    words.push(args[++i]);
                }
                result.overlayText = words.join(' ').trim();
            }
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

    hasImageTransforms(options) {
        return !!(options.gray || options.invert || options.blur || options.sharpen ||
            options.sepia || options.flip || options.flop || options.rotate ||
            options.removeBg || options.overlayText);
    },

    normalizeMemeParts(text) {
        const parts = text.split('|').map(v => v.trim()).filter(Boolean);
        return {
            top: parts[0] || '',
            bottom: parts.slice(1).join(' ') || ''
        };
    },

    async removeSimpleBackground(buffer, tolerance = 34) {
        const image = sharp(buffer).resize(512, 512, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        }).ensureAlpha();
        const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
        const idx = (x, y) => (y * info.width + x) * info.channels;
        const samples = [
            idx(0, 0),
            idx(info.width - 1, 0),
            idx(0, info.height - 1),
            idx(info.width - 1, info.height - 1)
        ];
        const bg = samples.reduce((acc, i) => {
            acc.r += data[i];
            acc.g += data[i + 1];
            acc.b += data[i + 2];
            return acc;
        }, { r: 0, g: 0, b: 0 });
        bg.r /= samples.length;
        bg.g /= samples.length;
        bg.b /= samples.length;

        for (let i = 0; i < data.length; i += info.channels) {
            const dist = Math.abs(data[i] - bg.r) + Math.abs(data[i + 1] - bg.g) + Math.abs(data[i + 2] - bg.b);
            if (dist <= tolerance) data[i + 3] = 0;
        }

        return sharp(data, { raw: info }).png().toBuffer();
    },

    wrapCanvasText(ctx, text, maxWidth) {
        const words = text.split(/\s+/).filter(Boolean);
        const lines = [];
        let line = '';
        for (const word of words) {
            const test = line ? `${line} ${word}` : word;
            if (ctx.measureText(test).width > maxWidth && line) {
                lines.push(line);
                line = word;
            } else {
                line = test;
            }
        }
        if (line) lines.push(line);
        return lines;
    },

    drawStickerText(ctx, text, y, options = {}) {
        if (!text) return;
        const W = 512;
        let fontSize = options.fontSize || 42;
        let lines = [];
        do {
            ctx.font = `bold ${fontSize}px Arial, Helvetica, sans-serif`;
            lines = this.wrapCanvasText(ctx, text.toUpperCase(), W - 42);
            fontSize -= 2;
        } while (lines.length > 3 && fontSize > 24);

        const lineHeight = (fontSize + 2) * 1.1;
        const totalHeight = lines.length * lineHeight;
        const startY = options.align === 'bottom' ? y - totalHeight + lineHeight : y;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(5, Math.floor(fontSize / 6));
        ctx.strokeStyle = '#111111';
        ctx.fillStyle = '#ffffff';

        for (let i = 0; i < lines.length; i++) {
            const lineY = startY + i * lineHeight;
            ctx.strokeText(lines[i], W / 2, lineY);
            ctx.fillText(lines[i], W / 2, lineY);
        }
    },

    async applyTextOverlay(buffer, text) {
        const base = await sharp(buffer)
            .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer();
        const canvas = createCanvas(512, 512);
        const ctx = canvas.getContext('2d');
        const img = await loadImage(base);
        ctx.drawImage(img, 0, 0, 512, 512);
        this.drawStickerText(ctx, text, 448, { align: 'bottom', fontSize: 36 });
        return canvas.toBuffer('image/png');
    },

    async renderMemeSticker(buffer, top, bottom, quality = 90) {
        const canvas = createCanvas(512, 512);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 512, 512);

        if (buffer) {
            const base = await sharp(buffer).resize(512, 512, { fit: 'cover' }).png().toBuffer();
            const img = await loadImage(base);
            ctx.drawImage(img, 0, 0, 512, 512);
        }

        this.drawStickerText(ctx, top, 50, { align: 'top', fontSize: 44 });
        this.drawStickerText(ctx, bottom, 472, { align: 'bottom', fontSize: 44 });

        const rawBuffer = canvas.toBuffer('raw');
        return sharp(rawBuffer, { raw: { width: 512, height: 512, channels: 4 } })
            .webp({ quality })
            .toBuffer();
    },

    async preprocessImage(buffer, options) {
        let working = buffer;
        if (options.removeBg) {
            working = await this.removeSimpleBackground(working);
        }

        let image = sharp(working, { animated: false }).rotate();
        if (options.rotate) image = image.rotate(options.rotate);
        if (options.flip) image = image.flip();
        if (options.flop) image = image.flop();
        if (options.gray) image = image.grayscale();
        if (options.invert) image = image.negate({ alpha: false });
        if (options.blur) image = image.blur(options.blur);
        if (options.sharpen) image = image.sharpen();
        if (options.sepia) {
            image = image.recomb([
                [0.3588, 0.5889, 0.0913],
                [0.2990, 0.5870, 0.1140],
                [0.2392, 0.4696, 0.0913]
            ]);
        }

        const transformed = await image.png().toBuffer();
        return options.overlayText ? this.applyTextOverlay(transformed, options.overlayText) : transformed;
    },

    async createFromMedia({ sock, msg, args, remoteJid, quotedMsg, quotedStanza, session, logger }) {
        let buffer = await this.download(sock, msg, quotedMsg, quotedStanza);
        if (!buffer) return sock.sendMessage(remoteJid, { text: '📸 Balas/kirim foto dengan caption *!s*' }, { quoted: msg });
        if (buffer.length > MAX_FILE_SIZE) {
            return sock.sendMessage(remoteJid, { text: '⚠️ File terlalu besar! Maks 10MB' }, { quoted: msg });
        }

        const parsedArgs = this.parseArgs(args);
        const stickerType = parsedArgs.type || session.type;
        const quality = parsedArgs.quality || session.quality;

        // Hash-based cache key (content-aware, file-size collision safe)
        const hash = crypto.createHash('md5').update(buffer).digest('hex');
        const cacheKey = `${stickerType}-${quality}-${JSON.stringify(parsedArgs)}-${hash}`;
        const cached = stickerCache.get(cacheKey);
        if (cached) {
            await sock.sendMessage(remoteJid, { sticker: cached }, { quoted: msg });
            return logger.info(`✅ Sticker (cached) sent to ${remoteJid}`);
        }

        await sock.sendMessage(remoteJid, { text: '⏳ Membuat stiker...' }, { quoted: msg });

        // Queue to limit concurrent processing
        await imageQueue.add(async () => {
            if (this.hasImageTransforms(parsedArgs)) {
                buffer = await this.preprocessImage(buffer, parsedArgs);
            }

            const sticker = new Sticker(buffer, {
                pack: session.pack,
                author: session.author,
                type: this.getType(stickerType),
                quality,
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
        const parsedArgs = this.parseArgs(args);
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
                const quality = Math.max(1, Math.min(100, parsedArgs.quality || session.quality || 80));
                const fps = parsedArgs.fps || 15;
                const duration = parsedArgs.duration || 10;
                const outputOptions = [
                    `-t ${duration}`,
                    '-vcodec libwebp_anim',
                    `-vf fps=${fps},scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p`,
                    '-loop 0',
                    '-preset default',
                    '-an',
                    '-vsync 0',
                    '-compression_level 6',
                    `-q:v ${quality}`
                ];
                await new Promise((resolve, reject) => {
                    const command = ffmpeg(tempInput);
                    if (parsedArgs.start) command.inputOptions([`-ss ${parsedArgs.start}`]);
                    command
                        .outputOptions(outputOptions)
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

    async createMeme({ sock, msg, args, remoteJid, quotedMsg, quotedStanza, session, logger }) {
        const text = args.join(' ');
        const { top, bottom } = this.normalizeMemeParts(text);
        if (!top && !bottom) {
            return sock.sendMessage(remoteJid, {
                text: 'Gunakan: *!meme teks atas | teks bawah* sambil reply gambar, atau tanpa gambar untuk meme teks.'
            }, { quoted: msg });
        }

        await sock.sendMessage(remoteJid, { text: '⏳ Membuat meme sticker...' }, { quoted: msg });

        await imageQueue.add(async () => {
            let buffer = null;
            if (this.hasMedia(msg, quotedMsg)) {
                buffer = await this.download(sock, msg, quotedMsg, quotedStanza);
            }
            const stickerBuffer = await this.renderMemeSticker(buffer, top, bottom, session.quality || 90);
            await sock.sendMessage(remoteJid, { sticker: stickerBuffer }, { quoted: msg });
            logger.info(`✅ Meme sticker sent to ${remoteJid}`);
        });
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
    },

    async toGif({ sock, msg, remoteJid, quotedMsg, quotedStanza, logger }) {
        if (!quotedMsg?.stickerMessage) {
            return sock.sendMessage(remoteJid, { text: '⚠️ Balas stiker animasi dengan *!togif*' }, { quoted: msg });
        }

        await sock.sendMessage(remoteJid, { text: '⏳ Mengubah stiker animasi ke GIF...' }, { quoted: msg });

        let buffer = await this.download(sock, msg, quotedMsg, quotedStanza);
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
};
