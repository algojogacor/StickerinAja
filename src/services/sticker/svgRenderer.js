const sharp = require('sharp');

/**
 * Escape XML/SVG special characters
 */
function escapeXml(unsafe = '') {
    return String(unsafe)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Estimate text width in pixels based on average character aspect ratio
 */
function estimateTextWidth(text, fontSize) {
    // Average proportional font character width is approximately 0.58 of font size
    return text.length * fontSize * 0.58;
}

/**
 * Wrap text into multiple lines for SVG rendering
 */
function wrapSvgText(text, maxWidth, fontSize) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let currentLine = '';

    for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        if (estimateTextWidth(testLine, fontSize) > maxWidth && currentLine) {
            lines.push(currentLine);
            currentLine = word;
        } else {
            currentLine = testLine;
        }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
}

/**
 * Render plain text with background to WebP buffer
 */
async function renderTextToWebP(text, options = {}) {
    const {
        bgColor = '#FFFFFF',
        textColor = '#222222',
        quality = 90,
        font = 'Arial, Helvetica, sans-serif'
    } = options;

    const W = 512;
    const H = 512;
    const padding = 24;
    const maxWidth = W - padding * 2;

    const rawLines = String(text).split(/\\n|\n/);
    const allWords = rawLines.flatMap(line => line.split(' ')).filter(Boolean);

    let fontSize = options.fontSize || 48;
    let bestWrap = [];

    for (let attempt = 0; attempt < 5; attempt++) {
        const lines = [];
        let currentLine = '';
        for (const word of allWords) {
            const testLine = currentLine ? `${currentLine} ${word}` : word;
            if (estimateTextWidth(testLine, fontSize) > maxWidth && currentLine) {
                lines.push(currentLine);
                currentLine = word;
            } else {
                currentLine = testLine;
            }
        }
        if (currentLine) lines.push(currentLine);

        const totalHeight = lines.length * (fontSize * 1.2);
        if (totalHeight > 460 && fontSize > 24) {
            fontSize -= 4;
        } else {
            bestWrap = lines;
            break;
        }
    }

    if (bestWrap.length === 0) bestWrap = [String(text)];

    const lineHeight = fontSize * 1.2;
    const totalHeight = bestWrap.length * lineHeight;
    const startY = (H - totalHeight) / 2 + fontSize * 0.9;

    const textElements = bestWrap.map((line, idx) => {
        const y = startY + idx * lineHeight;
        return `<text x="${padding}" y="${y}" font-family="${font}" font-size="${fontSize}px" font-weight="bold" fill="${textColor}">${escapeXml(line)}</text>`;
    }).join('\n');

    const svg = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${W}" height="${H}" fill="${bgColor}" rx="16"/>
        ${textElements}
    </svg>
    `;

    return sharp(Buffer.from(svg))
        .webp({ quality })
        .toBuffer();
}

/**
 * Render text overlay (top/center/bottom) with stroke outline as SVG buffer
 */
function renderTextOverlaySvg(text, options = {}) {
    if (!text) return null;
    const W = 512;
    const H = 512;
    const position = options.textPosition || 'bottom';
    const textColor = options.textColor || '#ffffff';
    const strokeColor = options.strokeColor || '#111111';

    let fontSize = options.fontSize || (position === 'center' ? 44 : 38);
    const maxWidth = W - 48;
    const lines = wrapSvgText(text.toUpperCase(), maxWidth, fontSize).slice(0, 4);
    const lineHeight = fontSize * 1.15;
    const totalHeight = lines.length * lineHeight;

    let startY = 440 - totalHeight + lineHeight;
    if (position === 'top') {
        startY = 60 + lineHeight / 2;
    } else if (position === 'center') {
        startY = (H - totalHeight) / 2 + lineHeight;
    }

    const strokeWidth = Math.max(4, Math.floor(fontSize / 6));

    const textElements = lines.map((line, idx) => {
        const y = startY + idx * lineHeight;
        return `<text x="${W / 2}" y="${y}" text-anchor="middle" dominant-baseline="central"
            font-family="Arial, Impact, sans-serif" font-weight="900" font-size="${fontSize}px"
            fill="${textColor}" stroke="${strokeColor}" stroke-width="${strokeWidth}px" stroke-linejoin="round"
            paint-order="stroke fill">${escapeXml(line)}</text>`;
    }).join('\n');

    const svg = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        ${textElements}
    </svg>
    `;

    return Buffer.from(svg);
}

/**
 * Render Meme sticker (with image or pure text meme)
 */
async function renderMemeSticker(buffer, top = '', bottom = '', quality = 90) {
    const W = 512;
    const H = 512;

    const renderMemeLine = (text, yPos, baseline = 'hanging') => {
        if (!text) return '';
        const lines = wrapSvgText(text.toUpperCase(), W - 40, 42).slice(0, 3);
        const fontSize = 40;
        const lineHeight = fontSize * 1.15;
        return lines.map((l, i) => {
            const y = yPos + i * lineHeight;
            return `<text x="${W / 2}" y="${y}" text-anchor="middle" dominant-baseline="${baseline}"
                font-family="Arial, Impact, sans-serif" font-weight="900" font-size="${fontSize}px"
                fill="#ffffff" stroke="#000000" stroke-width="6px" stroke-linejoin="round"
                paint-order="stroke fill">${escapeXml(l)}</text>`;
        }).join('\n');
    };

    const topSvg = renderMemeLine(top, 24, 'hanging');
    const bottomLines = wrapSvgText((bottom || '').toUpperCase(), W - 40, 42).slice(0, 3);
    const bottomStartY = H - 24 - (bottomLines.length * 40 * 1.15);
    const bottomSvg = renderMemeLine(bottom, bottomStartY, 'hanging');

    const svgOverlay = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        ${topSvg}
        ${bottomSvg}
    </svg>
    `;

    if (buffer) {
        return sharp(buffer)
            .resize(W, H, { fit: 'cover' })
            .composite([{ input: Buffer.from(svgOverlay), top: 0, left: 0 }])
            .webp({ quality })
            .toBuffer();
    }

    // No background image — white background
    const fullSvg = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${W}" height="${H}" fill="#ffffff"/>
        ${topSvg}
        ${bottomSvg}
    </svg>
    `;

    return sharp(Buffer.from(fullSvg))
        .webp({ quality })
        .toBuffer();
}

/**
 * Render Quote sticker
 */
async function renderQuoteSticker(text, author = '', quality = 90) {
    const W = 512;
    const H = 512;
    const lines = wrapSvgText(text, 360, 32).slice(0, 6);
    const lineHeight = 38;
    const startY = 130;

    const textElements = lines.map((l, i) => {
        return `<text x="72" y="${startY + i * lineHeight}" font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="30px" fill="#e5e7eb">${escapeXml(l)}</text>`;
    }).join('\n');

    const authorText = author ? `- ${author}` : '- quoted sticker';

    const svg = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${W}" height="${H}" fill="#0f172a" rx="20"/>
        <rect x="34" y="56" width="444" height="360" rx="26" fill="#22c55e"/>
        <rect x="46" y="68" width="420" height="336" rx="20" fill="#111827"/>
        ${textElements}
        <text x="72" y="360" font-family="Arial, Helvetica, sans-serif" font-size="22px" fill="#94a3b8">${escapeXml(authorText.slice(0, 34))}</text>
    </svg>
    `;

    return sharp(Buffer.from(svg))
        .webp({ quality })
        .toBuffer();
}

/**
 * Render Emoji sticker
 */
async function renderEmojiSticker(emoji, quality = 90) {
    const W = 512;
    const H = 512;

    const svg = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        <text x="256" y="320" text-anchor="middle" font-size="260px" font-family="'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif">${escapeXml(emoji)}</text>
    </svg>
    `;

    return sharp(Buffer.from(svg))
        .webp({ quality })
        .toBuffer();
}

/**
 * Render Template Banner / Label / Warning / Poster sticker
 */
async function renderTemplateSticker(text, template = 'label', quality = 90) {
    const W = 512;
    const H = 512;

    const styles = {
        label: { bg: '#111827', fg: '#f9fafb', accent: '#38bdf8', size: 44 },
        warning: { bg: '#facc15', fg: '#111827', accent: '#111827', size: 40 },
        bubble: { bg: '#dcfce7', fg: '#14532d', accent: '#22c55e', size: 38 },
        poster: { bg: '#1d4ed8', fg: '#ffffff', accent: '#f97316', size: 48 }
    };
    const style = styles[template] || styles.label;
    const lines = wrapSvgText(text, 360, style.size).slice(0, 5);
    const lineHeight = style.size * 1.2;
    const startY = 256 - ((lines.length - 1) * lineHeight) / 2;

    const textElements = lines.map((l, i) => {
        return `<text x="256" y="${startY + i * lineHeight}" text-anchor="middle" dominant-baseline="central"
            font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="${style.size}px" fill="${style.fg}">${escapeXml(l)}</text>`;
    }).join('\n');

    const warningIcon = template === 'warning'
        ? `<text x="256" y="125" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="54px" fill="${style.accent}">⚠️</text>`
        : '';

    const innerBg = template === 'warning' ? '#fef3c7' : '#0f172a';
    const rx = template === 'poster' ? 8 : 24;

    const svg = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${W}" height="${H}" fill="${style.bg}" rx="16"/>
        <rect x="38" y="54" width="436" height="404" rx="${rx}" fill="${style.accent}"/>
        <rect x="52" y="68" width="408" height="376" rx="${rx - 4}" fill="${innerBg}"/>
        ${warningIcon}
        ${textElements}
    </svg>
    `;

    return sharp(Buffer.from(svg))
        .webp({ quality })
        .toBuffer();
}

module.exports = {
    renderTextToWebP,
    renderTextOverlaySvg,
    renderMemeSticker,
    renderQuoteSticker,
    renderEmojiSticker,
    renderTemplateSticker
};
