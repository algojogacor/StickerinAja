const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

module.exports = {
    names: ['pack', 'botname', 'name', 'author', 'packpreset', 'id', 'jid', 'groupid'],

    async execute({ sock, msg, args, cmdName, remoteJid, session, logger }) {
        const value = args.join(' ');

        if (cmdName === 'packpreset') {
            const presets = {
                meme: { pack: 'Meme Sticker Pack', author: 'Stickerin Bot' },
                anime: { pack: 'Anime Sticker Pack', author: 'Stickerin Bot' },
                personal: { pack: 'Personal Sticker Pack', author: session.author || 'Me' },
                clean: { pack: 'Stickerin Aja', author: 'Bot' }
            };
            const key = value.toLowerCase();
            if (!key || !presets[key]) {
                return sock.sendMessage(remoteJid, {
                    text: 'Pack preset tersedia:\n*meme*, *anime*, *personal*, *clean*\n\nGunakan: *!packpreset meme*'
                }, { quoted: msg });
            }
            session.pack = presets[key].pack;
            session.author = presets[key].author;
            session.customExpiresAt = Date.now() + SIX_HOURS_MS;

            await sock.sendMessage(remoteJid, {
                text: `✅ Pack preset *${key}* aktif.\nPack: *${session.pack}*\nAuthor: *${session.author}*`
            }, { quoted: msg });
            logger.info(`Pack preset changed: ${key}`);
        }

        if (['pack', 'botname', 'name'].includes(cmdName)) {
            if (!value) {
                return sock.sendMessage(remoteJid, {
                    text: `📦 Pack saat ini: *${session.pack}*\n\nGunakan: *!pack <nama>*`
                }, { quoted: msg });
            }
            session.pack = value;
            session.customExpiresAt = Date.now() + SIX_HOURS_MS;

            await sock.sendMessage(remoteJid, {
                text: `✅ Pack name diubah ke: *${value}*`
            }, { quoted: msg });
            logger.info(`Pack changed: ${value}`);
        }

        if (cmdName === 'author') {
            if (!value) {
                return sock.sendMessage(remoteJid, {
                    text: `✍️ Author saat ini: *${session.author}*\n\nGunakan: *!author <nama>*`
                }, { quoted: msg });
            }
            session.author = value;
            session.customExpiresAt = Date.now() + SIX_HOURS_MS;

            await sock.sendMessage(remoteJid, {
                text: `✅ Author diubah ke: *${value}*`
            }, { quoted: msg });
            logger.info(`Author changed: ${value}`);
        }

        if (['id', 'jid', 'groupid'].includes(cmdName)) {
            const isGroup = remoteJid.endsWith('@g.us');
            const sender = msg.key?.participant || msg.key?.remoteJid || '';
            const lines = [
                '📋 *Informasi WhatsApp Chat ID*',
                '',
                `• *Chat JID*: \`${remoteJid}\``,
                `• *Tipe*: ${isGroup ? 'Grup WhatsApp' : 'Chat Pribadi'}`,
                sender ? `• *Sender*: \`${sender}\`` : null
            ].filter(Boolean);

            await sock.sendMessage(remoteJid, { text: lines.join('\n') }, { quoted: msg });
            return;
        }
    }
};
