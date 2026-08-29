const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const {
    renderTextToWebP,
    renderTextOverlaySvg,
    renderMemeSticker,
    renderQuoteSticker,
    renderEmojiSticker,
    renderTemplateSticker
} = require('../src/services/sticker/svgRenderer');

const {
    hasImageTransforms,
    removeSimpleBackground
} = require('../src/services/sticker/imageProcessor');

const { generateQrSvg } = require('../src/utils/qrHelper');

describe('Sticker Modular Services & SVG Rendering', () => {
    it('renders text to valid WebP buffer', async () => {
        const buffer = await renderTextToWebP('Halo Dunia Test', { bgColor: '#FFFFFF', textColor: '#000000' });
        assert.ok(Buffer.isBuffer(buffer));
        assert.ok(buffer.length > 100);

        const meta = await sharp(buffer).metadata();
        assert.equal(meta.format, 'webp');
        assert.equal(meta.width, 512);
        assert.equal(meta.height, 512);
    });

    it('renders meme sticker to valid WebP buffer', async () => {
        const buffer = await renderMemeSticker(null, 'TEKS ATAS', 'TEKS BAWAH');
        assert.ok(Buffer.isBuffer(buffer));

        const meta = await sharp(buffer).metadata();
        assert.equal(meta.format, 'webp');
        assert.equal(meta.width, 512);
        assert.equal(meta.height, 512);
    });

    it('renders quote sticker to valid WebP buffer', async () => {
        const buffer = await renderQuoteSticker('Hidup adalah seni', 'Arya');
        assert.ok(Buffer.isBuffer(buffer));

        const meta = await sharp(buffer).metadata();
        assert.equal(meta.format, 'webp');
        assert.equal(meta.width, 512);
        assert.equal(meta.height, 512);
    });

    it('renders emoji sticker to valid WebP buffer', async () => {
        const buffer = await renderEmojiSticker('😂');
        assert.ok(Buffer.isBuffer(buffer));

        const meta = await sharp(buffer).metadata();
        assert.equal(meta.format, 'webp');
        assert.equal(meta.width, 512);
        assert.equal(meta.height, 512);
    });

    it('renders template stickers (warning, label, bubble, poster)', async () => {
        for (const tpl of ['warning', 'label', 'bubble', 'poster']) {
            const buffer = await renderTemplateSticker('Perhatian Penting', tpl);
            assert.ok(Buffer.isBuffer(buffer));

            const meta = await sharp(buffer).metadata();
            assert.equal(meta.format, 'webp');
            assert.equal(meta.width, 512);
            assert.equal(meta.height, 512);
        }
    });

    it('generates standalone vector SVG for QR codes', () => {
        const svg = generateQrSvg('2@test-qr-string-data');
        assert.ok(typeof svg === 'string');
        assert.ok(svg.startsWith('<svg'));
        assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
        assert.ok(svg.includes('<rect'));
        assert.ok(svg.includes('<path'));
    });

    it('detects image transforms correctly', () => {
        assert.equal(hasImageTransforms({}), false);
        assert.equal(hasImageTransforms({ gray: true }), true);
        assert.equal(hasImageTransforms({ blur: 4 }), true);
        assert.equal(hasImageTransforms({ overlayText: 'test' }), true);
    });
});
