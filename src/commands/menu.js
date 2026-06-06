module.exports = {
    names: ['menu', 'help', 'list', 'all'],

    async execute({ sock, msg, remoteJid, session, logger, PREFIX }) {
        const text = `╭──「 *STICKERIN BOT* 」──
│ Bot khusus bikin, edit, dan konversi stiker WhatsApp.
│
│ *Cara dasar*
│ 1. Reply foto/video/GIF/stiker.
│ 2. Ketik command di bawah.
│ 3. Opsi bisa digabung.
│
│ *Foto ke stiker*
│ ${PREFIX}s
│   Reply foto, bot ubah jadi stiker.
│ ${PREFIX}s --circle
│   Bentuk bulat.
│ ${PREFIX}s --crop
│   Potong persegi penuh.
│ ${PREFIX}s --rounded
│   Sudut membulat.
│ ${PREFIX}s --full
│   Masukkan gambar penuh tanpa crop.
│ ${PREFIX}s --q 90
│   Atur kualitas 1-100.
│
│ *Efek gambar*
│ ${PREFIX}s --gray
│   Hitam putih.
│ ${PREFIX}s --invert
│   Warna negative/invert.
│ ${PREFIX}s --sepia
│   Efek vintage/sepia.
│ ${PREFIX}s --blur 4
│   Blur. Angka 1-20.
│ ${PREFIX}s --sharpen
│   Pertajam gambar.
│ ${PREFIX}s --flip
│   Balik vertikal.
│ ${PREFIX}s --mirror
│   Balik horizontal.
│ ${PREFIX}s --rotate 90
│   Putar gambar.
│ ${PREFIX}s --rmbg
│   Transparankan background sederhana.
│   Paling cocok untuk background polos/kontras.
│
│ *Teks di gambar*
│ ${PREFIX}s --text halo dunia
│   Reply foto, teks ditaruh di bawah.
│ Contoh gabungan:
│ ${PREFIX}s --rounded --gray --text mood hari ini
│
│ *Video/GIF ke stiker animasi*
│ ${PREFIX}sgif
│   Reply video/GIF pendek.
│ ${PREFIX}sgif --start 2 --dur 4
│   Ambil mulai detik 2 selama 4 detik.
│ ${PREFIX}sgif --fps 12 --q 75
│   Atur fps 6-24 dan kualitas.
│ Contoh lengkap:
│ ${PREFIX}sgif --start 1 --dur 5 --fps 12 --q 80
│
│ *Meme sticker*
│ ${PREFIX}meme atas | bawah
│   Buat meme teks tanpa gambar.
│ Reply foto + ${PREFIX}meme atas | bawah
│   Buat meme dari foto yang direply.
│ Alias: ${PREFIX}smeme
│
│ *Stiker teks*
│ ${PREFIX}sticker halo dunia
│   Buat stiker dari teks.
│ ${PREFIX}stext halo dunia
│   Alias stiker teks.
│ ${PREFIX}sticker halo --bg #ff0000
│   Pakai background warna hex.
│
│ *Konversi balik*
│ ${PREFIX}toimg
│   Reply stiker statis → gambar PNG.
│ ${PREFIX}togif
│   Reply stiker animasi → file GIF.
│
│ *Shortcut cepat*
│ ${PREFIX}scircle
│   Sama seperti ${PREFIX}s --circle.
│ ${PREFIX}scrop
│   Sama seperti ${PREFIX}s --crop.
│ ${PREFIX}srounded
│   Sama seperti ${PREFIX}s --rounded.
│ ${PREFIX}stickergif
│   Sama seperti ${PREFIX}sgif.
│
│ *Pengaturan pack*
│ ${PREFIX}pack <nama>
│   Ganti nama pack untuk chat ini.
│ ${PREFIX}author <nama>
│   Ganti author untuk chat ini.
│
│ *Status chat ini*
│ Pack: *${session.pack}*
│ Author: *${session.author}*
│ Kualitas default: *${session.quality}%*
│
│ *Tips*
│ Kalau command gagal, coba kirim media lebih pendek/kecil.
│ Untuk GIF bagus: durasi 3-6 detik, fps 10-15.
│ Untuk --rmbg bagus: background polos lebih akurat.
╰──────────────────`;

        await sock.sendMessage(remoteJid, { text }, { quoted: msg });
        logger.info(`Menu sent to ${remoteJid}`);
    }
};
