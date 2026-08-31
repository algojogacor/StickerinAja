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

async function getInstagramData(url) {
    const { snapsave } = await import('snapsave-media-downloader');
    const res = await snapsave(url);
    if (res?.success && Array.isArray(res?.data?.media) && res.data.media.length > 0) {
        return res.data.media;
    }
    throw new Error('Media Instagram tidak ditemukan. Pastikan link adalah postingan/reels dari akun publik.');
}

module.exports = {
    names: ['tiktok', 'tt', 'ttdl', 'ttmp3', 'ig', 'igdl', 'instagram', 'reels', 'reel', 'download', 'dl'],
    getTikTokData,
    getInstagramData,
    fetchBuffer,
    execute: async (sock, msg, args, ctx) => {
        const remoteJid = msg.key?.remoteJid;
        const command = (args._command || 'download').toLowerCase();

        // Extract URL
        const urlArg = args.find(a => a.startsWith('http://') || a.startsWith('https://'));
        if (!urlArg) {
            return sock.sendMessage(remoteJid, {
                text: `📥 *SOCIAL MEDIA DOWNLOADER*\n\n` +
                      `Download video/foto TikTok & Instagram tanpa watermark secara instan!\n\n` +
                      `🎬 *TikTok Downloader:*\n` +
                      `• \`!tiktok <link>\` : Download video TikTok no-WM\n` +
                      `• \`!ttmp3 <link>\` : Ambil audio/lagu TikTok\n` +
                      `• \`!tiktok <link> --sticker\` : Jadikan stiker bergerak\n\n` +
                      `📸 *Instagram Downloader:*\n` +
                      `• \`!ig <link>\` : Download Reels, Video & Foto Instagram\n` +
                      `• \`!ig <link> --sticker\` : Ubah Reels/Foto jadi stiker WA\n\n` +
                      `💡 *Contoh:*\n` +
                      `\`!tiktok https://vt.tiktok.com/ZSjX3Yv1b/\`\n` +
                      `\`!ig https://www.instagram.com/reel/DctGPX0pYfi/\``
            }, { quoted: msg });
        }

        const isInstagram = urlArg.includes('instagram.com') || urlArg.includes('instagr.am') || ['ig', 'igdl', 'instagram', 'reels', 'reel'].includes(command);
        const isTikTok = urlArg.includes('tiktok.com') || urlArg.includes('douyin.com') || ['tiktok', 'tt', 'ttdl', 'ttmp3'].includes(command);
        const isAudioOnly = command === 'ttmp3' || args.includes('--audio') || args.includes('-a');
        const isSticker = args.includes('--sticker') || args.includes('-s');

        // ==========================================
        // 1. INSTAGRAM DOWNLOADER
        // ==========================================
        if (isInstagram && !isTikTok) {
            try {
                await sock.sendMessage(remoteJid, {
                    text: `⏳ *Sedang mengambil media Instagram...* Mohon tunggu sebentar.`
                }, { quoted: msg });

                const mediaList = await getInstagramData(urlArg);

                for (let i = 0; i < mediaList.length; i++) {
                    const item = mediaList[i];
                    const buffer = await fetchBuffer(item.url);

                    if (isSticker) {
                        const { convertVideoToSticker, convertImageToSticker } = require('../services/sticker/converterService');
                        const { prepareStickerWithExif } = require('../utils/exifHelper');

                        const webpBuffer = item.type === 'video'
                            ? await convertVideoToSticker(buffer)
                            : await convertImageToSticker(buffer, { quality: 85 });
                        const finalSticker = prepareStickerWithExif(webpBuffer);
                        await sock.sendMessage(remoteJid, { sticker: finalSticker }, { quoted: msg });
                        continue;
                    }

                    if (item.type === 'video') {
                        await sock.sendMessage(remoteJid, {
                            video: buffer,
                            caption: `🎬 *INSTAGRAM REELS / VIDEO*\n\n` +
                                     (mediaList.length > 1 ? `📑 *Media:* ${i + 1} dari ${mediaList.length}\n` : '') +
                                     `_Downloaded by StickerinAja_`,
                            mimetype: 'video/mp4'
                        }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, {
                            image: buffer,
                            caption: `📸 *INSTAGRAM PHOTO*\n\n` +
                                     (mediaList.length > 1 ? `📑 *Foto:* ${i + 1} dari ${mediaList.length}\n` : '') +
                                     `_Downloaded by StickerinAja_`,
                            mimetype: 'image/jpeg'
                        }, { quoted: msg });
                    }

                    if (i < mediaList.length - 1) {
                        await new Promise(r => setTimeout(r, 1200));
                    }
                }
                return;
            } catch (error) {
                ctx?.logger?.error({ err: error }, '[IG Downloader] Error');
                return sock.sendMessage(remoteJid, {
                    text: `❌ *Gagal Mendownload Instagram*\n\nAlasan: ${error.message || 'Postingan bersifat privat atau server sedang sibuk'}\n\nPastikan link adalah Reels/Foto dari akun Instagram publik.`
                }, { quoted: msg });
            }
        }

        // ==========================================
        // 2. TIKTOK DOWNLOADER
        // ==========================================
        try {
            await sock.sendMessage(remoteJid, {
                text: `⏳ *Sedang memproses video TikTok...* Mohon tunggu sebentar.`
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
