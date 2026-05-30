require('dotenv').config();
// Initialize global bot state for HTTP status monitoring and QR serving
global.botState = {
    status: 'connecting',
    qr: null,
    user: null
};
const { startBot } = require('./src/baileys');
const { handler } = require('./src/handler');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// Ensure temp dir exists
const TEMP_DIR = process.env.TEMP_DIR || './temp';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Cleanup temp files every 5 minutes
const KEEP_MINUTES = parseInt(process.env.KEEP_TEMP_MINUTES || '5');
setInterval(async () => {
    const cutoff = Date.now() - KEEP_MINUTES * 60 * 1000;
    try {
        const files = await fs.promises.readdir(TEMP_DIR);
        await Promise.all(files.map(async (file) => {
            const fp = path.join(TEMP_DIR, file);
            try {
                const stat = await fs.promises.stat(fp);
                if (stat.isFile() && stat.mtimeMs < cutoff) {
                    await fs.promises.unlink(fp);
                }
            } catch {}
        }));
    } catch {}
}, 60_000);

// ⚡ pino-pretty spawns a worker thread + does string formatting per log line
// Skip in production to save ~10-15MB RAM and reduce CPU per log call
const isDev = (process.env.NODE_ENV || 'development') !== 'production';
const logger = pino({
    ...(isDev ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } } } : {}),
    level: process.env.LOG_LEVEL || 'info'
});

// Start a lightweight HTTP server for health checking, QR code serving, and status monitoring
const http = require('http');
const PORT = process.env.PORT || 8000;
http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: Math.floor(process.uptime()) }));
    } else if (req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(global.botState));
    } else if (req.url === '/qr-string') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(global.botState.qr || 'No QR code available. Already connected or connecting...');
    } else if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Stickerin Bot - WhatsApp Login</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #0f172a;
            --card-bg: rgba(30, 41, 59, 0.7);
            --primary: #10b981;
            --primary-glow: rgba(16, 185, 129, 0.4);
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
        }
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            font-family: 'Outfit', sans-serif;
        }
        body {
            background: radial-gradient(circle at center, #1e293b 0%, var(--bg-color) 100%);
            color: var(--text-main);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: var(--card-bg);
            backdrop-filter: blur(16px);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 24px;
            padding: 40px;
            width: 100%;
            max-width: 450px;
            text-align: center;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
            transition: all 0.3s ease;
        }
        h1 {
            font-size: 28px;
            font-weight: 800;
            margin-bottom: 8px;
            background: linear-gradient(135deg, #34d399 0%, #059669 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        p {
            color: var(--text-muted);
            font-size: 15px;
            line-height: 1.5;
            margin-bottom: 24px;
        }
        .qr-wrapper {
            background: white;
            padding: 16px;
            border-radius: 16px;
            display: inline-block;
            box-shadow: 0 8px 30px var(--primary-glow);
            margin-bottom: 24px;
        }
        .qr-wrapper img {
            display: block;
            width: 250px;
            height: 250px;
        }
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            border-radius: 100px;
            font-size: 14px;
            font-weight: 600;
            background: rgba(16, 185, 129, 0.1);
            color: var(--primary);
            margin-bottom: 16px;
            border: 1px solid rgba(16, 185, 129, 0.2);
        }
        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--primary);
            box-shadow: 0 0 8px var(--primary);
            animation: pulse 1.5s infinite;
        }
        @keyframes pulse {
            0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
            70% { transform: scale(1); box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); }
            100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
        }
        .loading {
            width: 50px;
            height: 50px;
            border: 3px solid rgba(255, 255, 255, 0.1);
            border-top-color: var(--primary);
            border-radius: 50%;
            animation: spin 1s infinite linear;
            margin: 40px auto;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .footer {
            margin-top: 16px;
            font-size: 12px;
            color: rgba(255, 255, 255, 0.3);
        }
    </style>
</head>
<body>
    <div class="container">
        <div id="app">
            <div class="loading"></div>
            <p>Menghubungkan ke bot...</p>
        </div>
        <div class="footer">Stickerin Bot &copy; 2026</div>
    </div>
    <script>
        async function checkStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                const app = document.getElementById('app');
                
                if (data.status === 'connected') {
                    app.innerHTML = `
                        <div class="status-badge">
                            <span class="status-dot"></span>
                            Terhubung
                        </div>
                        <h1>WhatsApp Terhubung!</h1>
                        <p style="margin-top: 10px;">Bot sudah siap digunakan sebagai <b>\${data.user?.name || data.user?.id || 'Stickerin Bot'}</b>.</p>
                        <p>Anda bisa menutup halaman ini sekarang.</p>
                    `;
                } else if (data.status === 'qr' && data.qr) {
                    const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=' + encodeURIComponent(data.qr);
                    app.innerHTML = `
                        <div class="status-badge" style="background: rgba(245, 158, 11, 0.1); color: #f59e0b; border-color: rgba(245, 158, 11, 0.2);">
                            <span class="status-dot" style="background: #f59e0b; box-shadow: 0 0 8px #f59e0b; animation-name: pulse-orange;"></span>
                            Menunggu Pemindaian
                        </div>
                        <h1>Pindai Kode QR</h1>
                        <p>Buka WhatsApp -> Perangkat Tertaut -> Tautkan Perangkat, lalu arahkan kamera ke kode di bawah ini.</p>
                        <div class="qr-wrapper">
                            <img src="\${qrUrl}" alt="QR Code" />
                        </div>
                        <p style="font-size: 13px; color: #64748b;">Kode QR akan diperbarui secara otomatis setiap beberapa detik.</p>
                    `;
                } else {
                    app.innerHTML = `
                        <div class="loading"></div>
                        <h1>Menghubungkan...</h1>
                        <p>Sedang menyiapkan koneksi WhatsApp. Silakan tunggu.</p>
                    `;
                }
            } catch (err) {
                console.error(err);
            }
        }
        setInterval(checkStatus, 3000);
        checkStatus();
    </script>
    <style>
        @keyframes pulse-orange {
            0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.7); }
            70% { transform: scale(1); box-shadow: 0 0 0 8px rgba(245, 158, 11, 0); }
            100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
        }
    </style>
</body>
</html>`);
    } else {
        res.writeHead(404);
        res.end();
    }
}).listen(PORT, () => {
    logger.info(`🌐 Health check server listening on port ${PORT}`);
});

startBot({
    authDir: process.env.AUTH_DIR || './auth',
    logger,
    onMessage: (sock, msg) => handler(sock, msg, logger)
});
