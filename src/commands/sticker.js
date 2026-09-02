const sharp = require('sharp');
const path = require('path');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

const {
    renderTextToWebP,
    renderMemeSticker,
    renderQuoteSticker,
    renderEmojiSticker,
    renderTemplateSticker
} = require('../services/sticker/svgRenderer');

const {
    createFromMedia
} = require('../services/sticker/imageProcessor');

const {
    createAnimated
} = require('../services/sticker/animatedProcessor');

const {
    stickerInfo,
    toImage,
    toGif,
    toMp4
} = require('../services/sticker/converterService');

const { textStickerCache, imageQueue } = require('../utils/cache');
const { addExifToWebp } = require('../utils/exifHelper');

const TEMP_DIR = path.join(__dirname, '../../temp');
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '10485760');
const ANIMATED_STICKER_TARGET_BYTES = parseInt(process.env.ANIMATED_STICKER_TARGET_BYTES || '950000');

module.exports = {
    names: [
        's', 'sticker', 'stiker', 'sgif', 'stickergif', 'stikergif',
        'scircle', 'scrop', 'srounded',
        'svintage', 'smono', 'sdeepfried', 'sglow',
        'meme', 'smeme', 'stext',
        'quote', 'squote', 'emoji', 'semoji',
        'label', 'warning', 'bubble', 'poster',
        'sinfo', 'stickerinfo',
        'toimg', 'togif', 'tomp4'
    ],

    async execute({ sock, msg, args, cmdName, remoteJid, quotedMsg, quotedStanza, session, logger, PREFIX }) {
        // ─── Format Converters ───
        if (cmdName === 'toimg') {
            return toImage({ sock, msg, remoteJid, quotedMsg, quotedStanza, logger, downloadFn: this.download, TEMP_DIR });
        }
        if (cmdName === 'togif') {
            return toGif({ sock, msg, remoteJid, quotedMsg, quotedStanza, logger, downloadFn: this.download, TEMP_DIR });
        }
        if (cmdName === 'tomp4') {
            return toMp4({ sock, msg, remoteJid, quotedMsg, quotedStanza, logger, downloadFn: this.download, TEMP_DIR });
        }
        if (['sinfo', 'stickerinfo'].includes(cmdName)) {
            return stickerInfo({ sock, msg, remoteJid, quotedMsg, quotedStanza, logger, downloadFn: this.download, TEMP_DIR });
        }

        // ─── Meme, Quote, Emoji, and Template Cards ───
        if (['meme', 'smeme'].includes(cmdName)) {
            // Smart routing: if user typed !meme <keyword> WITHOUT replying to any media and WITHOUT '|':
            // they want to search for a meme on Reddit, not make a blank text box sticker!
            const text = args.join(' ').trim();
            if (cmdName === 'meme' && !this.hasMedia(msg, quotedMsg) && text && !text.includes('|')) {
                const redditCmd = require('./reddit');
                return redditCmd.handleSearch(text, sock, msg, remoteJid, logger);
            }
            return this.createMeme({ sock, msg, args, remoteJid, quotedMsg, quotedStanza, session, logger });
        }
        if (['quote', 'squote'].includes(cmdName)) {
            return this.createQuote({ sock, msg, args, remoteJid, quotedMsg, session, logger });
        }
        if (['emoji', 'semoji'].includes(cmdName)) {
            return this.createEmoji({ sock, msg, args, remoteJid, session, logger });
        }
        if (['label', 'warning', 'bubble', 'poster'].includes(cmdName)) {
            return this.createTemplateText({ sock, msg, args, cmdName, remoteJid, session, logger });
        }

        // ─── Presets & Shortcuts ───
        const presetArgs = this.getPresetArgs(cmdName);
        if (presetArgs) {
            return createFromMedia({
                sock, msg, args: [...presetArgs, ...args], remoteJid, quotedMsg, quotedStanza, session, logger,
                downloadFn: this.download, parseArgsFn: this.parseArgs, MAX_FILE_SIZE
            });
        }

        const shortcutCmds = ['scircle', 'scrop', 'srounded'];
        if (shortcutCmds.includes(cmdName)) {
            return createFromMedia({
                sock, msg, args, remoteJid, quotedMsg, quotedStanza, session, logger,
                downloadFn: this.download, parseArgsFn: this.parseArgs, MAX_FILE_SIZE
            });
        }

        // ─── Animated Video Sticker ───
        const gifCmds = ['sgif', 'stickergif', 'stikergif'];
        if (gifCmds.includes(cmdName)) {
            // If user typed !sgif <keyword> without quoting/attaching media, route to GIPHY sticker search
            if (args.length > 0 && !this.hasMedia(msg, quotedMsg)) {
                const { handleGiphySearch } = require('./reddit');
                const query = args.join(' ').trim();
                return handleGiphySearch(query, 'stickers', sock, msg, remoteJid, logger);
            }

            if (!this.hasMedia(msg, quotedMsg)) {
                return sock.sendMessage(remoteJid, {
                    text: '🎬 Balas video/GIF dengan *!sgif*, atau ketik *!sgif <kata kunci>* untuk cari stiker transparan.'
                }, { quoted: msg });
            }

            return createAnimated({
                sock, msg, args, remoteJid, quotedMsg, quotedStanza, session, logger,
                downloadFn: this.download, parseArgsFn: this.parseArgs, MAX_FILE_SIZE
            });
        }

        // ─── Text / Emoji Sticker ───
        const text = args.join(' ').trim();
        if (text && !this.hasMedia(msg, quotedMsg)) {
            // If the text is purely emoji (e.g. !s 🪔 or !s 😂), route to high-res emoji sticker!
            const stripped = text.replace(/\s+/g, '');
            if (/^\p{Extended_Pictographic}+$/u.test(stripped)) {
                return this.createEmoji({ sock, msg, args, remoteJid, session, logger });
            }
            return this.createFromText({ sock, msg, text, remoteJid, session, logger });
        }

        // ─── Default Media Sticker ───
        const unwrapMsg = (m) => m?.ephemeralMessage?.message ||
            m?.viewOnceMessage?.message ||
            m?.viewOnceMessageV2?.message ||
            m?.documentWithCaptionMessage?.message ||
            m;

        const directM = unwrapMsg(msg.message);
        const quotedM = unwrapMsg(quotedMsg);

        const isVideo = !!(directM?.videoMessage || quotedM?.videoMessage);

        if (isVideo) {
            await createAnimated({
                sock, msg, args, remoteJid, quotedMsg, quotedStanza, session, logger,
                downloadFn: this.download, parseArgsFn: this.parseArgs, MAX_FILE_SIZE
            });
        } else {
            await createFromMedia({
                sock, msg, args, remoteJid, quotedMsg, quotedStanza, session, logger,
                downloadFn: this.download, parseArgsFn: this.parseArgs, MAX_FILE_SIZE
            });
        }
    },

    async download(sock, msg, quotedMsg, quotedStanza) {
        try {
            if (quotedMsg) {
                const contextInfo =
                    msg.message?.extendedTextMessage?.contextInfo ||
                    msg.message?.imageMessage?.contextInfo ||
                    msg.message?.videoMessage?.contextInfo ||
                    msg.message?.documentMessage?.contextInfo;

                const participant = contextInfo?.participant || msg.key.participant || msg.key.remoteJid;
                return await downloadMediaMessage(
                    {
                        key: {
                            id: quotedStanza,
                            remoteJid: msg.key.remoteJid,
                            fromMe: Boolean(contextInfo?.participant ? false : msg.key.fromMe),
                            participant
                        },
                        message: quotedMsg
                    },
                    'buffer',
                    {},
                    { logger: console }
                );
            }
            return await downloadMediaMessage(msg, 'buffer', {}, { logger: console });
        } catch (err) {
            console.error('[Download error]', err);
            return null;
        }
    },

    hasMedia(msg, quotedMsg) {
        const unwrapMsg = (m) => m?.ephemeralMessage?.message ||
            m?.viewOnceMessage?.message ||
            m?.viewOnceMessageV2?.message ||
            m?.documentWithCaptionMessage?.message ||
            m;
        const directM = unwrapMsg(msg?.message);
        const quotedM = unwrapMsg(quotedMsg);
        return !!(directM?.imageMessage || directM?.videoMessage || directM?.stickerMessage ||
            quotedM?.imageMessage || quotedM?.videoMessage || quotedM?.stickerMessage);
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

    extractTextFromMessage(message) {
        return message?.conversation ||
            message?.extendedTextMessage?.text ||
            message?.imageMessage?.caption ||
            message?.videoMessage?.caption ||
            message?.documentMessage?.caption ||
            '';
    },

    async createFromText({ sock, msg, text, remoteJid, session, logger }) {
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
        const textCacheKey = `${displayText}-${bgColor}-${session.quality}`;
        const cachedText = textStickerCache.get(textCacheKey);
        if (cachedText) {
            await sock.sendMessage(remoteJid, { sticker: cachedText }, { quoted: msg });
            return logger.info(`✅ Text sticker (cached) sent: "${displayText.slice(0, 30)}..."`);
        }

        await sock.sendMessage(remoteJid, { text: '⏳ Membuat stiker teks...' }, { quoted: msg });

        await imageQueue.add(async () => {
            const imgBuffer = await renderTextToWebP(displayText, {
                bgColor,
                textColor,
                quality: session.quality || 90
            });

            const stickerWithExif = addExifToWebp(imgBuffer, session?.pack, session?.author);
            await sock.sendMessage(remoteJid, { sticker: stickerWithExif }, { quoted: msg });
            textStickerCache.set(textCacheKey, stickerWithExif);
            logger.info(`✅ Text sticker with EXIF sent: "${displayText.slice(0, 30)}..."`);
        });
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
            const stickerBuffer = await renderMemeSticker(buffer, top, bottom, session.quality || 90);
            const stickerWithExif = addExifToWebp(stickerBuffer, session?.pack, session?.author);
            await sock.sendMessage(remoteJid, { sticker: stickerWithExif }, { quoted: msg });
            logger.info(`✅ Meme sticker with EXIF sent to ${remoteJid}`);
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
            const stickerBuffer = await renderQuoteSticker(text, session.author, session.quality || 90);
            const stickerWithExif = addExifToWebp(stickerBuffer, session?.pack, session?.author);
            await sock.sendMessage(remoteJid, { sticker: stickerWithExif }, { quoted: msg });
            logger.info(`✅ Quote sticker with EXIF sent to ${remoteJid}`);
        });
    },

    async createEmoji({ sock, msg, args, remoteJid, session, logger }) {
        const emoji = args.join(' ').trim();
        if (!emoji) {
            return sock.sendMessage(remoteJid, { text: 'Gunakan: *!emoji 😂*' }, { quoted: msg });
        }

        await sock.sendMessage(remoteJid, { text: '⏳ Membuat stiker emoji...' }, { quoted: msg });

        await imageQueue.add(async () => {
            const stickerBuffer = await renderEmojiSticker(Array.from(emoji).slice(0, 4).join(''), session.quality || 90);
            const stickerWithExif = addExifToWebp(stickerBuffer, session?.pack, session?.author);
            await sock.sendMessage(remoteJid, { sticker: stickerWithExif }, { quoted: msg });
            logger.info(`✅ Emoji sticker with EXIF sent to ${remoteJid}`);
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
            const stickerBuffer = await renderTemplateSticker(text, cmdName, session.quality || 90);
            const stickerWithExif = addExifToWebp(stickerBuffer, session?.pack, session?.author);
            await sock.sendMessage(remoteJid, { sticker: stickerWithExif }, { quoted: msg });
            logger.info(`✅ ${cmdName} sticker with EXIF sent to ${remoteJid}`);
        });
    }
};
