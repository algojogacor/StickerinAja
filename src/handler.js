const path = require('path');
const fs = require('fs');
const commands = new Map();

// Auto-load all command modules
const commandsDir = path.join(__dirname, 'commands');
fs.readdirSync(commandsDir).filter(f => f.endsWith('.js')).forEach(f => {
    const cmd = require(path.join(commandsDir, f));
    if (cmd.names && cmd.execute) {
        for (const name of cmd.names) {
            commands.set(name, cmd);
        }
    }
});

// Module-level config — read from env once
const PREFIX = process.env.PREFIX || '!';
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

// Shared state across commands (per-user pack/author settings)
const state = new Map();

function shouldProcessMessage(msg, botMode = process.env.BOT_MODE || 'dual') {
    if (!msg || !msg.message) return false;

    const fromMe = Boolean(msg.key?.fromMe);
    const mode = String(botMode || 'dual').toLowerCase().trim();

    if (mode === 'self') {
        return fromMe;
    }
    if (mode === 'public') {
        return !fromMe;
    }
    // 'dual' or default fallback: process both fromMe and !fromMe
    return true;
}

function getSenderJid(msg, sock) {
    if (msg?.key?.fromMe) {
        if (sock?.user?.id) {
            return sock.user.id.replace(/:.*@/, '@');
        }
        return msg?.key?.participant || msg?.key?.remoteJid;
    }
    return msg?.key?.participant || msg?.key?.remoteJid;
}

function getSession(userJid) {
    const now = Date.now();
    const defaultPack = process.env.STICKERIN_BOT_NAME || 'Stikerin Aja';
    const defaultAuthor = process.env.STICKERIN_AUTHOR || 'Bot';

    if (!userJid) {
        return {
            pack: defaultPack,
            author: defaultAuthor,
            quality: 80,
            type: 'default',
            customExpiresAt: null
        };
    }

    if (!state.has(userJid)) {
        state.set(userJid, {
            pack: defaultPack,
            author: defaultAuthor,
            quality: 80,
            type: 'default',
            customExpiresAt: null
        });
    }

    const session = state.get(userJid);
    if (session.customExpiresAt && now > session.customExpiresAt) {
        session.pack = defaultPack;
        session.author = defaultAuthor;
        session.customExpiresAt = null;
    }

    return session;
}

function extractMessageContent(msg) {
    if (!msg?.message) return { text: '', quotedMsg: null, quotedStanza: null };

    let m = msg.message;
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;

    const text = (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        ''
    ).trim();

    const contextInfo =
        m.extendedTextMessage?.contextInfo ||
        m.imageMessage?.contextInfo ||
        m.videoMessage?.contextInfo ||
        m.documentMessage?.contextInfo;

    const quotedMsg = contextInfo?.quotedMessage || null;
    const quotedStanza = contextInfo?.stanzaId || null;

    return { text, quotedMsg, quotedStanza };
}

async function handler(sock, msg, logger, sessionId = null, botMode = null) {
    const remoteJid = msg.key?.remoteJid;
    if (!remoteJid) return;

    const resolvedMode = botMode || (sessionId && global.botSessions?.[sessionId]?.botMode) || process.env.BOT_MODE || 'dual';
    if (!shouldProcessMessage(msg, resolvedMode)) return;

    // Per-user session tracking (in groups, participant is user's direct JID; for fromMe, use bot user JID)
    const senderJid = getSenderJid(msg, sock);

    const { text: messageText, quotedMsg, quotedStanza } = extractMessageContent(msg);
    if (!messageText || !messageText.startsWith(PREFIX)) return;

    const [rawCmd, ...args] = messageText.slice(PREFIX.length).trim().split(/\s+/);
    const cmdName = rawCmd.toLowerCase();

    const cmd = commands.get(cmdName);
    if (!cmd) return;

    logger.info({ cmd: cmdName, chat: remoteJid, sender: senderJid, fromMe: Boolean(msg.key?.fromMe) }, `→ ${cmdName}`);

    try {
        await cmd.execute({
            sock, msg, args, cmdName, remoteJid, senderJid, quotedMsg, quotedStanza,
            session: getSession(senderJid),
            logger, PREFIX, state
        });
    } catch (err) {
        logger.error({ err, cmd: cmdName }, 'Command error');
        await sock.sendMessage(remoteJid, {
            text: `❌ Error: ${err.message || 'Unknown error'}`
        }, { quoted: msg });
    }
}

module.exports = {
    handler,
    commands,
    getSession,
    getSenderJid,
    shouldProcessMessage,
    extractMessageContent
};
