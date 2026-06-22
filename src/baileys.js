const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QR = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { useTursoAuthState } = require('./utils/tursoAuthState');

// ─── Hermes Relay Queue ───
// Non-sticker-command messages are queued here for Hermes bridge to consume
const HERMES_QUEUE_MAX = 200;
const hermesMessageQueue = [];
const hermesLongPollResolvers = [];

function pushToHermesQueue(msg) {
    const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        timestamp: Date.now(),
        chatId: msg.key.remoteJid,
        senderId: msg.key.participant || msg.key.remoteJid,
        message: msg.message,
        key: msg.key,
    };
    hermesMessageQueue.push(entry);
    if (hermesMessageQueue.length > HERMES_QUEUE_MAX) hermesMessageQueue.shift();

    // Notify waiting long-pollers
    while (hermesLongPollResolvers.length > 0) {
        const resolve = hermesLongPollResolvers.shift();
        resolve([entry]);
    }
}

function startBot({ authDir, logger, onMessage }) {
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    let reconnectTimer;
    let sock = null;

    async function connect() {
        const authState = await useTursoAuthState({ logger });
        const { state, saveCreds } = authState || (await useMultiFileAuthState(authDir));
        if (!authState) {
            logger.info(`Using file auth state: ${authDir}`);
        }
        
        let version = [2, 3000, 1035194821]; // Fallback to current verified working version
        try {
            const latest = await fetchLatestBaileysVersion();
            version = latest.version;
            logger.info(`ℹ️ Using WA version: ${version.join('.')}`);
        } catch (err) {
            logger.warn({ err }, 'Failed to fetch latest WA version, using fallback');
        }

        sock = makeWASocket({
            version,
            auth: state,
            browser: Browsers.windows('StickerinBot'),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            logger: logger.child({ module: 'baileys' }),
            generateHighQualityLinkPreview: false,
            shouldIgnoreJid: jid => !jid.endsWith('@g.us') && !jid.endsWith('@s.whatsapp.net')
        });

        // Export globally for Hermes relay endpoints
        global.hermesSock = sock;

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                global.botState.status = 'qr';
                global.botState.qr = qr;
                QR.generate(qr, { small: true });
                logger.info('📱 Scan QR code above to login');
            }
            if (connection === 'open') {
                global.botState.status = 'connected';
                global.botState.qr = null;
                global.botState.user = sock.user;
                logger.info('✅ Bot connected!');
                logger.info(`📱 Logged in as: ${sock.user?.name || sock.user?.id}`);
            }
            if (connection === 'close') {
                global.botState.status = 'connecting';
                global.botState.qr = null;
                global.botState.user = null;
                global.hermesSock = null;
                const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                // 440 = conflict: replaced → don't auto-reconnect
                // Let Hermes bridge take over if it wants to connect
                const shouldReconnect = reason !== DisconnectReason.loggedOut && reason !== 440;
                logger.info(`🔌 Disconnected: ${reason || 'unknown'} | Reconnect: ${shouldReconnect}`);
                if (shouldReconnect) {
                    reconnectTimer = setTimeout(connect, 3000);
                } else {
                    logger.warn(reason === 440
                        ? '🔀 Conflict (440) — yielding to Hermes bridge. Will retry in 60s...'
                        : '🚪 Logged out. Delete auth folder and restart.');
                    if (reason === 440) {
                        reconnectTimer = setTimeout(connect, 60000);
                    }
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Listen for all messages (groups + private)
        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;
                try {
                    await onMessage(sock, msg);
                } catch (err) {
                    logger.error({ err }, 'Handler error');
                }
            }
        });

        return sock;
    }

    connect().catch(err => logger.error({ err }, 'Failed to start'));
}

// ─── Hermes Relay API (used by index.js HTTP server) ───
function hermesGetMessages(since) {
    if (since) {
        const idx = hermesMessageQueue.findIndex(m => m.id === since);
        const newMsgs = idx >= 0 ? hermesMessageQueue.slice(idx + 1) : hermesMessageQueue;
        return newMsgs;
    }
    return hermesMessageQueue.slice(-50);
}

function hermesLongPoll(timeoutMs = 25000) {
    return new Promise((resolve) => {
        if (hermesMessageQueue.length > 0) {
            resolve([hermesMessageQueue[hermesMessageQueue.length - 1]]);
            return;
        }
        const timer = setTimeout(() => {
            const idx = hermesLongPollResolvers.indexOf(resolve);
            if (idx >= 0) hermesLongPollResolvers.splice(idx, 1);
            resolve([]);
        }, timeoutMs);
        hermesLongPollResolvers.push((msgs) => {
            clearTimeout(timer);
            resolve(msgs);
        });
    });
}

function normalizeJid(jid) {
    // Auto-append WA domain suffix if missing
    if (jid.includes('@')) return jid;
    // Group IDs are typically long (10+ digits with hyphens) → @g.us
    // Phone numbers (shorter, may have country code) → @s.whatsapp.net
    if (jid.match(/^\d{10,}[-@]/) || jid.length >= 15) return jid + '@g.us';
    return jid + '@s.whatsapp.net';
}

async function hermesSendMessage(chatId, message, replyTo) {
    const sock = global.hermesSock;
    if (!sock) throw new Error('WhatsApp not connected');

    const jid = normalizeJid(chatId);
    const payload = { text: String(message || '') };
    const opts = replyTo ? { quoted: { id: replyTo, remoteJid: jid, fromMe: true } } : {};
    return sock.sendMessage(jid, payload, opts);
}

async function hermesSendTyping(chatId) {
    const sock = global.hermesSock;
    if (!sock) return;
    await sock.sendPresenceUpdate('composing', chatId);
}

module.exports = {
    startBot,
    hermesGetMessages,
    hermesLongPoll,
    hermesSendMessage,
    hermesSendTyping,
    pushToHermesQueue,
};
