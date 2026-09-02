// Command: !ai / !tanya / !vision / !gpt — Multimodal Groq AI Vision & Text Chat
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { analyzeImage, chatText } = require('../services/aiVisionService');

async function downloadMedia(sockOrMsg, msgOrQuoted, quotedMsgOrStanza, quotedStanzaParam) {
    let sock = null, msg, quotedMsg, quotedStanza;
    if (sockOrMsg && sockOrMsg.user) {
        sock = sockOrMsg;
        msg = msgOrQuoted;
        quotedMsg = quotedMsgOrStanza;
        quotedStanza = quotedStanzaParam;
    } else {
        msg = sockOrMsg;
        quotedMsg = msgOrQuoted;
        quotedStanza = quotedMsgOrStanza;
        sock = require('../core/socket').getSock();
    }

    try {
        const unwrap = (m) => m?.ephemeralMessage?.message ||
            m?.viewOnceMessage?.message ||
            m?.viewOnceMessageV2?.message ||
            m?.viewOnceMessageV2Extension?.message ||
            m?.documentWithCaptionMessage?.message ||
            m;

        if (quotedMsg) {
            const contextInfo =
                msg.message?.extendedTextMessage?.contextInfo ||
                msg.message?.imageMessage?.contextInfo ||
                msg.message?.videoMessage?.contextInfo ||
                msg.message?.documentMessage?.contextInfo ||
                msg.message?.stickerMessage?.contextInfo;

            const participant = contextInfo?.participant || msg.key.participant || msg.key.remoteJid;

            const myPn = sock?.user?.id?.split(':')[0]?.split('@')[0];
            const myLid = sock?.user?.lid?.split(':')[0]?.split('@')[0];
            const partClean = participant?.split(':')[0]?.split('@')[0];
            const isQuotedFromMe = !contextInfo?.participant
                ? Boolean(msg.key?.fromMe)
                : Boolean((myPn && partClean === myPn) || (myLid && partClean === myLid));

            return await downloadMediaMessage(
                {
                    key: {
                        id: quotedStanza,
                        remoteJid: msg.key.remoteJid,
                        fromMe: isQuotedFromMe,
                        participant
                    },
                    message: unwrap(quotedMsg)
                },
                'buffer',
                {},
                { logger: console }
            );
        }
        return await downloadMediaMessage(msg, 'buffer', {}, { logger: console });
    } catch (err) {
        return null;
    }
}

function hasImageMedia(msg, quotedMsg) {
    const unwrap = (m) => m?.ephemeralMessage?.message ||
        m?.viewOnceMessage?.message ||
        m?.viewOnceMessageV2?.message ||
        m?.viewOnceMessageV2Extension?.message ||
        m?.documentWithCaptionMessage?.message ||
        m;
    const directM = unwrap(msg?.message);
    const quotedM = unwrap(quotedMsg);

    return !!(directM?.imageMessage || directM?.stickerMessage ||
              quotedM?.imageMessage || quotedM?.stickerMessage);
}

module.exports = {
    names: ['ai', 'tanya', 'ask', 'gpt', 'vision', 'baca', 'deskripsi'],

    async execute({ sock, msg, args, cmdName, remoteJid, quotedMsg, quotedStanza, session, logger, PREFIX }) {
        const queryText = (args || []).join(' ').trim();
        const isMedia = hasImageMedia(msg, quotedMsg);

        // Case 1: Image / Sticker Vision Analysis
        if (isMedia) {
            const progressMsg = await sock.sendMessage(
                remoteJid,
                { text: '👁️ *Groq Vision:* Menganalisis gambar...' },
                { quoted: msg }
            );

            try {
                const buffer = await downloadMedia(sock, msg, quotedMsg, quotedStanza);
                if (!buffer) {
                    return sock.sendMessage(
                        remoteJid,
                        { text: '⚠️ Gagal mengunduh gambar/stiker yang direply.' },
                        { quoted: msg }
                    );
                }

                const result = await analyzeImage({
                    imageBuffer: buffer,
                    prompt: queryText,
                    logger
                });

                if (!result.success) {
                    return sock.sendMessage(
                        remoteJid,
                        { text: `❌ *Gagal menganalisis gambar:*\n${result.error}` },
                        { quoted: msg }
                    );
                }

                const replyText = `🤖 *AI Vision:*\n\n${result.text}`;
                await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
                logger?.info({ feature: 'ai_vision', prompt: queryText }, 'AI Vision answered successfully');
            } catch (err) {
                logger?.error({ err }, '[AI Vision] Execution error');
                await sock.sendMessage(
                    remoteJid,
                    { text: '❌ Terjadi kesalahan saat memproses gambar.' },
                    { quoted: msg }
                );
            }
            return;
        }

        // Case 2: No Image & No Prompt -> Show Help Menu
        if (!queryText) {
            const helpText = `╭──「 *GROQ AI VISION & CHAT* 」──
│ Tanya jawab AI super cepat & cerdas.
│
│ *1. Lihat Foto / Baca Teks Gambar:*
│ Reply foto/stiker dengan:
│ • *${PREFIX}ai* (deskripsi gambar otomatis)
│ • *${PREFIX}ai apa teks di gambar ini?*
│ • *${PREFIX}ai jelaskan maksud meme ini*
│
│ *2. Tanya Jawab Teks Biasa:*
│ • *${PREFIX}ai <pertanyaan kamu>*
│ • *${PREFIX}tanya rekomendasi laptop coding*
│ • *${PREFIX}gpt buatkan pantun lucu*
│
│ Alias: *${PREFIX}tanya*, *${PREFIX}vision*, *${PREFIX}gpt*
╰──────────────────`;
            return sock.sendMessage(remoteJid, { text: helpText }, { quoted: msg });
        }

        // Case 3: Text-only AI Chat
        try {
            const result = await chatText({ prompt: queryText, logger });

            if (!result.success) {
                return sock.sendMessage(
                    remoteJid,
                    { text: `❌ *Gagal:* ${result.error}` },
                    { quoted: msg }
                );
            }

            const replyText = `🤖 *AI:*\n\n${result.text}`;
            await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
            logger?.info({ feature: 'ai_text', query: queryText }, 'AI text query answered successfully');
        } catch (err) {
            logger?.error({ err }, '[AI Chat] Execution error');
            await sock.sendMessage(
                remoteJid,
                { text: '❌ Terjadi kesalahan saat memproses pertanyaan AI.' },
                { quoted: msg }
            );
        }
    }
};
