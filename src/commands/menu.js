module.exports = {
    names: ['menu', 'help', 'list', 'all'],

    async execute({ sock, msg, args, remoteJid, session, logger, PREFIX }) {
        const topic = (args[0] || 'main').toLowerCase();
        const p = PREFIX;

        const menus = {
            main: `╭──「 *STICKERIN BOT* 」──
│ Bot WhatsApp multifungsi: stiker, berita, hiburan, kuis, meme.
│
│ *Stiker*
│ ${p}menu basic     - foto ke stiker
│ ${p}menu efek      - efek gambar
│ ${p}menu gif       - video/GIF animasi
│ ${p}menu text      - teks, quote, emoji
│ ${p}menu meme      - meme sticker
│ ${p}menu template  - label/warning/bubble/poster
│ ${p}menu convert   - toimg/togif/tomp4/sinfo
│ ${p}menu preset    - preset efek cepat
│ ${p}menu pack      - pack/author preset
│
│ *Otomatis & Hiburan*
│ ${p}menu news      - berita otomatis & manual
│ ${p}menu fun       - joke, quote, dog, cat, meme
│ ${p}menu quiz      - trivia & kuis
│ ${p}menu football  - ⚽ jadwal & skor sepak bola
│ ${p}menu decide    - 🎯 pilih, acak, koin, dadu
│ ${p}menu ultah      - 🎂 birthday manager
│ ${p}menu gid       - ⚙️ utilitas chat
│
│ *Status chat ini*
│ Pack: *${session.pack}*
│ Author: *${session.author}*
│ Kualitas default: *${session.quality}%*
╰──────────────────`,

            basic: `╭──「 *FOTO KE STIKER* 」──
│ Reply foto lalu pakai:
│ ${p}s
│   Ubah foto jadi stiker.
│ ${p}s --full
│   Masukkan gambar penuh tanpa crop.
│ ${p}s --crop
│   Potong persegi penuh.
│ ${p}s --circle
│   Bentuk bulat.
│ ${p}s --rounded
│   Sudut membulat.
│ ${p}s --q 90
│   Atur kualitas 1-100.
│
│ *Shortcut*
│ ${p}scrop, ${p}scircle, ${p}srounded
│
│ *Contoh*
│ Reply foto:
│ ${p}s --rounded --q 85
╰──────────────────`,

            efek: `╭──「 *EFEK STIKER* 」──
│ Reply foto lalu pakai:
│ ${p}s --gray
│   Hitam putih.
│ ${p}s --invert
│   Negative/invert.
│ ${p}s --sepia
│   Vintage sepia.
│ ${p}s --blur 4
│   Blur 1-20.
│ ${p}s --sharpen
│   Pertajam gambar.
│ ${p}s --flip
│   Balik vertikal.
│ ${p}s --mirror
│   Balik horizontal.
│ ${p}s --rotate 90
│   Putar gambar.
│ ${p}s --rmbg
│   Transparankan background sederhana.
│
│ *Teks overlay*
│ ${p}s --text halo
│ ${p}s --text halo --top
│ ${p}s --text halo --center
│ ${p}s --text halo --bottom
│ ${p}s --text halo --color #ffffff --stroke #000000 --size 42
│
│ *Contoh gabungan*
│ ${p}s --rounded --gray --text mood --bottom
╰──────────────────`,

            gif: `╭──「 *STIKER ANIMASI* 」──
│ Reply video/GIF lalu pakai:
│ ${p}sgif
│   Jadi stiker animasi, auto-compress aktif.
│ ${p}sgif --start 2 --dur 4
│   Mulai detik 2, durasi 4 detik.
│ ${p}sgif --fps 12
│   FPS 6-24. Rekomendasi 10-15.
│ ${p}sgif --q 80
│   Kualitas 1-100.
│ Jika hasil terlalu berat, bot otomatis coba fps/kualitas/durasi lebih ringan.
│
│ *Teks di animasi*
│ ${p}sgif --text halo --bottom
│ ${p}sgif --text wow --top --color #ffff00
│
│ *Contoh lengkap*
│ ${p}sgif --start 1 --dur 5 --fps 12 --q 80 --text gas
│
│ Alias: ${p}stickergif, ${p}stikergif
╰──────────────────`,

            text: `╭──「 *STIKER TEKS* 」──
│ ${p}sticker halo dunia
│   Buat stiker teks biasa.
│ ${p}stext halo dunia
│   Alias stiker teks.
│ ${p}sticker halo --bg #ff0000
│   Background warna hex.
│
│ *Quote sticker*
│ ${p}quote <teks>
│   Buat stiker quote.
│ Reply pesan teks + ${p}quote
│   Quote dari pesan yang direply.
│ Alias: ${p}squote
│
│ *Emoji sticker*
│ ${p}emoji 😂
│   Emoji besar jadi stiker.
│ Alias: ${p}semoji
╰──────────────────`,

            meme: `╭──「 *MEME STICKER* 」──
│ ${p}meme atas | bawah
│   Meme teks tanpa gambar.
│ Reply foto + ${p}meme atas | bawah
│   Meme dari foto.
│
│ *Contoh*
│ ${p}meme kerja keras | hasil nihil
│ Reply foto:
│ ${p}meme sebelum deploy | setelah deploy
│
│ Alias: ${p}smeme
╰──────────────────`,

            template: `╭──「 *TEMPLATE TEKS* 」──
│ ${p}label <teks>
│   Label gelap modern.
│ ${p}warning <teks>
│   Stiker peringatan kuning.
│ ${p}bubble <teks>
│   Bubble/chat style.
│ ${p}poster <teks>
│   Poster tebal.
│
│ *Contoh*
│ ${p}warning jangan spam
│ ${p}bubble aku setuju
│ ${p}poster mode serius
╰──────────────────`,

            convert: `╭──「 *KONVERSI & INFO* 」──
│ Reply stiker/media lalu pakai:
│ ${p}toimg
│   Stiker statis → gambar PNG.
│ ${p}togif
│   Stiker animasi → file GIF.
│ ${p}tomp4
│   Stiker animasi → video MP4.
│ ${p}sinfo
│   Info media/stiker: ukuran, format, dimensi, frame.
│
│ Alias info: ${p}stickerinfo
╰──────────────────`,

            preset: `╭──「 *PRESET EFEK CEPAT* 」──
│ Reply foto lalu pakai:
│ ${p}svintage
│   Efek vintage.
│ ${p}smono
│   Hitam putih tajam.
│ ${p}sdeepfried
│   Warna sangat kuat/deepfried.
│ ${p}sglow
│   Bright, saturated, sharpen.
│
│ Preset tetap bisa digabung:
│ ${p}svintage --text nostalgia --bottom
╰──────────────────`,

            pack: `╭──「 *PACK & AUTHOR* 」──
│ ${p}pack <nama>
│   Ganti nama pack untuk chat ini.
│ ${p}author <nama>
│   Ganti author untuk chat ini.
│
│ *Pack preset*
│ ${p}packpreset meme
│ ${p}packpreset anime
│ ${p}packpreset personal
│ ${p}packpreset clean
│
│ *Status sekarang*
│ Pack: *${session.pack}*
│ Author: *${session.author}*
│ Kualitas: *${session.quality}%*
╰──────────────────`,

            // ── NEW SECTIONS ──

            news: `╭──「 *BERITA OTOMATIS* 」──
│ *Jadwal otomatis (WIB)*
│ ☀️ 07:00 — Morning News
│ 🍽️ 12:00 — Midday Brief
│ 🌆 17:00 — Evening Brief
│ 🌙 21:00 — Nightcap
│
│ *Manual*
│ ${p}news
│   Morning news manual.
│ ${p}news midday
│   Midday brief manual.
│ ${p}news evening
│   Evening brief manual.
│ ${p}news nightcap
│   Nightcap manual.
│
│ Sumber: You.com Research API
│ Berita global: tech, science, trending, culture.
╰──────────────────`,

            fun: `╭──「 *HIBURAN & KONTEN* 」──
│ *Otomatis:* 8x/hari acak (08:00–22:00 WIB)
│
│ *Manual*
│ ${p}joke
│   Random joke atau fakta.
│ ${p}fact
│   Alias joke.
│ ${p}quote
│   Quote inspiratif dari tokoh dunia.
│ ${p}dog
│   Foto anjing random 🐕
│ ${p}cat
│   Foto kucing random 🐱
│ ${p}memegen <tpl> | <atas> | <bawah>
│   Generate meme dari template.
│ ${p}memegen
│   Lihat daftar template.
│
│ *Contoh memegen*
│ ${p}memegen doge | much wow | very code
│ ${p}memegen buzz | deployment | on friday
│
│ *Otomatis lainnya*
│ 🎭 Auto-meme: 2x/hari (~10:30 & ~18:30)
╰──────────────────`,

            quiz: `╭──「 *TRIVIA & KUIS* 」──
│ *Otomatis:* 1x/hari (14:00 WIB)
│
│ *Manual*
│ ${p}quiz
│   Mulai soal trivia.
│   Jawab langsung dengan A, B, C, atau D.
│   Jawaban otomatis muncul dalam 30 detik.
│ ${p}leaderboard
│   Lihat peringkat skor kuis.
│   Alias: ${p}lb
│
│ *Skor*
│ ✅ Jawaban benar: +10 pts
│ 🔥 Streak 3+: indikator api
│
│ Sumber: Open Trivia DB & Jeopardy!
╰──────────────────`,

            football: `╭──「 *⚽ SEPAK BOLA* 」──
│ *Jadwal otomatis*
│ ⚽ 00:00 WIB — Sync jadwal
│ 📢 07:00 WIB — Broadcast pagi
│ 🔄 10:00 WIB — Refresh jadwal
│ 📡 Pemantauan full-time otomatis
│
│ *Jadwal*
│ ${p}jadwal
│   Jadwal hari ini (semua liga).
│ ${p}jadwal epl
│   Jadwal Premier League.
│ ${p}jadwal ucl
│   Jadwal Champions League.
│ ${p}jadwal besok
│   Jadwal besok.
│ ${p}jadwal 15-07-2026
│   Jadwal tanggal spesifik.
│ ${p}jadwal [tim]
│   Cari jadwal tim.
│
│ *Skor*
│ ${p}skor
│   Skor hari ini (semua liga).
│ ${p}skor epl
│   Skor Premier League.
│ ${p}skor [tim]
│   Cari skor tim.
│
│ *Liga tersedia*
│ EPL, La Liga, Serie A, Bundesliga,
│ Ligue 1, UCL, UEL, UECL, World Cup
│
│ Notifikasi full-time & penundaan
│ otomatis dikirim ke grup.
╰──────────────────`,

            decide: `╭──「 *🎯 DECISION HELPER* 」──
│ ${p}pilih bakso | mi ayam | seblak
│   Pilih satu dari beberapa opsi.
│ ${p}acak @orang1 @orang2
│   Acak urutan orang.
│ ${p}bagitim 2 @orang1 @orang2 @orang3
│   Bagi orang ke dalam tim acak.
│ ${p}urutkan item A | item B | item C
│   Urutkan item secara acak.
│ ${p}koin
│   Lempar koin (Kepala/Ekor).
│ ${p}dadu
│   Lempar dadu 6 sisi.
│ ${p}dadu 20
│   Lempar dadu N sisi.
│ ${p}angka 1 100
│   Angka acak dalam rentang.
│ ${p}pasangan @a @b @c @d
│   Pasangkan orang secara acak.
│
│ Semua hasil menggunakan crypto.randomInt()
│ agar benar-benar acak & adil.
╰──────────────────`,

            ultah: `╭──「 *🎂 BIRTHDAY MANAGER* 」──
│ *CRUD Data*
│ ${p}ultah tambah @orang DD-MM
│ ${p}ultah ubah @orang DD-MM
│ ${p}ultah hapus @orang
│ ${p}ultah list
│
│ *Cek*
│ ${p}ultah hariini
│ ${p}ultah berikutnya
│
│ *Admin only*
│ ${p}ultah test @orang
│   Simulasi singkat [TEST MODE].
│ ${p}ultah mode on
│   Aktifkan Birthday Takeover.
│ ${p}ultah mode off
│   Nonaktifkan.
│
│ *Birthday Takeover*
│ 07:00 Lagu wajib 🎸
│ 09:00 Birthday Card 🎁
│ 12:00 Sesi ucapan 📢
│ 15:00 Spotlight 🌟
│ 18:00 Pengingat 🎊
│ 21:00 Recap 💌
│ 23:30 Closing 🌙
│
│ Semua cron non-ultah ditunda
│ otomatis di hari ulang tahun.
╰──────────────────`

        };

        // Aliases
        menus.shape = menus.basic;
        menus.effect = menus.efek;
        menus.effects = menus.efek;
        menus.animasi = menus.gif;
        menus.animation = menus.gif;
        menus.teks = menus.text;
        menus.quote = menus.text;
        menus.emoji = menus.text;
        menus.templates = menus.template;
        menus.konversi = menus.convert;
        menus.info = menus.convert;
        menus.presets = menus.preset;
        menus.setting = menus.pack;
        menus.settings = menus.pack;
        menus.berita = menus.news;
        menus.hiburan = menus.fun;
        menus.entertainment = menus.fun;
        menus.trivia = menus.quiz;
        menus.sepakbola = menus.football;
        menus.decision = menus.decide;
        menus.birthday = menus.ultah;
        menus.ulangtahun = menus.ultah;
        menus.gid = 'builtin';

        menus.all = `${menus.main}

${menus.basic}

${menus.efek}

${menus.gif}

${menus.text}

${menus.meme}

${menus.template}

${menus.convert}

${menus.preset}

${menus.pack}

${menus.news}

${menus.fun}

${menus.quiz}

${menus.football}

${menus.decide}

${menus.ultah}`;

        const text = menus[topic] || `Topik menu tidak dikenal: *${topic}*\n\nGunakan *${p}menu* untuk melihat daftar submenu.`;

        await sock.sendMessage(remoteJid, { text }, { quoted: msg });
        logger.info(`Menu sent to ${remoteJid}: ${topic}`);
    }
};
