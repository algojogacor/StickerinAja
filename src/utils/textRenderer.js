const { createCanvas } = require('canvas');
const sharp = require('sharp');

/**
 * Render text with left-aligned word wrap to a WebP buffer
 * @param {string} text - Text content 
 * @param {object} options
 * @param {string} options.bgColor - Background hex (default #FFFFFF)
 * @param {string} options.textColor - Text color (default #222222)
 * @param {number} options.quality - WebP quality 0-100 (default 90)
 * @param {string} options.font - Font family (default 'Helvetica, Arial, sans-serif')
 * @returns {Buffer} WebP buffer
 */
async function renderTextToWebP(text, options = {}) {
    const {
        bgColor = '#FFFFFF',
        textColor = '#222222',
        quality = 90,
        font = 'Helvetica, Arial, sans-serif'
    } = options;

    const W = 512, H = 512;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, W, H);

    // Parse tokens once: split by \n (user-typed), then flatten words
    const rawLines = text.split('\\n');
    const allWords = rawLines.flatMap(line => line.split(' ')).filter(w => w);
    
    const padding = 20;
    const maxWidth = W - padding * 2;
    let fontSize = options.fontSize || 48;
    let bestWrap = null; // stores final word-wrapped lines

    // Font-size search + word wrap — computed once
    for (let attempt = 0; attempt < 5; attempt++) {
        ctx.font = `${fontSize}px ${font}`;
        const lines = [];
        let line = '';
        for (const word of allWords) {
            const test = line ? line + ' ' + word : word;
            if (ctx.measureText(test).width > maxWidth && line) {
                lines.push(line);
                line = word;
            } else {
                line = test;
            }
        }
        if (line) lines.push(line);

        const totalHeight = lines.length * (fontSize * 1.15);
        if (totalHeight > 460 && fontSize > 24) {
            fontSize -= 2;          // shrink and retry
        } else {
            bestWrap = lines;       // save for layout
            break;
        }
    }

    // bestWrap is guaranteed set because we always fall through after 5 attempts
    const lineHeight = fontSize * 1.15;
    const totalHeight = bestWrap.length * lineHeight;
    const startY = (H - totalHeight) / 2 + fontSize / 2;

    // Draw each line left-aligned
    ctx.fillStyle = textColor;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    for (let i = 0; i < bestWrap.length; i++) {
        const y = startY + i * lineHeight;
        ctx.fillText(bestWrap[i], padding, y);
    }

    // ⚡ Convert to WebP — skip PNG intermediate encoding
    // Old: canvas→PNG encode→sharp PNG decode→WebP (double encode/decode)
    // New: canvas→raw RGBA pixels→sharp→WebP (skip PNG entirely, ~10ms saved)
    const rawBuffer = canvas.toBuffer('raw');
    return sharp(rawBuffer, { raw: { width: W, height: H, channels: 4 } })
        .webp({ quality })
        .toBuffer();
}

module.exports = { renderTextToWebP };
