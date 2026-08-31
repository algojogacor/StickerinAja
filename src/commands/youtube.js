const yts = require('yt-search');
const { YtDlp } = require('ytdlp-nodejs');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { heavyTaskQueue } = require('../utils/cache');

const ytdlp = new YtDlp();
const MAX_DURATION_SECONDS = 15 * 60; // Max 15 minutes limit to prevent OOM/slow downs

function getCookiesFilePath() {
    // 1. Direct local file
    const localCookies = path.join(process.cwd(), 'cookies.txt');
    if (fs.existsSync(localCookies)) {
        return localCookies;
    }

    // 2. Base64 environment variable (ideal for Koyeb secrets/env)
    if (process.env.YOUTUBE_COOKIES_BASE64) {
        const tempCookiePath = path.join(os.tmpdir(), 'yt_cookies.txt');
        try {
            const decoded = Buffer.from(process.env.YOUTUBE_COOKIES_BASE64, 'base64').toString('utf-8');
            fs.writeFileSync(tempCookiePath, decoded);
            return tempCookiePath;
        } catch (e) {
            // ignore
        }
    }

    // 3. Raw text environment variable
    if (process.env.YOUTUBE_COOKIES) {
        const tempCookiePath = path.join(os.tmpdir(), 'yt_cookies.txt');
        try {
            fs.writeFileSync(tempCookiePath, process.env.YOUTUBE_COOKIES);
            return tempCookiePath;
        } catch (e) {
            // ignore
        }
    }

    return null;
}

function isYouTubeUrl(input) {
    return /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|v\/)|youtu\.be\/)/i.test(input);
}

function sanitizeFileName(title) {
    return (title || 'YouTube_Audio')
        .replace(/[/\\?%*:|"<>]/g, '')
        .trim()
        .slice(0, 60);
}

async function resolveVideo(queryOrUrl) {
    if (isYouTubeUrl(queryOrUrl)) {
        const match = queryOrUrl.match(/(?:v=|\/|be\/)([a-zA-Z0-9_-]{11})/);
        if (match && match[1]) {
            try {
                const info = await yts({ videoId: match[1] });
                if (info && info.title) {
                    return {
                        title: info.title,
                        url: info.url || queryOrUrl,
                        timestamp: info.duration?.timestamp || `${Math.floor(info.seconds / 60)}:${info.seconds % 60}`,
                        seconds: info.duration?.seconds || info.seconds || 0,
                        author: info.author?.name || 'Unknown',
                        views: info.views || 0,
                        thumbnail: info.thumbnail
                    };
                }
            } catch (e) {
                // fallback to search
            }
        }
    }

    const searchRes = await yts(queryOrUrl);
    if (!searchRes?.videos?.length) {
        throw new Error('Video/lagu tidak ditemukan di YouTube.');
    }

    const video = searchRes.videos[0];
    return {
        title: video.title,
        url: video.url,
        timestamp: video.timestamp || 'N/A',
        seconds: video.seconds || 0,
        author: video.author?.name || 'Unknown',
        views: video.views || 0,
        thumbnail: video.thumbnail
    };
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
        cmdName: args?._command || 'play',
        remoteJid: msg?.key?.remoteJid,
        logger: ctx?.logger
    };
}

module.exports = {
    names: ['play', 'ytmp3', 'yta', 'ytmp4', 'ytv', 'youtube', 'yt', 'lagu', 'music'],
    resolveVideo,
    sanitizeFileName,
    isYouTubeUrl,
    execute: async (sockOrOpts, rawMsg, rawArgs, ctx) => {
        const { sock, msg, args, cmdName, remoteJid, logger } = normalizeParams(sockOrOpts, rawMsg, rawArgs, ctx);
        const command = (cmdName || args._command || 'play').toLowerCase();
        const query = args.join(' ').trim();

        // 1. Help menu if no query provided
        if (!query) {
            return sock.sendMessage(remoteJid, {
                text: `🎬 *YOUTUBE DOWNLOADER & MUSIC PLAYER*\n\n` +
                      `Download lagu MP3 (file attachment dokumen) dan video MP4 langsung dari YouTube!\n\n` +
                      `🎵 *Download Audio / MP3 (File Attachment):*\n` +
                      `• \`!play <judul lagu>\` : Cari lagu & kirim file MP3\n` +
                      `• \`!ytmp3 <link / judul>\` : Download audio MP3\n` +
                      `• \`!yta <link / judul>\` : Alias download audio MP3\n\n` +
                      `🎬 *Download Video / MP4:*\n` +
                      `• \`!ytmp4 <link / judul>\` : Download video MP4\n` +
                      `• \`!ytv <link / judul>\` : Alias download video MP4\n\n` +
                      `💡 *Contoh:*\n` +
                      `\`!play monokrom tulus\`\n` +
                      `\`!ytmp3 https://youtu.be/dQw4w9WgXcQ\`\n` +
                      `\`!ytmp4 tutorial nodejs\``
            }, { quoted: msg });
        }

        const isVideo = ['ytmp4', 'ytv'].includes(command);

        return heavyTaskQueue.add(async () => {
            const tempDir = path.join(os.tmpdir(), 'stickerin_yt');
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            let downloadedFiles = [];

            try {
                // Inform user that search is in progress
                await sock.sendMessage(remoteJid, {
                    text: `🔍 *Mencari:* _${query}_\nMohon tunggu sebentar...`
                }, { quoted: msg });

                const video = await resolveVideo(query);

                if (video.seconds > MAX_DURATION_SECONDS) {
                    return sock.sendMessage(remoteJid, {
                        text: `❌ *Durasi Terlalu Panjang*\n\n` +
                              `📌 *Judul:* ${video.title}\n` +
                              `⏱️ *Durasi:* ${video.timestamp} (Maksimal 15 menit)\n\n` +
                              `Silakan pilih lagu atau video dengan durasi di bawah 15 menit.`
                    }, { quoted: msg });
                }

                const safeTitle = sanitizeFileName(video.title);
                const uniqueId = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
                const cookieFile = getCookiesFilePath();
                const authArgs = cookieFile 
                    ? ['--cookies', cookieFile]
                    : ['--extractor-args', 'youtube:player_client=android,ios,mweb'];

                const workerUrl = process.env.YT_WORKER_URL || 'https://vpn.aryariap.my.id/api/yt/download';
                const workerKey = process.env.YT_WORKER_KEY || 'yt_korea_worker_sec_9941a84f3c7e01';

                if (isVideo) {
                    // Download Video MP4 (480p/720p)
                    await sock.sendMessage(remoteJid, {
                        text: `⏳ *Sedang mengunduh video MP4...*\n🎬 *Judul:* ${video.title}\n⏱️ *Durasi:* ${video.timestamp}`
                    }, { quoted: msg });

                    let videoBuffer = null;

                    if (workerUrl) {
                        try {
                            logger?.info({ workerUrl }, '[YouTube] Requesting video from Korea worker');
                            const res = await fetch(workerUrl, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'x-api-key': workerKey
                                },
                                body: JSON.stringify({ url: video.url, type: 'mp4' }),
                                signal: AbortSignal.timeout(180000)
                            });

                            if (res.ok) {
                                const arr = await res.arrayBuffer();
                                videoBuffer = Buffer.from(arr);
                                logger?.info(`[YouTube] Received ${videoBuffer.length} bytes video from worker`);
                            } else {
                                const errTxt = await res.text();
                                logger?.warn({ status: res.status, errTxt }, '[YouTube] Worker failed, fallback to local');
                            }
                        } catch (err) {
                            logger?.warn({ err: err.message }, '[YouTube] Worker error, fallback to local');
                        }
                    }

                    if (!videoBuffer) {
                        const outPattern = path.join(tempDir, `vid_${uniqueId}_${safeTitle}.%(ext)s`);
                        await ytdlp.execAsync([
                            video.url,
                            '-f', 'bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4]/best[height<=720]/best',
                            '--no-playlist',
                            '--no-check-certificates',
                            ...authArgs,
                            '-o', outPattern
                        ]);

                        const foundFiles = fs.readdirSync(tempDir).filter(f => f.startsWith(`vid_${uniqueId}_`));
                        if (!foundFiles.length) {
                            throw new Error('Gagal menyimpan file video hasil download.');
                        }

                        const finalPath = path.join(tempDir, foundFiles[0]);
                        downloadedFiles.push(finalPath);
                        videoBuffer = fs.readFileSync(finalPath);
                    }

                    await sock.sendMessage(remoteJid, {
                        document: videoBuffer,
                        mimetype: 'video/mp4',
                        fileName: `${safeTitle}.mp4`,
                        caption: `🎬 *${video.title}*\n\n` +
                                 `👤 *Channel:* ${video.author}\n` +
                                 `⏱️ *Durasi:* ${video.timestamp}\n` +
                                 `👁️ *Views:* ${Number(video.views || 0).toLocaleString('id-ID')}\n` +
                                 `🔗 *Link:* ${video.url}\n\n` +
                                 `_Downloaded by StickerinAja_`
                    }, { quoted: msg });

                    logger?.info(`✅ YouTube video sent: ${video.title}`);

                } else {
                    // Download Audio MP3 (Document attachment)
                    await sock.sendMessage(remoteJid, {
                        text: `⏳ *Sedang mengunduh audio MP3...*\n🎵 *Judul:* ${video.title}\n⏱️ *Durasi:* ${video.timestamp}`
                    }, { quoted: msg });

                    let audioBuffer = null;

                    if (workerUrl) {
                        try {
                            logger?.info({ workerUrl }, '[YouTube] Requesting audio from Korea worker');
                            const res = await fetch(workerUrl, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'x-api-key': workerKey
                                },
                                body: JSON.stringify({ url: video.url, type: 'mp3' }),
                                signal: AbortSignal.timeout(180000)
                            });

                            if (res.ok) {
                                const arr = await res.arrayBuffer();
                                audioBuffer = Buffer.from(arr);
                                logger?.info(`[YouTube] Received ${audioBuffer.length} bytes audio from worker`);
                            } else {
                                const errTxt = await res.text();
                                logger?.warn({ status: res.status, errTxt }, '[YouTube] Worker failed, fallback to local');
                            }
                        } catch (err) {
                            logger?.warn({ err: err.message }, '[YouTube] Worker error, fallback to local');
                        }
                    }

                    if (!audioBuffer) {
                        const outPattern = path.join(tempDir, `audio_${uniqueId}_${safeTitle}.%(ext)s`);
                        await ytdlp.execAsync([
                            video.url,
                            '-x',
                            '--audio-format', 'mp3',
                            '--audio-quality', '0',
                            '--no-playlist',
                            '--no-check-certificates',
                            ...authArgs,
                            '-o', outPattern
                        ]);

                        const foundFiles = fs.readdirSync(tempDir).filter(f => f.startsWith(`audio_${uniqueId}_`));
                        if (!foundFiles.length) {
                            throw new Error('Gagal menyimpan file audio MP3 hasil download.');
                        }

                        const finalPath = path.join(tempDir, foundFiles[0]);
                        downloadedFiles.push(finalPath);
                        audioBuffer = fs.readFileSync(finalPath);
                    }

                    await sock.sendMessage(remoteJid, {
                        document: audioBuffer,
                        mimetype: 'audio/mpeg',
                        fileName: `${safeTitle}.mp3`,
                        caption: `🎵 *${video.title}*\n\n` +
                                 `👤 *Channel:* ${video.author}\n` +
                                 `⏱️ *Durasi:* ${video.timestamp}\n` +
                                 `👁️ *Views:* ${Number(video.views || 0).toLocaleString('id-ID')}\n` +
                                 `🔗 *Link:* ${video.url}\n\n` +
                                 `_Downloaded by StickerinAja_`
                    }, { quoted: msg });

                    logger?.info(`✅ YouTube MP3 sent: ${video.title}`);
                }

            } catch (error) {
                logger?.error({ err: error }, '[YouTube Downloader] Error');
                return sock.sendMessage(remoteJid, {
                    text: `❌ *Gagal Memproses YouTube*\n\nAlasan: ${error.message || 'Terjadi kesalahan saat mengunduh media'}\n\nPastikan judul atau link YouTube dapat diakses secara publik.`
                }, { quoted: msg });
            } finally {
                // Clean up temporary files
                for (const fp of downloadedFiles) {
                    try {
                        if (fs.existsSync(fp)) fs.unlinkSync(fp);
                    } catch (e) {
                        // ignore cleanup errors
                    }
                }
            }
        });
    }
};
