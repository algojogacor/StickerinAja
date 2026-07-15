const { createCanvas, loadImage } = require('canvas');
const sharp = require('sharp');
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
const ANIMATED_STICKER_TARGET_BYTES = parseInt(process.env.ANIMATED_STICKER_TARGET_BYTES || '950000');

module.exports = {
    names: ['s', 'sticker', 'stiker', 'sgif', 'stickergif', 'stikergif',
            'scircle', 'scrop', 'srounded',
            'svintage', 'smono', 'sdeepfried', 'sglow',
            'meme', 'smeme', 'stext',
            'quote', 'squote', 'emoji', 'semoji',
            'label', 'warning', 'bubble', 'poster',
            'sinfo', 'stickerinfo',
            'toimg', 'togif', 'tomp4'],

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

        if (cmdName === 'tomp4') {
            return await this.toMp4({ sock, msg, remoteJid, quotedMsg, quotedStanza, logger });
        }

        if (['sinfo', 'stickerinfo'].includes(cmdName)) {
            return await this.stickerInfo({ sock, msg, remoteJid, quotedMsg, quotedStanza, logger });
        }

        if (['meme', 'smeme'].includes(cmdName)) {
            return await this.createMeme({ sock, msg, args, remoteJid, quotedMsg, quotedStanza, session, logger });
        }

        if (['quote', 'squote'].includes(cmdName)) {
            return await this.createQuote({ sock, msg, args, remoteJid, quotedMsg, session, logger });
        }

        if (['emoji', 'semoji'].includes(cmdName)) {
            return await this.createEmoji({ sock, msg, args, remoteJid, session, logger });
        }

        if (['label', 'warning', 'bubble', 'poster'].includes(cmdName)) {
            return await this.createTemplateText({ sock, msg, args, cmdName, remoteJid, session, logger });
        }

        const presetArgs = this.getPresetArgs(cmdName);
        if (presetArgs) {
            return await this.createFromMedia({
                sock, msg, args: [...presetArgs, ...args], remoteJid, quotedMsg, quotedStanza, session, logger
            });
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
            else if (['--deepfried'].includes(a)) result.deepfried = true;
            else if (['--glow'].includes(a)) result.glow = true;
            else if (['--vintage'].includes(a)) result.vintage = true;
            else if (['--flip'].includes(a)) result.flip = true;
            else if (['--flop', '--mirror'].includes(a)) result.flop = true;
            else if (['--top'].includes(a)) result.textPosition = 'top';
            else if (['--center', '--middle'].includes(a)) result.textPosition = 'center';
            else if (['--bottom'].includes(a)) result.textPosition = 'bottom';
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
            else if (['--color', '--textcolor'].includes(a) && args[i + 1]) {
                const color = args[++i];
                if (/^#[0-9a-fA-F]{6,8}$/.test(color)) result.textColor = color;
            }
            else if (['--stroke', '--outline'].includes(a) && args[i + 1]) {
                const color = args[++i];
                if (/^#[0-9a-fA-F]{6,8}$/.test(color)) result.strokeColor = color;
            }
            else if (['--size', '--fontsize'].includes(a) && args[i + 1]) {
                const size = parseInt(args[++i]);
                if (!isNaN(size)) result.fontSize = Math.min(Math.max(size, 20), 92);
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
            options.sepia || options.deepfried || options.glow || options.vintage ||
            options.flip || options.flop || options.rotate ||
            options.removeBg || options.overlayText);
    },

    getPresetArgs(cmdName) {
        const presets = {
            svintage: ['--vintage'],
            smono: ['--gray', '--sharpen'],
            sdeepfried: ['--deepfried'],
            sglow: ['--glow']
        };
        return presets[cmdName] || null;
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
        let startY = y;
        if (options.align === 'bottom') {
            startY = y - totalHeight + lineHeight;
        } else if (options.align === 'center') {
            startY = y - totalHeight / 2 + lineHeight / 2;
        }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(5, Math.floor(fontSize / 6));
        ctx.strokeStyle = options.strokeColor || '#111111';
        ctx.fillStyle = options.textColor || '#ffffff';

        for (let i = 0; i < lines.length; i++) {
            const lineY = startY + i * lineHeight;
            ctx.strokeText(lines[i], W / 2, lineY);
            ctx.fillText(lines[i], W / 2, lineY);
        }
    },

    getTextOverlayPlacement(options = {}) {
        const position = options.textPosition || 'bottom';
        if (position === 'top') return { y: 58, align: 'top' };
        if (position === 'center') return { y: 256, align: 'center' };
        return { y: 448, align: 'bottom' };
    },

    renderTextOverlayPng(text, options = {}) {
        const canvas = createCanvas(512, 512);
        const ctx = canvas.getContext('2d');
        const placement = this.getTextOverlayPlacement(options);
        this.drawStickerText(ctx, text, placement.y, {
            align: placement.align,
            fontSize: options.fontSize || 36,
            textColor: options.textColor,
            strokeColor: options.strokeColor
        });
        return canvas.toBuffer('image/png');
    },

    async applyTextOverlay(buffer, text, options = {}) {
        const base = await sharp(buffer)
            .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer();
        const canvas = createCanvas(512, 512);
        const ctx = canvas.getContext('2d');
        const img = await loadImage(base);
        ctx.drawImage(img, 0, 0, 512, 512);
        const overlay = await loadImage(this.renderTextOverlayPng(text, options));
        ctx.drawImage(overlay, 0, 0, 512, 512);
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

    extractTextFromMessage(message) {
        return message?.conversation ||
            message?.extendedTextMessage?.text ||
            message?.imageMessage?.caption ||
            message?.videoMessage?.caption ||
            message?.documentMessage?.caption ||
            '';
    },

    fillWrappedText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 8) {
        const lines = this.wrapCanvasText(ctx, text, maxWidth).slice(0, maxLines);
        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], x, y + i * lineHeight);
        }
        return lines.length * lineHeight;
    },

    roundedRect(ctx, x, y, width, height, radius) {
        const r = Math.min(radius, width / 2, height / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + width, y, x + width, y + height, r);
        ctx.arcTo(x + width, y + height, x, y + height, r);
        ctx.arcTo(x, y + height, x, y, r);
        ctx.arcTo(x, y, x + width, y, r);
        ctx.closePath();
    },

    canvasToWebp(canvas, quality = 90) {
        const rawBuffer = canvas.toBuffer('raw');
        return sharp(rawBuffer, { raw: { width: 512, height: 512, channels: 4 } })
            .webp({ quality })
            .toBuffer();
    },

    async renderQuoteSticker(text, author = '', quality = 90) {
        const canvas = createCanvas(512, 512);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, 512, 512);
        ctx.fillStyle = '#22c55e';
        this.roundedRect(ctx, 34, 56, 444, 360, 26);
        ctx.fill();
        ctx.fillStyle = '#111827';
        this.roundedRect(ctx, 46, 68, 420, 336, 20);
        ctx.fill();

        ctx.fillStyle = '#e5e7eb';
        ctx.font = 'bold 34px Arial, Helvetica, sans-serif';
        ctx.textBaseline = 'top';
        this.fillWrappedText(ctx, text, 72, 116, 368, 42, 6);

        ctx.fillStyle = '#94a3b8';
        ctx.font = '24px Arial, Helvetica, sans-serif';
        const footer = author ? `- ${author}` : '- quoted sticker';
        ctx.fillText(footer.slice(0, 34), 72, 358);
        return this.canvasToWebp(canvas, quality);
    },

    async renderEmojiSticker(emoji, quality = 90) {
        const canvas = createCanvas(512, 512);
        const ctx = canvas.getContext('2d');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '300px "Segoe UI Emoji", "Noto Color Emoji", Arial, sans-serif';
        ctx.fillText(emoji, 256, 260);
        return this.canvasToWebp(canvas, quality);
    },

    async renderTemplateSticker(text, template, quality = 90) {
        const canvas = createCanvas(512, 512);
        const ctx = canvas.getContext('2d');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const styles = {
            label: { bg: '#111827', fg: '#f9fafb', accent: '#38bdf8', size: 48 },
            warning: { bg: '#facc15', fg: '#111827', accent: '#111827', size: 44 },
            bubble: { bg: '#dcfce7', fg: '#14532d', accent: '#22c55e', size: 40 },
            poster: { bg: '#1d4ed8', fg: '#ffffff', accent: '#f97316', size: 54 }
        };
        const style = styles[template] || styles.label;

        ctx.fillStyle = style.bg;
        ctx.fillRect(0, 0, 512, 512);
        ctx.fillStyle = style.accent;
        this.roundedRect(ctx, 38, 54, 436, 404, template === 'poster' ? 8 : 28);
        ctx.fill();
        ctx.fillStyle = template === 'warning' ? '#fef3c7' : '#0f172a';
        this.roundedRect(ctx, 52, 68, 408, 376, template === 'poster' ? 4 : 22);
        ctx.fill();

        if (template === 'warning') {
            ctx.fillStyle = style.accent;
            ctx.font = 'bold 58px Arial, Helvetica, sans-serif';
            ctx.fillText('!', 256, 122);
        }

        ctx.fillStyle = template === 'warning' ? style.fg : style.fg;
        ctx.font = `bold ${style.size}px Arial, Helvetica, sans-serif`;
        const lines = this.wrapCanvasText(ctx, text, 350).slice(0, 6);
        const lineHeight = style.size * 1.12;
        const startY = 256 - ((lines.length - 1) * lineHeight) / 2;
        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], 256, startY + i * lineHeight);
        }

        return this.canvasToWebp(canvas, quality);
    },

    getMediaKind(message) {
        if (message?.stickerMessage) return 'sticker';
        if (message?.imageMessage) return 'image';
        if (message?.videoMessage) return message.videoMessage.gifPlayback ? 'gif/video' : 'video';
        return 'unknown';
    },

    formatBytes(bytes) {
        if (!Number.isFinite(bytes)) return '-';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    },

    async ffprobeFile(filePath) {
        return new Promise((resolve) => {
            ffmpeg.ffprobe(filePath, (err, data) => resolve(err ? null : data));
        });
    },

    clampNumber(value, min, max, fallback) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.min(Math.max(number, min), max);
    },

    getAnimatedEncodeAttempts(parsedArgs, session) {
        const baseFps = this.clampNumber(parsedArgs.fps, 6, 24, 15);
        const baseQuality = this.clampNumber(parsedArgs.quality || session.quality, 1, 100, 80);
        const baseDuration = this.clampNumber(parsedArgs.duration, 1, 10, 10);
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
    },

    async encodeAnimatedSticker({ inputPath, outputPath, overlayPath, parsedArgs, attempt }) {
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
        if (options.vintage) {
            image = image.modulate({ saturation: 0.82, brightness: 1.04 }).tint('#f0c27b').sharpen();
        }
        if (options.deepfried) {
            image = image.modulate({ saturation: 3, brightness: 1.18 }).linear(1.35, -25).sharpen({ sigma: 2 });
        }
        if (options.glow) {
            image = image.modulate({ saturation: 1.35, brightness: 1.12 }).sharpen();
        }
        if (options.sepia) {
            image = image.recomb([
                [0.3588, 0.5889, 0.0913],
                [0.2990, 0.5870, 0.1140],
                [0.2392, 0.4696, 0.0913]
            ]);
        }

        const transformed = await image.png().toBuffer();
        return options.overlayText ? this.applyTextOverlay(transformed, options.overlayText, options) : transformed;
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
            const tempOverlay = path.join(TEMP_DIR, `overlay_${time}.png`);
            const tempOutputs = [];
            // ⚡ Async I/O — avoids blocking event loop on large video buffers
            await fs.promises.writeFile(tempInput, buffer);
            // ⚡ Release source buffer (~up to 10MB) before heavy FFmpeg processing
            buffer = null;

            try {
                if (parsedArgs.overlayText) {
                    await fs.promises.writeFile(tempOverlay, this.renderTextOverlayPng(parsedArgs.overlayText, parsedArgs));
                }

                const attempts = this.getAnimatedEncodeAttempts(parsedArgs, session);
                let bestResult = null;

                for (let i = 0; i < attempts.length; i++) {
                    const attempt = attempts[i];
                    const tempOutput = path.join(TEMP_DIR, `sticker_${time}_${i}.webp`);
                    tempOutputs.push(tempOutput);

                    await this.encodeAnimatedSticker({
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

                // ⚡ Async read — keeps event loop free while reading output
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

    async createQuote({ sock, msg, args, remoteJid, quotedMsg, session, logger }) {
        const text = args.join(' ').trim() || this.extractTextFromMessage(quotedMsg);
        if (!text) {
            return sock.sendMessage(remoteJid, {
                text: 'Gunakan: *!quote <teks>* atau reply pesan teks lalu ketik *!quote*.'
            }, { quoted: msg });
        }

        await imageQueue.add(async () => {
            const stickerBuffer = await this.renderQuoteSticker(text, session.author, session.quality || 90);
            await sock.sendMessage(remoteJid, { sticker: stickerBuffer }, { quoted: msg });
            logger.info(`✅ Quote sticker sent to ${remoteJid}`);
        });
    },

    async createEmoji({ sock, msg, args, remoteJid, session, logger }) {
        const emoji = args.join(' ').trim();
        if (!emoji) {
            return sock.sendMessage(remoteJid, { text: 'Gunakan: *!emoji 😂*' }, { quoted: msg });
        }

        await imageQueue.add(async () => {
            const stickerBuffer = await this.renderEmojiSticker(Array.from(emoji).slice(0, 4).join(''), session.quality || 90);
            await sock.sendMessage(remoteJid, { sticker: stickerBuffer }, { quoted: msg });
            logger.info(`✅ Emoji sticker sent to ${remoteJid}`);
        });
    },

    async createTemplateText({ sock, msg, args, cmdName, remoteJid, session, logger }) {
        const text = args.join(' ').trim();
        if (!text) {
            return sock.sendMessage(remoteJid, {
                text: `Gunakan: *!${cmdName} <teks>*`
            }, { quoted: msg });
        }

        await imageQueue.add(async () => {
            const stickerBuffer = await this.renderTemplateSticker(text, cmdName, session.quality || 90);
            await sock.sendMessage(remoteJid, { sticker: stickerBuffer }, { quoted: msg });
            logger.info(`✅ ${cmdName} sticker sent to ${remoteJid}`);
        });
    },

    async stickerInfo({ sock, msg, remoteJid, quotedMsg, quotedStanza, logger }) {
        const target = quotedMsg || msg.message;
        const kind = this.getMediaKind(target);
        if (kind === 'unknown') {
            return sock.sendMessage(remoteJid, { text: 'Reply gambar/video/GIF/stiker lalu ketik *!sinfo*.' }, { quoted: msg });
        }

        let buffer = await this.download(sock, msg, quotedMsg, quotedStanza);
        if (!buffer) return sock.sendMessage(remoteJid, { text: '❌ Gagal download media.' }, { quoted: msg });

        const lines = [
            '*Info Media/Stiker*',
            `Jenis: ${kind}`,
            `Ukuran file: ${this.formatBytes(buffer.length)}`
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
                const probe = await this.ffprobeFile(tempInput);
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
    },

    async toMp4({ sock, msg, remoteJid, quotedMsg, quotedStanza, logger }) {
        if (!quotedMsg?.stickerMessage) {
            return sock.sendMessage(remoteJid, { text: '⚠️ Balas stiker animasi dengan *!tomp4*' }, { quoted: msg });
        }

        await sock.sendMessage(remoteJid, { text: '⏳ Mengubah stiker animasi ke MP4...' }, { quoted: msg });

        let buffer = await this.download(sock, msg, quotedMsg, quotedStanza);
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
};
