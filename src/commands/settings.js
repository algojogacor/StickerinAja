module.exports = {
    names: ['pack', 'author'],

    async execute({ sock, msg, args, cmdName, remoteJid, session, logger }) {
        const value = args.join(' '); // all args are the value since cmdName is separate

        if (cmdName === 'pack') {
            if (!value) {
                return sock.sendMessage(remoteJid, {
                    text: `📦 Pack saat ini: *${session.pack}*\n\nGunakan: *!pack <nama>*`
                }, { quoted: msg });
            }
            session.pack = value;
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
            await sock.sendMessage(remoteJid, {
                text: `✅ Author diubah ke: *${value}*`
            }, { quoted: msg });
            logger.info(`Author changed: ${value}`);
        }
    }
};
