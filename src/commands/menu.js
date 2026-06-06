module.exports = {
    names: ['menu', 'help', 'list', 'all'],

    async execute({ sock, msg, remoteJid, session, logger, PREFIX }) {
        const text = `╭──「 *STICKERIN BOT* 」──
│
│ ✨ *Stiker Biasa*
│ ${PREFIX}s — Balas foto → stiker
│ ${PREFIX}s --circle / --crop / --rounded
│ ${PREFIX}s --q 90 — Atur kualitas
│
│ 🎨 *Efek Stiker*
│ ${PREFIX}s --gray / --invert / --sepia
│ ${PREFIX}s --blur 4 / --sharpen
│ ${PREFIX}s --flip / --mirror / --rotate 90
│ ${PREFIX}s --rmbg — Transparankan background sederhana
│ ${PREFIX}s --text halo — Tambah teks ke gambar
│
│ 🎬 *Stiker Animasi*
│ ${PREFIX}sgif — Balas video/GIF
│ ${PREFIX}sgif --start 2 --dur 4 --fps 12
│ ${PREFIX}stickergif — Sama
│
│ 😂 *Meme Sticker*
│ ${PREFIX}meme atas | bawah
│ Reply gambar + ${PREFIX}meme atas | bawah
│
│ ✏️ *Stiker Teks*
│ ${PREFIX}sticker <teks> — Bikin dari teks
│ ${PREFIX}stext <teks> — Sama
│ ${PREFIX}sticker halo --bg #ff0000
│
│ 🎯 *Shortcut*
│ ${PREFIX}scircle — Stiker bulat instan
│ ${PREFIX}scrop — Stiker crop instan
│ ${PREFIX}srounded — Stiker rounded instan
│ ${PREFIX}toimg — Balas stiker → gambar
│ ${PREFIX}togif — Balas stiker animasi → GIF
│
│ ⚙️ *Pengaturan*
│ ${PREFIX}pack <nama> — Ganti pack name
│ ${PREFIX}author <nama> — Ganti author
│
│ 📦 Pack: *${session.pack}*
│ ✍️ Author: *${session.author}*
│ 🎨 Kualitas: *${session.quality}%*
╰──────────────────`;

        await sock.sendMessage(remoteJid, { text }, { quoted: msg });
        logger.info(`Menu sent to ${remoteJid}`);
    }
};
