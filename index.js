require('dotenv').config();
// Initialize global bot state for HTTP status monitoring and QR serving
global.botState = {
    status: 'connecting',
    qr: null,
    user: null
};
const { startBot, hermesGetMessages, hermesLongPoll, hermesSendMessage, hermesSendTyping, pushToHermesQueue } = require('./src/baileys');
const { handler } = require('./src/handler');
const { setSock } = require('./src/core/socket');
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

// ─── Shared secret for Hermes relay auth ───
const HERMES_SECRET = process.env.HERMES_RELAY_SECRET || '';

function checkHermesAuth(req, res) {
    if (!HERMES_SECRET) return true; // No secret configured = open
    const auth = req.headers['authorization'] || '';
    if (auth === `Bearer ${HERMES_SECRET}`) return true;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
}

// ─── Hermes message wrapper for handler ───
// Non-sticker-command messages → push to Hermes queue
const { handler: originalHandler } = { handler };
const PREFIX = process.env.PREFIX || '!';

async function hermesAwareHandler(sock, msg, logger) {
    const messageText =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        '';

    // If it looks like a sticker command, process normally
    if (messageText.startsWith(PREFIX)) {
        return handler(sock, msg, logger);
    }

    // Non-command message → queue for Hermes
    pushToHermesQueue(msg);
}

// Start a lightweight HTTP server for health checking, QR code serving, status, and Hermes relay
const http = require('http');
const PORT = process.env.PORT || 8000;

// Load HTML template into memory once on start for maximum speed
const htmlPath = path.join(__dirname, 'src/utils/login.html');
let loginHtml = '<h1>Login Page</h1>';
try {
    loginHtml = fs.readFileSync(htmlPath, 'utf8');
} catch (err) {
    console.error('Failed to load login.html:', err);
}

http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const method = req.method;

    // ─── Hermes Relay Endpoints ───
    if (url.pathname === '/hermes/send' && method === 'POST') {
        if (!checkHermesAuth(req, res)) return;
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { chatId, message, replyTo } = JSON.parse(body);
                if (!chatId || !message) throw new Error('chatId and message required');
                const result = await hermesSendMessage(chatId, message, replyTo);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, key: result?.key }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (url.pathname === '/hermes/typing' && method === 'POST') {
        if (!checkHermesAuth(req, res)) return;
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { chatId } = JSON.parse(body);
                await hermesSendTyping(chatId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (url.pathname === '/hermes/messages' && method === 'GET') {
        if (!checkHermesAuth(req, res)) return;
        const since = url.searchParams.get('since');
        const longPoll = url.searchParams.get('poll') === '1';

        if (longPoll) {
            const msgs = await hermesLongPoll(25000);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ messages: msgs }));
        } else {
            const msgs = hermesGetMessages(since || undefined);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ messages: msgs }));
        }
        return;
    }

    if (url.pathname === '/hermes/health' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: global.botState.status,
            connected: global.botState.status === 'connected',
            user: global.botState.user?.name || null,
        }));
        return;
    }

    // ─── Existing endpoints ───
    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: Math.floor(process.uptime()) }));
    } else if (url.pathname === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(global.botState));
    } else if (url.pathname === '/qr-string') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(global.botState.qr || 'No QR code available. Already connected or connecting...');
    } else if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(loginHtml);
    } else {
        res.writeHead(404);
        res.end();
    }
}).listen(PORT, () => {
    logger.info(`🌐 Server on port ${PORT} | Hermes relay: ${HERMES_SECRET ? '🔒 auth' : '⚠️ open'}`);
});


// ── Reddit Sticker Bank init ──
const { init: initRedditStickerRepo } = require('./src/repositories/redditStickerRepository');
const redditCron = require('./src/scheduler/redditStickerCron');
initRedditStickerRepo(logger);

startBot({
    authDir: process.env.AUTH_DIR || './auth',
    logger,
    onMessage: (sock, msg) => {
        setSock(sock);
        return hermesAwareHandler(sock, msg, logger);
    }
});

// Start Reddit sticker cron after a short delay (let connection stabilize)
setTimeout(() => {
    redditCron.start({ logger });
}, 10_000);
