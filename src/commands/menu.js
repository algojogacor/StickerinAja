module.exports = {
    names: ['menu', 'help', 'list', 'all'],

    async execute({ sock, msg, args, remoteJid, session, logger, PREFIX }) {
        const topic = (args[0] || 'main').toLowerCase();
        const p = PREFIX;

        const menus = {
            main: `╭──「 *STICKERIN BOT* 」──
│ Bot khusus bikin, edit, dan konversi stiker WhatsApp.
│
│ *Cara dasar*
│ 1. Reply foto/video/GIF/stiker.
│ 2. Ketik command.
│ 3. Opsi bisa digabung.
│
│ *Menu detail*
│ ${p}menu basic     - foto ke stiker
│ ${p}menu efek      - efek gambar
│ ${p}menu gif       - video/GIF animasi
│ ${p}menu text      - teks, quote, emoji
│ ${p}menu meme      - meme sticker
│ ${p}menu template  - label/warning/bubble/poster
│ ${p}menu convert   - toimg/togif/tomp4/sinfo
│ ${p}menu preset    - preset efek cepat
│ ${p}menu pack      - pack/author preset
│ ${p}menu all       - semua ringkasan
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
│   Jadi stiker animasi.
│ ${p}sgif --start 2 --dur 4
│   Mulai detik 2, durasi 4 detik.
│ ${p}sgif --fps 12
│   FPS 6-24. Rekomendasi 10-15.
│ ${p}sgif --q 80
│   Kualitas 1-100.
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
╰──────────────────`
        };

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

        menus.all = `${menus.main}

${menus.basic}

${menus.efek}

${menus.gif}

${menus.text}

${menus.meme}

${menus.template}

${menus.convert}

${menus.preset}

${menus.pack}`;

        const text = menus[topic] || `Topik menu tidak dikenal: *${topic}*\n\nGunakan *${p}menu* untuk melihat daftar submenu.`;

        await sock.sendMessage(remoteJid, { text }, { quoted: msg });
        logger.info(`Menu sent to ${remoteJid}: ${topic}`);
    }
};
