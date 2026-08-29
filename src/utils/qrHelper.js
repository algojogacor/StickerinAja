const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

/**
 * Generate a standalone vector SVG string from a QR data string
 * @param {string} text - QR data string
 * @param {object} options
 * @param {number} options.margin - Quiet zone margin (default 2)
 * @param {string} options.color - Dark module color (default #000000)
 * @param {string} options.background - Light background color (default #ffffff)
 * @returns {string} SVG markup string
 */
function generateQrSvg(text, options = {}) {
    if (!text) return '';
    try {
        const {
            margin = 2,
            color = '#000000',
            background = '#ffffff'
        } = options;

        const qr = new QRCode(-1, QRErrorCorrectLevel.L);
        qr.addData(text);
        qr.make();

        const count = qr.getModuleCount();
        const modules = qr.modules;
        const size = count + margin * 2;

        let path = '';
        for (let r = 0; r < count; r++) {
            for (let c = 0; c < count; c++) {
                if (modules[r][c]) {
                    path += `M${c + margin},${r + margin}h1v1h-1z `;
                }
            }
        }

        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" width="100%" height="100%"><rect width="${size}" height="${size}" fill="${background}"/><path d="${path}" fill="${color}"/></svg>`;
    } catch {
        return '';
    }
}

module.exports = { generateQrSvg };
