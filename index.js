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
const { handler, extractMessageContent, shouldProcessMessage, commands, getSenderJid, isMessageStale } = require('./src/handler');
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

// ⚡ Global Process Crash Handlers to prevent container teardown on transient rejections
process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, '[Process] Unhandled Promise Rejection');
});
process.on('uncaughtException', (err) => {
    logger.fatal({ err }, '[Process] Uncaught Exception — process may be unstable');
});

const PREFIX = process.env.PREFIX || '!';
const birthdayTakeover = require('./src/services/birthdayTakeoverService');

// In-memory message deduplication cache across sessions (1-hour retention to prevent reconnect replay)
const processedMessageIds = new Map();
const MAX_DEDUP_CACHE_SIZE = 5000;
const DEDUP_TTL_MS = 60 * 60 * 1000;

function isDuplicateMessage(messageId) {
    if (!messageId) return false;
    const now = Date.now();
    if (processedMessageIds.has(messageId)) {
        return true;
    }
    // Prune stale entries when cache grows
    if (processedMessageIds.size >= MAX_DEDUP_CACHE_SIZE) {
        for (const [id, time] of processedMessageIds.entries()) {
            if (now - time > DEDUP_TTL_MS) processedMessageIds.delete(id);
        }
        // If still full after TTL cleanup, drop oldest 500 entries (FIFO eviction)
        if (processedMessageIds.size >= MAX_DEDUP_CACHE_SIZE) {
            let count = 0;
            for (const id of processedMessageIds.keys()) {
                processedMessageIds.delete(id);
                if (++count >= 500) break;
            }
        }
    }
    processedMessageIds.set(messageId, now);
    return false;
}

function shouldPribadiYield(msg) {
    const remoteJid = msg?.key?.remoteJid;
    if (!remoteJid) return false;
    const botSession = global.botSessions?.['bot'];
    if (botSession?.status !== 'connected') return false;

    // 1. Yield in groups where bot is a member
    if (remoteJid.endsWith('@g.us')) {
        return Boolean(global.botGroupJids && global.botGroupJids.has(remoteJid));
    }

    // 2. Yield in 1-on-1 private chat with the bot
    const botJid = botSession?.user?.id ? String(botSession.user.id).replace(/:.*@/, '@').toLowerCase().trim() : null;
    if (!botJid) return false;
    const cleanRemote = String(remoteJid).replace(/:.*@/, '@').toLowerCase().trim();
    return cleanRemote === botJid;
}

async function messageHandler(sock, msg, logger, sessionId) {
    const sessionConfig = sessionId && global.botSessions?.[sessionId];
    const botMode = sessionConfig?.botMode || process.env.BOT_MODE || 'dual';
    if (!shouldProcessMessage(msg, botMode)) return;

    // Guard against stale messages replayed during WhatsApp reconnects or offline sync
    if (isMessageStale(msg)) {
        logger?.warn?.({ msgId: msg.key?.id, sessionId, remoteJid: msg.key?.remoteJid }, '[Message] Dropped stale message replayed after reconnect');
        return;
    }

    const { text: messageText, quotedMsg, quotedStanza } = extractMessageContent(msg);

    // Birthday DM session interception (Confess & Prediction outreach)
    if (!msg.key?.fromMe && !msg.key?.remoteJid?.endsWith('@g.us')) {
        try {
            const handledDm = await birthdayTakeover.handleIncomingDm(sock, msg, messageText, logger);
            if (handledDm) return;
        } catch (dmErr) {
            logger.debug({ err: dmErr }, '[Birthday] Error handling incoming DM');
        }
    }

    const isGroup = Boolean(msg.key?.remoteJid?.endsWith('@g.us'));
    const isPrefixed = Boolean(messageText && messageText.startsWith(PREFIX));
    const rawCmd = isPrefixed ? messageText.slice(PREFIX.length).trim().split(/\s+/)[0]?.toLowerCase() : null;
    const isKnownCommand = Boolean(rawCmd && commands.has(rawCmd));

    // If it is a known bot command, process normally
    if (isKnownCommand) {
        // Prevent double response in shared groups or in 1-on-1 DM with the bot
        if (sessionId === 'pribadi' && shouldPribadiYield(msg)) {
            logger.debug({ msgId: msg.key?.id, remoteJid: msg.key?.remoteJid }, '[Multi-Session] Skipped command on pribadi session in favor of connected bot session');
            return;
        }

        // Deduplicate message ID across sessions
        if (msg.key?.id && isDuplicateMessage(msg.key.id)) {
            logger.debug({ msgId: msg.key?.id, sessionId }, '[Multi-Session] Message ID already claimed by another session — skipping');
            return;
        }

        return handler(sock, msg, logger, sessionId, botMode);
    }

    // Active stateful session interception (e.g. PDF multi-page creation)
    // CRITICAL: Checked before isPrefixed so plain images (without caption) are captured
    const pdfCmd = commands.get('pdf');
    if (pdfCmd?.handleActiveSession) {
        if (sessionId === 'pribadi' && shouldPribadiYield(msg)) {
            return;
        }
        try {
            const senderJid = getSenderJid(msg, sock);
            const handled = await pdfCmd.handleActiveSession({
                sock, msg, senderJid, remoteJid: msg.key?.remoteJid, logger, messageText, PREFIX
            });
            if (handled) return;
        } catch (sessionErr) {
            logger.warn({ err: sessionErr }, '[Index] Active session handling error');
        }
    }

    // Interactive group messages during Birthday Takeover (Truth, Photo Story, Memory Wall, Roast, Wish Jar, Quests)
    if (!msg.key?.fromMe && isGroup) {
        if (sessionId === 'pribadi' && shouldPribadiYield(msg)) {
            return;
        }
        if (msg.key?.id && isDuplicateMessage(msg.key.id)) return;

        try {
            const handled = await birthdayTakeover.handleInteractiveGroupMessage(sock, msg, messageText, quotedStanza, quotedMsg, logger, { isKnownCommand });
            if (handled) return;
        } catch (error) {
            logger.debug({ err: error }, '[Birthday] Failed to process interactive message');
        }
    }

    // Fallback for remaining prefixed commands
    if (isPrefixed) {
        if (sessionId === 'pribadi' && shouldPribadiYield(msg)) {
            return;
        }

        if (msg.key?.id && isDuplicateMessage(msg.key.id)) {
            return;
        }

        return handler(sock, msg, logger, sessionId, botMode);
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
    } else if (url.pathname === '/api/restart-session') {
        const reqSession = url.searchParams.get('session') || 'pribadi';
        const { restartSession } = require('./src/baileys');
        const success = await restartSession(reqSession);
        res.writeHead(success ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success, action: 'restart', session: reqSession }));
    } else if (url.pathname === '/api/logout-session') {
        const reqSession = url.searchParams.get('session') || 'pribadi';
        const { logoutSession } = require('./src/baileys');
        const success = await logoutSession(reqSession);
        res.writeHead(success ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success, action: 'logout', session: reqSession }));
    } else if (url.pathname === '/api/birthday/trigger') {
        const event = url.searchParams.get('event') || 'memory_wall';
        const targetGroup = url.searchParams.get('group');
        const force = url.searchParams.get('force') === 'true';
        const bScheduler = require('./src/scheduler/birthdayScheduler');
        const bService = require('./src/services/birthdayService');
        const bRepo = require('./src/repositories/birthdayRepository');

        try {
            const groups = targetGroup ? [targetGroup] : await bScheduler.getTargetGroups();
            const results = [];

            for (const g of groups) {
                if (force) {
                    const today = bService.getWIBToday();
                    const state = await bRepo.getTakeoverState(g, today.dateStr);
                    if (state?.sentEvents?.includes(event)) {
                        state.sentEvents = state.sentEvents.filter(e => e !== event);
                        await bRepo.setTakeoverState(g, today.dateStr, state);
                    }
                }
                const resRun = await bScheduler.runEventForGroup(event, g);
                results.push({ group: g, success: resRun });
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, event, results }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
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
            const mode = parts[1] ? parts[1].trim() : (id === 'pribadi' ? 'dual' : 'public');
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
            botMode: process.env.BOT_MODE_PRIBADI || 'dual',
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
