const https = require('https');
const http = require('http');

async function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        const req = (url.startsWith('https') ? https : http).get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchBuffer(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('Timeout downloading media'));
        });
    });
}

async function getTikTokData(url) {
    const apiRes = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const data = await apiRes.json();
    if (data.code === 0 && data.data) {
        return {
            id: data.data.id,
            title: data.data.title || 'TikTok Video',
            author: data.data.author?.nickname || data.data.author?.unique_id || 'Unknown',
            duration: data.data.duration || 0,
            playUrl: data.data.play || data.data.wmplay,
            musicUrl: data.data.music,
            coverUrl: data.data.cover
        };
    }
    throw new Error(data.msg || 'Gagal memproses URL TikTok');
}

module.exports = {
    names: ['tiktok', 'tt', 'ttdl', 'download', 'dl', 'ttmp3'],
    execute: async (sock, msg, args, ctx) => {
        const remoteJid = msg.key?.remoteJid;
        const command = args._command || 'tiktok';

        // Extract URL
        const urlArg = args.find(a => a.startsWith('http://') || a.startsWith('https://'));
        if (!urlArg) {
            return sock.sendMessage(remoteJid, {
                text: `🎬 *TIKTOK DOWNLOADER*\n\n` +
                      `Download video TikTok tanpa watermark secara instan!\n\n` +
                      `📌 *Format:* \`!tiktok <link tiktok>\`\n` +
                      `🎵 *Audio Saja:* \`!ttmp3 <link tiktok>\` atau \`!tiktok <link> --audio\`\n` +
                      `🎨 *Jadikan Stiker:* \`!tiktok <link> --sticker\`\n\n` +
                      `💡 *Contoh:* \`!tiktok https://vt.tiktok.com/ZSjX3Yv1b/\``
            }, { quoted: msg });
        }

        const isAudioOnly = command === 'ttmp3' || args.includes('--audio') || args.includes('-a');
        const isSticker = args.includes('--sticker') || args.includes('-s');

        try {
            await sock.sendMessage(remoteJid, {
                text: `⏳ Sedang memproses video TikTok... Mohon tunggu sebentar.`
            }, { quoted: msg });

            const info = await getTikTokData(urlArg);

            if (isAudioOnly && info.musicUrl) {
                const audioBuffer = await fetchBuffer(info.musicUrl);
                return sock.sendMessage(remoteJid, {
                    audio: audioBuffer,
                    mimetype: 'audio/mp4',
                    ptt: false,
                    caption: `🎵 *Audio TikTok*\n📌 *Judul:* ${info.title}\n👤 *Author:* ${info.author}`
                }, { quoted: msg });
            }

            if (isSticker && info.playUrl) {
                const { convertVideoToSticker } = require('../services/sticker/converterService');
                const { prepareStickerWithExif } = require('../utils/exifHelper');
                const videoBuffer = await fetchBuffer(info.playUrl);
                const webpBuffer = await convertVideoToSticker(videoBuffer);
                const finalSticker = prepareStickerWithExif(webpBuffer);
                return sock.sendMessage(remoteJid, { sticker: finalSticker }, { quoted: msg });
            }

            if (!info.playUrl) {
                throw new Error('Link video tidak ditemukan');
            }

            const videoBuffer = await fetchBuffer(info.playUrl);
            return sock.sendMessage(remoteJid, {
                video: videoBuffer,
                caption: `🎬 *TIKTOK VIDEO (NO WATERMARK)*\n\n` +
                         `📌 *Judul:* ${info.title}\n` +
                         `👤 *Author:* ${info.author}\n` +
                         `⏱️ *Durasi:* ${info.duration} detik\n\n` +
                         `_Powered by StickerinAja_`,
                mimetype: 'video/mp4'
            }, { quoted: msg });

        } catch (error) {
            ctx?.logger?.error({ err: error }, '[TikTok Downloader] Error processing video');
            return sock.sendMessage(remoteJid, {
                text: `❌ *Gagal Mendownload TikTok*\n\nAlasan: ${error.message || 'URL tidak valid atau server sedang sibuk'}\n\nPastikan link TikTok publik dan dapat dibuka.`
            }, { quoted: msg });
        }
    }
};
