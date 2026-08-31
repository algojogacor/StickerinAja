const crypto = require('crypto');
const { generateQrSvg } = require('../utils/qrHelper');
const sharp = require('sharp');

async function shortenUrl(url) {
    const res = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const text = await res.text();
    if (text.startsWith('http')) return text;
    throw new Error('Gagal memperpendek URL');
}

async function unshortenUrl(url) {
    const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    return res.url || url;
}

async function lookupIp(query) {
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(query)}?fields=status,message,country,regionName,city,zip,lat,lon,timezone,isp,org,as,query`);
    const data = await res.json();
    if (data.status === 'success') return data;
    throw new Error(data.message || 'IP / Domain tidak ditemukan');
}

function generatePassword(length = 16) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
    let pass = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
        pass += chars[bytes[i] % chars.length];
    }
    return pass;
}

module.exports = {
    names: [
        'short', 'shortlink', 'unshort', 'tinyurl',
        'qr', 'qrcode',
        'pass', 'password', 'passgen',
        'ip', 'ipinfo',
        'base64', 'encode', 'decode',
        'hash', 'md5', 'sha256'
    ],
    execute: async (sock, msg, args, ctx) => {
        const remoteJid = msg.key?.remoteJid;
        const command = (args._command || 'tools').toLowerCase();
        const text = args.join(' ').trim();

        // 1. URL SHORTENER
        if (['short', 'shortlink', 'tinyurl'].includes(command)) {
            const url = args[0];
            if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
                return sock.sendMessage(remoteJid, {
                    text: `🔗 *URL SHORTENER*\n\nPerpendek link panjang secara instan!\n\n📌 *Format:* \`!short <link>\`\n💡 *Contoh:* \`!short https://youtube.com/watch?v=123456\``
                }, { quoted: msg });
            }

            try {
                const short = await shortenUrl(url);
                return sock.sendMessage(remoteJid, {
                    text: `🔗 *LINK BERHASIL DIPERPENDEK*\n\n📌 *Link Asli:* ${url}\n✨ *Short Link:* ${short}`
                }, { quoted: msg });
            } catch (err) {
                return sock.sendMessage(remoteJid, { text: `❌ *Gagal memperpendek link:* ${err.message}` }, { quoted: msg });
            }
        }

        // 2. UNSHORTEN LINK
        if (command === 'unshort') {
            const url = args[0];
            if (!url) {
                return sock.sendMessage(remoteJid, {
                    text: `🔍 *LINK EXPANDER / UNSHORTEN*\n\nCek dan buka link tujuan asli dari shortlink untuk keamanan.\n\n📌 *Format:* \`!unshort <shortlink>\`\n💡 *Contoh:* \`!unshort https://tinyurl.com/2ym7l7c5\``
                }, { quoted: msg });
            }

            try {
                const fullUrl = await unshortenUrl(url);
                return sock.sendMessage(remoteJid, {
                    text: `🔍 *HASIL UNSHORTEN LINK*\n\n📌 *Link Input:* ${url}\n🎯 *Tujuan Asli:* ${fullUrl}`
                }, { quoted: msg });
            } catch (err) {
                return sock.sendMessage(remoteJid, { text: `❌ *Gagal mengecek link:* ${err.message}` }, { quoted: msg });
            }
        }

        // 3. QR CODE GENERATOR
        if (['qr', 'qrcode'].includes(command)) {
            if (!text) {
                return sock.sendMessage(remoteJid, {
                    text: `📱 *QR CODE GENERATOR*\n\nBuat gambar QR Code dari link atau teks apapun!\n\n📌 *Format:* \`!qr <link atau teks>\`\n💡 *Contoh:* \`!qr https://wa.me/628123456789\``
                }, { quoted: msg });
            }

            try {
                const svgString = generateQrSvg(text);
                const pngBuffer = await sharp(Buffer.from(svgString))
                    .resize(512, 512, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
                    .png()
                    .toBuffer();

                return sock.sendMessage(remoteJid, {
                    image: pngBuffer,
                    caption: `📱 *QR CODE BERHASIL DIBUAT*\n\n📄 *Isi:* \`${text}\``
                }, { quoted: msg });
            } catch (err) {
                return sock.sendMessage(remoteJid, { text: `❌ *Gagal membuat QR Code:* ${err.message}` }, { quoted: msg });
            }
        }

        // 4. PASSWORD GENERATOR
        if (['pass', 'password', 'passgen'].includes(command)) {
            const length = Math.min(Math.max(parseInt(args[0]) || 16, 6), 64);
            const pass = generatePassword(length);
            return sock.sendMessage(remoteJid, {
                text: `🔐 *RANDOM PASSWORD GENERATOR*\n\n` +
                      `🔑 *Password:* \`${pass}\`\n` +
                      `📏 *Panjang:* ${length} karakter\n\n` +
                      `_Tips: Password mengandung kombinasi huruf besar, kecil, angka, dan simbol aman._`
            }, { quoted: msg });
        }

        // 5. IP / DOMAIN LOOKUP
        if (['ip', 'ipinfo'].includes(command)) {
            const query = args[0];
            if (!query) {
                return sock.sendMessage(remoteJid, {
                    text: `🌐 *IP & DOMAIN LOOKUP*\n\nCek info detail IP address atau server website.\n\n📌 *Format:* \`!ip <ip atau domain>\`\n💡 *Contoh:* \`!ip google.com\` atau \`!ip 8.8.8.8\``
                }, { quoted: msg });
            }

            try {
                const info = await lookupIp(query);
                return sock.sendMessage(remoteJid, {
                    text: `🌐 *INFORMASI IP / SERVER*\n\n` +
                          `📌 *Query:* \`${info.query}\`\n` +
                          `🏳️ *Negara:* ${info.country}\n` +
                          `🏙️ *Kota/Region:* ${info.city}, ${info.regionName}\n` +
                          `🏢 *ISP / Provider:* ${info.isp}\n` +
                          `💼 *Organisasi:* ${info.org || '-'}\n` +
                          `⏰ *Timezone:* ${info.timezone}\n` +
                          `📍 *Koordinat:* ${info.lat}, ${info.lon}\n` +
                          `🔢 *ASN:* ${info.as || '-'}`
                }, { quoted: msg });
            } catch (err) {
                return sock.sendMessage(remoteJid, { text: `❌ *Gagal mengecek IP:* ${err.message}` }, { quoted: msg });
            }
        }

        // 6. BASE64 ENCODE / DECODE
        if (['base64', 'encode', 'decode'].includes(command)) {
            const isDecode = command === 'decode' || args[0]?.toLowerCase() === 'decode';
            const isEncode = command === 'encode' || args[0]?.toLowerCase() === 'encode';
            const rawContent = (isDecode || isEncode) ? args.slice(1).join(' ') : text;

            if (!rawContent) {
                return sock.sendMessage(remoteJid, {
                    text: `🔤 *BASE64 ENCODER / DECODER*\n\n` +
                          `📌 *Format:*\n` +
                          `• \`!base64 encode <teks>\` atau \`!encode <teks>\`\n` +
                          `• \`!base64 decode <base64>\` atau \`!decode <base64>\``
                }, { quoted: msg });
            }

            if (isDecode) {
                try {
                    const decoded = Buffer.from(rawContent, 'base64').toString('utf-8');
                    return sock.sendMessage(remoteJid, {
                        text: `🔓 *HASIL BASE64 DECODE:*\n\n\`\`\`\n${decoded}\n\`\`\``
                    }, { quoted: msg });
                } catch {
                    return sock.sendMessage(remoteJid, { text: '❌ Input base64 tidak valid.' }, { quoted: msg });
                }
            } else {
                const encoded = Buffer.from(rawContent, 'utf-8').toString('base64');
                return sock.sendMessage(remoteJid, {
                    text: `🔒 *HASIL BASE64 ENCODE:*\n\n\`\`\`\n${encoded}\n\`\`\``
                }, { quoted: msg });
            }
        }

        // 7. HASH GENERATOR
        if (['hash', 'md5', 'sha256'].includes(command)) {
            if (!text) {
                return sock.sendMessage(remoteJid, {
                    text: `🔒 *HASH GENERATOR*\n\nGenerate hash MD5, SHA1, dan SHA256 dari teks.\n\n📌 *Format:* \`!hash <teks>\`\n💡 *Contoh:* \`!hash RahasiaKu123\``
                }, { quoted: msg });
            }

            const md5Hash = crypto.createHash('md5').update(text).digest('hex');
            const sha1Hash = crypto.createHash('sha1').update(text).digest('hex');
            const sha256Hash = crypto.createHash('sha256').update(text).digest('hex');

            return sock.sendMessage(remoteJid, {
                text: `🔒 *HASIL HASH DARI TEKS*\n\n` +
                      `📝 *Input:* \`${text}\`\n\n` +
                      `🔑 *MD5:*\n\`${md5Hash}\`\n\n` +
                      `🔑 *SHA1:*\n\`${sha1Hash}\`\n\n` +
                      `🔑 *SHA256:*\n\`${sha256Hash}\``
            }, { quoted: msg });
        }
    }
};
