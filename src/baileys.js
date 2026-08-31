const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QR = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { useTursoAuthState } = require('./utils/tursoAuthState');
const { setSock, getSock, clearSock } = require('./core/socket');
const { shouldProcessMessage } = require('./handler');

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
                logger: sessionLogger.child({ module: 'baileys' }),
                generateHighQualityLinkPreview: false,
                shouldIgnoreJid: jid => !jid || jid.endsWith('@broadcast') || jid === 'status@broadcast' || jid.endsWith('@newsletter')
            });

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
                    const shouldReconnect = reason !== DisconnectReason.loggedOut && reason !== 440;
                    sessionLogger.info(`🔌 [${sessionName}] Disconnected: ${reason || 'unknown'} | Reconnect: ${shouldReconnect}`);
                    if (shouldReconnect) {
                        reconnectTimer = setTimeout(connect, 3000);
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

    connect().catch(err => sessionLogger.error({ err }, `[${sessionName}] Fatal start error`));
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
    startSession
};
