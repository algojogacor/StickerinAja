const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QR = require('qrcode-terminal');
const fs = require('fs');
const { useTursoAuthState } = require('../utils/tursoAuthState');
const { setSock } = require('./socket');

function startBot({ authDir, logger, onMessage, onConnectionChange }) {
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    let reconnectTimer;
    let sock = null;

    async function connect() {
        const authState = await useTursoAuthState({ logger });
        const { state, saveCreds } = authState || (await useMultiFileAuthState(authDir));
        if (!authState) {
            logger.info(`Using file auth state: ${authDir}`);
        }

        let version = [2, 3000, 1035194821]; // Fallback ke versi terverifikasi
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
                setSock(sock);
                logger.info('✅ Bot connected!');
                logger.info(`📱 Logged in as: ${sock.user?.name || sock.user?.id}`);
                if (onConnectionChange) {
                    try { onConnectionChange({ status: 'connected', sock }); } catch (err) { logger.error({ err }, 'onConnectionChange error'); }
                }
            }
            if (connection === 'close') {
                global.botState.status = 'connecting';
                global.botState.qr = null;
                global.botState.user = null;
                setSock(null);
                if (onConnectionChange) {
                    try { onConnectionChange({ status: 'disconnected' }); } catch (err) { logger.error({ err }, 'onConnectionChange error'); }
                }
                const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = reason !== DisconnectReason.loggedOut;
                logger.info(`🔌 Disconnected: ${reason || 'unknown'} | Reconnect: ${shouldReconnect}`);
                if (shouldReconnect) {
                    reconnectTimer = setTimeout(connect, 3000);
                } else {
                    logger.warn('🚪 Logged out. Delete auth folder and restart.');
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Semua pesan masuk (grup + private)
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

module.exports = { startBot };
