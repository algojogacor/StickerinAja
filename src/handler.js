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
const BOT_NAME = process.env.STICKERIN_BOT_NAME || 'Stikerin Aja';
const BOT_AUTHOR = process.env.STICKERIN_AUTHOR || 'Bot';

// Shared state across commands (pack/author settings)
const state = new Map();

function getSession(jid) {
    if (!state.has(jid)) {
        state.set(jid, {
            pack: BOT_NAME,
            author: BOT_AUTHOR,
            quality: 80,
            type: 'default'
        });
    }
    return state.get(jid);
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

async function handler(sock, msg, logger) {
    const remoteJid = msg.key?.remoteJid;
    if (!remoteJid) return;

    const { text: messageText, quotedMsg, quotedStanza } = extractMessageContent(msg);
    if (!messageText || !messageText.startsWith(PREFIX)) return;

    const [rawCmd, ...args] = messageText.slice(PREFIX.length).trim().split(/\s+/);
    const cmdName = rawCmd.toLowerCase();

    const cmd = commands.get(cmdName);
    if (!cmd) return;

    logger.info({ cmd: cmdName, chat: remoteJid }, `→ ${cmdName}`);

    try {
        await cmd.execute({
            sock, msg, args, cmdName, remoteJid, quotedMsg, quotedStanza,
            session: getSession(remoteJid),
            logger, PREFIX, state
        });
    } catch (err) {
        logger.error({ err, cmd: cmdName }, 'Command error');
        await sock.sendMessage(remoteJid, {
            text: `❌ Error: ${err.message || 'Unknown error'}`
        }, { quoted: msg });
    }
}

module.exports = { handler, commands, getSession, extractMessageContent };
