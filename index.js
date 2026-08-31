require('dotenv').config();
// Initialize global bot state for HTTP status monitoring and QR serving
global.botState = {
    status: 'connecting',
    qr: null,
    user: null
};

// ⚡ Sharp memory optimization for Koyeb 512MB RAM environment
const sharp = require('sharp');
sharp.cache(false);
sharp.concurrency(1);

const { startBot } = require('./src/baileys');
const { handler, extractMessageContent, shouldProcessMessage } = require('./src/handler');
const { generateQrSvg } = require('./src/utils/qrHelper');
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

const PREFIX = process.env.PREFIX || '!';
const birthdayTakeover = require('./src/services/birthdayTakeoverService');

// In-memory message deduplication cache across sessions
const processedMessageIds = new Map();

function isDuplicateMessage(messageId) {
    if (!messageId) return false;
    const now = Date.now();
    for (const [id, time] of processedMessageIds.entries()) {
        if (now - time > 60_000) processedMessageIds.delete(id);
    }
    if (processedMessageIds.has(messageId)) {
        return true;
    }
    processedMessageIds.set(messageId, now);
    return false;
}

async function messageHandler(sock, msg, logger, sessionId) {
    const sessionConfig = sessionId && global.botSessions?.[sessionId];
    const botMode = sessionConfig?.botMode || process.env.BOT_MODE || 'dual';
    if (!shouldProcessMessage(msg, botMode)) return;

    const { text: messageText } = extractMessageContent(msg);

    // If it looks like a sticker command, process normally
    if (messageText.startsWith(PREFIX)) {
        const isGroup = Boolean(msg.key?.remoteJid?.endsWith('@g.us'));

        // Prevent double response in shared group: prioritize bot session ONLY IF bot is a member of this group
        if (isGroup && sessionId === 'pribadi') {
            const botSession = global.botSessions?.['bot'];
            const isBotInThisGroup = Boolean(global.botGroupJids && global.botGroupJids.has(msg.key?.remoteJid));
            if (botSession?.status === 'connected' && isBotInThisGroup) {
                logger.debug({ msgId: msg.key?.id, group: msg.key?.remoteJid }, '[Multi-Session] Skipped group command on pribadi session in favor of connected bot session');
                return;
            }
        }

        // Deduplicate message ID across sessions
        if (msg.key?.id && isDuplicateMessage(msg.key.id)) {
            logger.debug({ msgId: msg.key?.id, sessionId }, '[Multi-Session] Message ID already claimed by another session — skipping');
            return;
        }

        return handler(sock, msg, logger, sessionId, botMode);
    }

    // Birthday wishes are replies to the card message; persistence is best-effort.
    if (!msg.key?.fromMe) {
        try {
            await birthdayTakeover.recordWishFromMessage(msg);
        } catch (error) {
            logger.debug({ err: error }, '[Birthday] Failed to record wish');
        }
    }
}

// Start a lightweight HTTP server for health checking, QR code serving, and status dashboard
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

    // ─── Endpoints ───
    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: Math.floor(process.uptime()), sessions: global.botSessions || undefined }));
    } else if (url.pathname === '/api/status') {
        const sessionData = {};
        if (global.botSessions) {
            for (const [id, s] of Object.entries(global.botSessions)) {
                sessionData[id] = {
                    ...s,
                    qrSvg: s.qr ? generateQrSvg(s.qr) : null
                };
            }
        }
        const qrSvg = global.botState.qr ? generateQrSvg(global.botState.qr) : null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ...global.botState,
            qrSvg,
            sessions: Object.keys(sessionData).length > 0 ? sessionData : undefined
        }));
    } else if (url.pathname === '/api/qr' || url.pathname === '/api/qr.svg') {
        const reqSession = url.searchParams.get('session');
        let targetQr = null;
        if (reqSession && global.botSessions?.[reqSession]) {
            targetQr = global.botSessions[reqSession].qr;
        } else {
            targetQr = global.botState.qr;
        }

        if (!targetQr) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('No active QR code available.');
        } else {
            const svg = generateQrSvg(targetQr);
            res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
            res.end(svg);
        }
    } else if (url.pathname === '/qr-string') {
        const reqSession = url.searchParams.get('session');
        let targetQr = null;
        if (reqSession && global.botSessions?.[reqSession]) {
            targetQr = global.botSessions[reqSession].qr;
        } else {
            targetQr = global.botState.qr;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(targetQr || 'No QR code available. Already connected or connecting...');
    } else if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(loginHtml);
    } else {
        res.writeHead(404);
        res.end();
    }
}).listen(PORT, () => {
    logger.info(`🌐 Server on port ${PORT} | Dashboard & Health ready`);
});

// ── Reddit Sticker Bank init ──
const { init: initRedditStickerRepo } = require('./src/repositories/redditStickerRepository');
const redditCron = require('./src/scheduler/redditStickerCron');
const newsScheduler = require('./src/scheduler/newsScheduler');
initRedditStickerRepo(logger);

// ── Birthday Takeover init ──
const birthdayRepository = require('./src/repositories/birthdayRepository');
const birthdayScheduler = require('./src/scheduler/birthdayScheduler');
global.botState.birthdayScheduler = 'stopped';
birthdayRepository.init(logger).catch((err) => logger.warn({ err }, '[Birthday] Repository init failed'));

// ── FX Market Intelligence init ──
const fxRepository = require('./src/repositories/fxRepository');
const fxCron = require('./src/scheduler/fxCron');

// Update global state with FX fields
global.botState.database = "initializing";
global.botState.fxScheduler = "stopped";

async function initializeFx() {
  try {
    await fxRepository.init(logger);
    if (!fxRepository.isPersistent()) {
      logger.error("[FX] Persistent storage unavailable — automatic FX jobs disabled");
      global.botState.database = "unavailable";
      return;
    }
    global.botState.database = "connected";

    const targetJid = process.env.FX_USD_IDR_TARGET_JID || process.env.GROUP_JID;
    if (!targetJid) {
      logger.warn("[FX] No target JID configured — delivery disabled");
    }

    fxCron.start({ logger, targetJid });
    global.botState.fxScheduler = "running";
    logger.info("[FX] Market intelligence started");
  } catch (err) {
    logger.error({ err }, "[FX] Initialization failed");
    global.botState.database = "error";
  }
}

function resolveBotSessions() {
    const isMulti = process.env.MULTI_SESSION === 'true' || Boolean(process.env.SESSIONS);
    if (!isMulti) {
        return null;
    }

    if (process.env.SESSIONS) {
        return process.env.SESSIONS.split(',').map(s => {
            const parts = s.trim().split(':');
            const id = parts[0].trim();
            const mode = parts[1] ? parts[1].trim() : (id === 'pribadi' ? 'self' : 'public');
            const defaultName = id === 'pribadi' ? 'Nomor Pribadi (Selfbot)' : (id === 'bot' ? 'Nomor Bot (Publik)' : `Sesi ${id}`);
            const defaultTursoId = id === 'bot'
                ? (process.env.TURSO_AUTH_SESSION_ID_BOT || process.env.TURSO_AUTH_SESSION_ID || 'default')
                : (process.env.TURSO_AUTH_SESSION_ID_PRIBADI || id);
            return {
                sessionId: id,
                sessionName: process.env[`SESSION_NAME_${id.toUpperCase()}`] || defaultName,
                authDir: process.env[`AUTH_DIR_${id.toUpperCase()}`] || `./auth/${id}`,
                botMode: process.env[`BOT_MODE_${id.toUpperCase()}`] || mode,
                tursoSessionId: process.env[`TURSO_AUTH_SESSION_ID_${id.toUpperCase()}`] || defaultTursoId
            };
        });
    }

    // Standard 2-session preset when MULTI_SESSION=true
    return [
        {
            sessionId: 'pribadi',
            sessionName: process.env.SESSION_NAME_PRIBADI || 'Nomor Pribadi (Selfbot)',
            authDir: process.env.AUTH_DIR_PRIBADI || './auth/pribadi',
            botMode: process.env.BOT_MODE_PRIBADI || 'self',
            tursoSessionId: process.env.TURSO_AUTH_SESSION_ID_PRIBADI || 'pribadi'
        },
        {
            sessionId: 'bot',
            sessionName: process.env.SESSION_NAME_BOT || 'Nomor Bot (Publik)',
            authDir: process.env.AUTH_DIR_BOT || './auth/bot',
            botMode: process.env.BOT_MODE_BOT || 'public',
            tursoSessionId: process.env.TURSO_AUTH_SESSION_ID_BOT || process.env.TURSO_AUTH_SESSION_ID || 'default'
        }
    ];
}

startBot({
    sessions: resolveBotSessions(),
    authDir: process.env.AUTH_DIR || './auth',
    botMode: process.env.BOT_MODE || 'dual',
    logger,
    onMessage: (sock, msg, sessionId) => messageHandler(sock, msg, logger, sessionId),
    onConnectionOpen: async () => {
        await Promise.all([
            newsScheduler.resume(),
            redditCron.resume(),
            fxCron.resume(),
            birthdayScheduler.resume(),
        ]);
    },
});

// Start schedulers after a short delay (let connection stabilize)
setTimeout(async () => {
    newsScheduler.start({ logger });
    redditCron.start({ logger });
    if (birthdayScheduler.start({ logger })) {
        global.botState.birthdayScheduler = 'running';
    }
    if (process.env.FX_USD_IDR_ENABLED !== "false") {
        await initializeFx();
    }
}, 10_000);
