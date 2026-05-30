module.exports = {
    names: ['menu', 'help', 'list', 'all'],

    async execute({ sock, msg, args, remoteJid, session, logger, PREFIX }) {
        const text = `╭──「 *STICKERIN BOT* 」──
│
│ ✨ *Stiker Biasa*
│ ${PREFIX}s — Balas foto → stiker
│ ${PREFIX}s --circle — Stiker bulat
│ ${PREFIX}s --crop — Stiker crop
│ ${PREFIX}s --rounded — Stiker rounded
│ ${PREFIX}s --q 90 — Atur kualitas
│
│ 🎬 *Stiker Animasi*
│ ${PREFIX}sgif — Balas video/GIF
│ ${PREFIX}stickergif — Sama
│
│ ✏️ *Stiker Teks*
│ ${PREFIX}sticker <teks> — Bikin dari teks
│ ${PREFIX}stext <teks> — Sama
│ ${PREFIX}sticker halo --bg #ff0000 — Dengan background
│
│ 🎯 *Shortcut*
│ ${PREFIX}scircle — Stiker bulat instan
│ ${PREFIX}scrop — Stiker crop instan
│ ${PREFIX}srounded — Stiker rounded instan
│ ${PREFIX}toimg — Balas stiker → gambar
│
│ ⚙️ *Pengaturan*
│ ${PREFIX}pack <nama> — Ganti pack name
│ ${PREFIX}author <nama> — Ganti author
│ ${PREFIX}menu — Tampilkan ini
│
│ 📦 Pack: *${session.pack}*
│ ✍️ Author: *${session.author}*
│ 🎨 Kualitas: *${session.quality}%*
╰──────────────────`;

        await sock.sendMessage(remoteJid, { text }, { quoted: msg });
        logger.info(`Menu sent to ${remoteJid}`);
    }
};
