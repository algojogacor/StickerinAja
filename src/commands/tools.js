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

function normalizeParams(sockOrOpts, msg, args, ctx) {
    if (sockOrOpts && sockOrOpts.sock) {
        return {
            sock: sockOrOpts.sock,
            msg: sockOrOpts.msg,
            args: sockOrOpts.args || [],
            cmdName: sockOrOpts.cmdName,
            remoteJid: sockOrOpts.remoteJid || sockOrOpts.msg?.key?.remoteJid,
            logger: sockOrOpts.logger
        };
    }
    return {
        sock: sockOrOpts,
        msg,
        args: args || [],
        cmdName: args?._command || 'tools',
        remoteJid: msg?.key?.remoteJid,
        logger: ctx?.logger
    };
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
    shortenUrl,
    unshortenUrl,
    lookupIp,
    generatePassword,
    execute: async (sockOrOpts, rawMsg, rawArgs, ctx) => {
        const { sock, msg, args, cmdName, remoteJid, logger } = normalizeParams(sockOrOpts, rawMsg, rawArgs, ctx);
        const command = (cmdName || args._command || 'tools').toLowerCase();
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
                    text: `📱 *QR CODE GENERATOR*\n\nBuat QR Code instan dari teks atau link.\n\n📌 *Format:* \`!qr <teks/link>\`\n💡 *Contoh:* \`!qr https://google.com\``
                }, { quoted: msg });
            }

            try {
                const svg = generateQrSvg(text);
                const pngBuffer = await sharp(Buffer.from(svg))
                    .resize(512, 512)
                    .png()
                    .toBuffer();

                return sock.sendMessage(remoteJid, {
                    image: pngBuffer,
                    caption: `📱 *QR CODE SELESAI*\n\n📝 *Konten:* ${text}\n_Scan QR di atas untuk membuka konten._`
                }, { quoted: msg });
            } catch (err) {
                return sock.sendMessage(remoteJid, { text: `❌ *Gagal membuat QR Code:* ${err.message}` }, { quoted: msg });
            }
        }

        // 4. RANDOM PASSWORD GENERATOR
        if (['pass', 'password', 'passgen'].includes(command)) {
            let length = parseInt(args[0], 10);
            if (isNaN(length) || length < 6 || length > 64) {
                length = 16;
            }
            const password = generatePassword(length);
            return sock.sendMessage(remoteJid, {
                text: `🔐 *RANDOM PASSWORD GENERATOR*\n\n` +
                      `🔑 *Password:* \`${password}\`\n` +
                      `📏 *Panjang:* ${length} karakter\n\n` +
                      `_Tips: Salin password di atas dan simpan di tempat aman._`
            }, { quoted: msg });
        }

        // 5. IP & DOMAIN LOOKUP
        if (['ip', 'ipinfo'].includes(command)) {
            const query = args[0]?.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
            if (!query) {
                return sock.sendMessage(remoteJid, {
                    text: `🌐 *IP & DOMAIN LOOKUP*\n\nCek detail lokasi server, ISP, dan IP publik.\n\n📌 *Format:* \`!ip <ip atau domain>\`\n💡 *Contoh:* \`!ip 8.8.8.8\` atau \`!ip google.com\``
                }, { quoted: msg });
            }

            try {
                const info = await lookupIp(query);
                return sock.sendMessage(remoteJid, {
                    text: `🌐 *INFORMASI IP / DOMAIN*\n\n` +
                          `🎯 *Target:* ${info.query}\n` +
                          `📍 *Lokasi:* ${info.city}, ${info.regionName}, ${info.country} (${info.zip || '-'})\n` +
                          `🏢 *ISP:* ${info.isp}\n` +
                          `🏢 *Organisasi:* ${info.org || info.as}\n` +
                          `⏰ *Timezone:* ${info.timezone}\n` +
                          `🗺️ *Koordinat:* ${info.lat}, ${info.lon}`
                }, { quoted: msg });
            } catch (err) {
                return sock.sendMessage(remoteJid, { text: `❌ *Gagal lookup IP:* ${err.message}` }, { quoted: msg });
            }
        }

        // 6. BASE64 ENCODE / DECODE
        if (['base64', 'encode', 'decode'].includes(command)) {
            const sub = command === 'base64' ? args[0]?.toLowerCase() : command;
            const content = (command === 'base64' ? args.slice(1) : args).join(' ').trim();

            if (!content || !['encode', 'decode'].includes(sub)) {
                return sock.sendMessage(remoteJid, {
                    text: `🔤 *BASE64 ENCODER / DECODER*\n\n` +
                          `📌 *Format:*\n` +
                          `• \`!base64 encode <teks>\`\n` +
                          `• \`!base64 decode <teks base64>\`\n\n` +
                          `💡 *Contoh:* \`!base64 encode Halo Dunia\``
                }, { quoted: msg });
            }

            if (sub === 'encode') {
                const encoded = Buffer.from(content, 'utf8').toString('base64');
                return sock.sendMessage(remoteJid, {
                    text: `🔤 *BASE64 ENCODE*\n\n📝 *Teks:* ${content}\n✨ *Hasil:* \`${encoded}\``
                }, { quoted: msg });
            } else {
                try {
                    const decoded = Buffer.from(content, 'base64').toString('utf8');
                    return sock.sendMessage(remoteJid, {
                        text: `🔤 *BASE64 DECODE*\n\n📝 *Base64:* ${content}\n✨ *Hasil:* ${decoded}`
                    }, { quoted: msg });
                } catch {
                    return sock.sendMessage(remoteJid, { text: '❌ *Teks bukan format Base64 yang valid!*' }, { quoted: msg });
                }
            }
        }

        // 7. HASH GENERATOR
        if (['hash', 'md5', 'sha256'].includes(command)) {
            if (!text) {
                return sock.sendMessage(remoteJid, {
                    text: `🔒 *HASH GENERATOR*\n\nGenerate hash MD5, SHA1, dan SHA256 dari teks.\n\n📌 *Format:* \`!hash <teks>\`\n💡 *Contoh:* \`!hash rahasia123\``
                }, { quoted: msg });
            }

            const md5 = crypto.createHash('md5').update(text).digest('hex');
            const sha1 = crypto.createHash('sha1').update(text).digest('hex');
            const sha256 = crypto.createHash('sha256').update(text).digest('hex');

            return sock.sendMessage(remoteJid, {
                text: `🔒 *HASH RESULTS*\n\n` +
                      `📝 *Input:* ${text}\n\n` +
                      `🔑 *MD5:*\n\`${md5}\`\n\n` +
                      `🔑 *SHA1:*\n\`${sha1}\`\n\n` +
                      `🔑 *SHA256:*\n\`${sha256}\``
            }, { quoted: msg });
        }
    }
};
