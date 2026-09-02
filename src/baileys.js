const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QR = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { useTursoAuthState, deleteTursoSession, pruneTursoAuthState } = require('./utils/tursoAuthState');
const { setSock, getSock, clearSock } = require('./core/socket');
const { shouldProcessMessage } = require('./handler');

const sessionControllers = new Map();
const consecutiveQrTimeouts = new Map();
const reconnectAttempts = new Map();

function initSessionState(sessionId, sessionName, botMode) {
    if (!global.botSessions) global.botSessions = {};
    global.botSessions[sessionId] = {
        id: sessionId,
        name: sessionName || sessionId,
        status: 'connecting',
        qr: null,
        user: null,
        botMode: botMode || 'dual'
    };
}

function syncGlobalBotState() {
    if (!global.botSessions) return;
    const sessionList = Object.values(global.botSessions);
    if (sessionList.length === 0) return;

    // Pick first connected, or first with QR, or first session
    const connected = sessionList.find(s => s.status === 'connected');
    const withQr = sessionList.find(s => s.status === 'qr' && s.qr);
    const target = connected || withQr || sessionList[0];

    if (target && global.botState) {
        global.botState.status = target.status;
        global.botState.qr = target.qr;
        global.botState.user = target.user;
    }
}

function startSession({
    sessionId = 'default',
    sessionName = 'Default Session',
    authDir = './auth',
    botMode = process.env.BOT_MODE || 'dual',
    tursoSessionId = null,
    logger,
    onMessage,
    onConnectionOpen
}) {
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    initSessionState(sessionId, sessionName, botMode);
    const sessionLogger = logger.child({ session: sessionId });

    let reconnectTimer;
    let activeSock = null;
    let watchdogInterval = null;

    // Periodic garbage collector: runs every 6 hours to keep Turso auth state lean
    const targetTursoId = tursoSessionId || (sessionId === 'default' ? (process.env.TURSO_AUTH_SESSION_ID || 'default') : sessionId);
    const gcInterval = setInterval(() => {
        pruneTursoAuthState({ sessionId: targetTursoId, logger: sessionLogger }).catch(() => {});
    }, 6 * 60 * 60 * 1000);
    if (gcInterval?.unref) gcInterval.unref();

    async function connect() {
        try {
            const authState = await useTursoAuthState({
                logger: sessionLogger,
                sessionId: tursoSessionId || (sessionId === 'default' ? (process.env.TURSO_AUTH_SESSION_ID || 'default') : sessionId)
            });
            const { state, saveCreds } = authState || (await useMultiFileAuthState(authDir));
            if (!authState) {
                sessionLogger.info(`Using file auth state: ${authDir}`);
            }

            let version = [2, 3000, 1035194821]; // Fallback to verified version
            try {
                const latest = await fetchLatestBaileysVersion();
                version = latest.version;
                sessionLogger.info(`ℹ️ [${sessionName}] WA version: ${version.join('.')}`);
            } catch (err) {
                sessionLogger.warn({ err }, `[${sessionName}] Failed to fetch latest WA version, using fallback`);
            }

            const sock = makeWASocket({
                version,
                auth: state,
                browser: Browsers.windows(`Stickerin-${sessionId}`),
                syncFullHistory: false,
                markOnlineOnConnect: false,
                keepAliveIntervalMs: 25000,
                connectTimeoutMs: 30000,
                defaultQueryTimeoutMs: 30000,
                logger: sessionLogger.child({ module: 'baileys' }),
                generateHighQualityLinkPreview: false,
                shouldIgnoreJid: jid => !jid || jid.endsWith('@broadcast') || jid === 'status@broadcast' || jid.endsWith('@newsletter')
            });
            activeSock = sock;

            // Heartbeat watchdog: detect silent WebSocket stalls / query freezes
            if (!watchdogInterval) {
                watchdogInterval = setInterval(() => {
                    const sess = global.botSessions?.[sessionId];
                    if (sess?.status === 'connected' && activeSock?.ws) {
                        const readyState = activeSock.ws.readyState;
                        if (readyState !== 1) { // 1 = OPEN
                            sessionLogger.warn(`[Watchdog] ${sessionName} socket readyState is ${readyState} (not OPEN), forcing reconnect...`);
                            clearSock(activeSock, sessionId);
                            try { activeSock.ws.close(); } catch {}
                            try { activeSock.end?.(); } catch {}
                            sess.status = 'connecting';
                            syncGlobalBotState();
                            if (reconnectTimer) clearTimeout(reconnectTimer);
                            reconnectTimer = setTimeout(connect, 2000);
                        }
                    }
                }, 30_000);
            }

            sock.ev.on('connection.update', (update) => {
                const { connection, lastDisconnect, qr } = update;
                if (qr) {
                    global.botSessions[sessionId].status = 'qr';
                    global.botSessions[sessionId].qr = qr;
                    syncGlobalBotState();
                    sessionLogger.info(`📱 [${sessionName}] New QR code generated`);
                    QR.generate(qr, { small: true });
                }
                if (connection === 'open') {
                    setSock(sock, sessionId);
                    consecutiveQrTimeouts.set(sessionId, 0);
                    reconnectAttempts.set(sessionId, 0);
                    global.botSessions[sessionId].status = 'connected';
                    global.botSessions[sessionId].qr = null;
                    global.botSessions[sessionId].user = sock.user;
                    syncGlobalBotState();
                    sessionLogger.info(`✅ [${sessionName}] Connected! Logged in as: ${sock.user?.name || sock.user?.id}`);
                    if (sessionId === 'bot') {
                        sock.groupFetchAllParticipating().then(groups => {
                            global.botGroupJids = new Set(Object.keys(groups || {}));
                            sessionLogger.info(`[bot] Discovered ${global.botGroupJids.size} groups where bot is a member`);
                        }).catch(err => {
                            sessionLogger.debug({ err: err?.message }, '[bot] Failed to fetch participating groups');
                        });
                    }
                    Promise.resolve(onConnectionOpen?.(sock, sessionId)).catch((err) => {
                        sessionLogger.error({ err }, `[${sessionName}] Scheduler resume after reconnect failed`);
                    });
                }
                if (connection === 'close') {
                    if (sessionId === 'bot') {
                        global.botGroupJids = new Set();
                    }
                    const wasActiveSocket = clearSock(sock, sessionId);
                    if (!wasActiveSocket && getSock(sessionId)) {
                        sessionLogger.info(`[${sessionName}] Ignoring close event from a stale WhatsApp socket`);
                        return;
                    }
                    if (wasActiveSocket) {
                        global.botSessions[sessionId].status = 'connecting';
                        global.botSessions[sessionId].qr = null;
                        global.botSessions[sessionId].user = null;
                        syncGlobalBotState();
                    }
                    const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                    const isQrTimeout = reason === 408 || reason === DisconnectReason.timedOut;

                    if (isQrTimeout) {
                        const count = (consecutiveQrTimeouts.get(sessionId) || 0) + 1;
                        consecutiveQrTimeouts.set(sessionId, count);
                        if (count >= 3) {
                            if (global.botSessions?.[sessionId]) {
                                global.botSessions[sessionId].status = 'idle_qr';
                                syncGlobalBotState();
                            }
                            sessionLogger.warn(`⏸️ [${sessionName}] QR timeout reached limit (${count} cycles). Halting auto-reconnect to save resources. Use dashboard to scan.`);
                            return;
                        }
                    }

                    const shouldReconnect = reason !== DisconnectReason.loggedOut && reason !== 440;
                    sessionLogger.info(`🔌 [${sessionName}] Disconnected: ${reason || 'unknown'} | Reconnect: ${shouldReconnect}`);
                    if (shouldReconnect) {
                        const attempts = isQrTimeout
                            ? (consecutiveQrTimeouts.get(sessionId) || 1)
                            : ((reconnectAttempts.get(sessionId) || 0) + 1);
                        if (!isQrTimeout) reconnectAttempts.set(sessionId, attempts);

                        const backoffMs = Math.min(60000, Math.round(3000 * Math.pow(2, Math.min(attempts - 1, 4)) + Math.random() * 1000));
                        sessionLogger.info(`⏱️ [${sessionName}] Reconnecting in ${backoffMs}ms (attempt ${attempts})...`);
                        reconnectTimer = setTimeout(connect, backoffMs);
                    } else {
                        sessionLogger.warn(reason === 440
                            ? `🔀 [${sessionName}] Conflict (440) — yielding. Will retry in 60s...`
                            : `🚪 [${sessionName}] Logged out. Delete auth folder and restart.`);
                        if (reason === 440) {
                            reconnectTimer = setTimeout(connect, 60000);
                        }
                    }
                }
            });

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('messages.upsert', async ({ messages }) => {
                for (const msg of messages) {
                    if (!shouldProcessMessage(msg, botMode)) continue;
                    try {
                        await onMessage(sock, msg, sessionId);
                    } catch (err) {
                        sessionLogger.error({ err }, `[${sessionName}] Handler error`);
                    }
                }
            });

            return sock;
        } catch (err) {
            sessionLogger.error({ err }, `[${sessionName}] Failed to establish connection, retrying in 5s...`);
            reconnectTimer = setTimeout(connect, 5000);
        }
    }

    sessionControllers.set(sessionId, {
        restart: async () => {
            sessionLogger.info(`[${sessionName}] Manual restart requested`);
            consecutiveQrTimeouts.set(sessionId, 0);
            reconnectAttempts.set(sessionId, 0);
            if (reconnectTimer) clearTimeout(reconnectTimer);
            if (activeSock) {
                clearSock(activeSock, sessionId);
                try { activeSock.ws?.close(); } catch {}
                try { activeSock.end?.(); } catch {}
                activeSock = null;
            }
            if (global.botSessions?.[sessionId]) {
                global.botSessions[sessionId].status = 'connecting';
                syncGlobalBotState();
            }
            return connect();
        },
        logout: async () => {
            sessionLogger.info(`[${sessionName}] Manual logout requested, purging auth credentials`);
            consecutiveQrTimeouts.set(sessionId, 0);
            reconnectAttempts.set(sessionId, 0);
            if (reconnectTimer) clearTimeout(reconnectTimer);
            if (activeSock) {
                clearSock(activeSock, sessionId);
                try { await activeSock.logout?.(); } catch {}
                try { activeSock.ws?.close(); } catch {}
                try { activeSock.end?.(); } catch {}
                activeSock = null;
            }
            const targetTursoId = tursoSessionId || (sessionId === 'default' ? (process.env.TURSO_AUTH_SESSION_ID || 'default') : sessionId);
            try {
                await deleteTursoSession(targetTursoId);
                sessionLogger.info(`[${sessionName}] Purged Turso session data for ${targetTursoId}`);
            } catch (err) {
                sessionLogger.warn({ err }, `[${sessionName}] Failed to purge Turso session data`);
            }
            try {
                if (fs.existsSync(authDir)) {
                    fs.rmSync(authDir, { recursive: true, force: true });
                    sessionLogger.info(`[${sessionName}] Purged local auth dir: ${authDir}`);
                }
            } catch (err) {
                sessionLogger.warn({ err }, `[${sessionName}] Failed to purge local auth dir`);
            }
            if (global.botSessions?.[sessionId]) {
                global.botSessions[sessionId].status = 'connecting';
                global.botSessions[sessionId].user = null;
                global.botSessions[sessionId].qr = null;
                syncGlobalBotState();
            }
            return connect();
        }
    });

    connect().catch(err => sessionLogger.error({ err }, `[${sessionName}] Fatal start error`));
}

async function restartSession(sessionId) {
    const ctrl = sessionControllers.get(sessionId);
    if (!ctrl) return false;
    await ctrl.restart();
    return true;
}

async function logoutSession(sessionId) {
    const ctrl = sessionControllers.get(sessionId);
    if (!ctrl) return false;
    await ctrl.logout();
    return true;
}

function startBot(config) {
    const { sessions, authDir, botMode, logger, onMessage, onConnectionOpen } = config;

    if (Array.isArray(sessions) && sessions.length > 0) {
        logger.info(`🚀 Starting Multi-Session WhatsApp Manager with ${sessions.length} sessions...`);
        for (const session of sessions) {
            startSession({
                ...session,
                logger,
                onMessage,
                onConnectionOpen
            });
        }
    } else {
        // Single session fallback
        startSession({
            sessionId: 'default',
            sessionName: 'Default Session',
            authDir: authDir || process.env.AUTH_DIR || './auth',
            botMode: botMode || process.env.BOT_MODE || 'dual',
            logger,
            onMessage,
            onConnectionOpen
        });
    }
}

module.exports = {
    startBot,
    startSession,
    restartSession,
    logoutSession,
    pruneTursoAuthState
};
