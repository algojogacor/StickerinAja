const sharp = require('sharp');
const crypto = require('crypto');
const { Sticker } = require('wa-sticker-formatter');
const { renderTextOverlaySvg } = require('./svgRenderer');
const { stickerCache, imageQueue } = require('../../utils/cache');

function hasImageTransforms(options = {}) {
    return !!(options.gray || options.invert || options.blur || options.sharpen ||
        options.sepia || options.deepfried || options.glow || options.vintage ||
        options.flip || options.flop || options.rotate ||
        options.removeBg || options.overlayText);
}

async function removeSimpleBackground(buffer, tolerance = 34) {
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
}

async function applyTextOverlay(buffer, text, options = {}) {
    const overlaySvgBuffer = renderTextOverlaySvg(text, options);
    if (!overlaySvgBuffer) return buffer;

    return sharp(buffer)
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .composite([{ input: overlaySvgBuffer, top: 0, left: 0 }])
        .png()
        .toBuffer();
}

async function preprocessImage(buffer, options = {}) {
    let working = buffer;
    if (options.removeBg) {
        working = await removeSimpleBackground(working);
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
    return options.overlayText ? applyTextOverlay(transformed, options.overlayText, options) : transformed;
}

async function createFromMedia({ sock, msg, args, remoteJid, quotedMsg, quotedStanza, session, logger, downloadFn, parseArgsFn, getTypeFn, MAX_FILE_SIZE }) {
    let buffer = await downloadFn(sock, msg, quotedMsg, quotedStanza);
    if (!buffer) return sock.sendMessage(remoteJid, { text: '📸 Balas/kirim foto dengan caption *!s*' }, { quoted: msg });
    if (buffer.length > MAX_FILE_SIZE) {
        return sock.sendMessage(remoteJid, { text: '⚠️ File terlalu besar! Maks 10MB' }, { quoted: msg });
    }

    const parsedArgs = parseArgsFn(args);
    const stickerType = parsedArgs.type || session.type;
    const quality = parsedArgs.quality || session.quality;

    const hash = crypto.createHash('md5').update(buffer).digest('hex');
    const cacheKey = `${stickerType}-${quality}-${JSON.stringify(parsedArgs)}-${hash}`;
    const cached = stickerCache.get(cacheKey);
    if (cached) {
        await sock.sendMessage(remoteJid, { sticker: cached }, { quoted: msg });
        return logger.info(`✅ Sticker (cached) sent to ${remoteJid}`);
    }

    await sock.sendMessage(remoteJid, { text: '⏳ Membuat stiker...' }, { quoted: msg });

    await imageQueue.add(async () => {
        if (hasImageTransforms(parsedArgs)) {
            buffer = await preprocessImage(buffer, parsedArgs);
        }

        const sticker = new Sticker(buffer, {
            pack: session.pack,
            author: session.author,
            type: getTypeFn(stickerType),
            quality,
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        });

        const msgData = await sticker.toMessage();
        stickerCache.set(cacheKey, msgData.sticker);
        await sock.sendMessage(remoteJid, msgData, { quoted: msg });
        session.type = 'default';
        logger.info(`✅ Sticker sent to ${remoteJid}`);
    });
}

module.exports = {
    hasImageTransforms,
    removeSimpleBackground,
    applyTextOverlay,
    preprocessImage,
    createFromMedia
};
