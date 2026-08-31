module.exports = {
    names: ['menu', 'help', 'list', 'all'],

    async execute({ sock, msg, args, remoteJid, session, logger, PREFIX }) {
        const topic = (args[0] || 'main').toLowerCase();
        const p = PREFIX;

        const menus = {
            main: `╭──「 *STICKERIN BOT* 」──
│ Bot serba bisa: Stiker WA, AI Vision, Downloader & Utilitas.
│
│ *Fitur Utama*
│ 1. Reply foto/video/GIF -> jadikan stiker otomatis.
│ 2. AI Vision & Chat pintar (${p}ai).
│ 3. TikTok Downloader tanpa watermark (${p}tiktok).
│ 4. Voice Note Generator (${p}tts).
│
│ *Daftar Menu*
│ ${p}menu basic     - foto ke stiker
│ ${p}menu efek      - efek & filter gambar
│ ${p}menu gif       - video/GIF animasi
│ ${p}menu text      - stiker teks, quote, emoji
│ ${p}menu meme      - meme sticker
│ ${p}gif <kata>     - stiker animasi GIPHY
│ ${p}ai <tanya>     - Groq AI Vision & Chat
│ ${p}tiktok <link>  - download video TikTok no WM
│ ${p}tts <teks>     - text to speech voice note
│ ${p}menu tools     - shortlink, QR, IP, password
│ ${p}menu pdf       - gambar ke PDF & scan dokumen
│ ${p}cuaca <kota>   - cek cuaca realtime
│ ${p}menu template  - label/warning/bubble/poster
│ ${p}menu convert   - toimg/togif/tomp4/sinfo
│ ${p}menu pack      - pack/author preset
│ ${p}menu all       - tampilkan semua menu
│
│ *Status chat ini*
│ Pack: *${session.pack}*
│ Author: *${session.author}*
│ Kualitas: *${session.quality}%*
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

            ai: `╭──「 *GROQ AI VISION & CHAT* 」──
│ Tanya jawab AI super cepat & cerdas.
│
│ *Lihat Gambar / Baca Teks:*
│ Reply foto/stiker lalu ketik:
│ ${p}ai
│   Deskripsi gambar otomatis.
│ ${p}ai apa teks di gambar ini?
│   Baca teks/OCR dalam gambar.
│ ${p}ai jelaskan maksud meme ini
│   Penjelasan konteks meme.
│
│ *Tanya Jawab Teks:*
│ ${p}ai <pertanyaan kamu>
│ ${p}tanya <pertanyaan kamu>
│ ${p}gpt <pertanyaan kamu>
╰──────────────────`,

            downloader: `╭──「 *SOCIAL DOWNLOADER* 」──
│ Download media media sosial tanpa watermark.
│
│ *TikTok Video & Audio:*
│ ${p}tiktok <link tiktok>
│   Download video MP4 no-watermark.
│ ${p}ttmp3 <link tiktok>
│   Download audio lagu TikTok saja.
│ ${p}tiktok <link> --sticker
│   Langsung jadikan stiker animasi!
│
│ *Instagram Reels & Foto:*
│ ${p}ig <link instagram>
│   Download Reels, Video, & Foto Instagram.
│ ${p}ig <link> --sticker
│   Ubah Reels/Foto Instagram jadi stiker WA!
│
│ Alias: ${p}tt, ${p}ig, ${p}instagram, ${p}reels, ${p}download, ${p}dl
╰──────────────────`,

            tts: `╭──「 *TEXT TO SPEECH (VN)* 」──
│ Ubah teks jadi pesan suara WhatsApp.
│
│ ${p}tts <teks>
│   Voice note bahasa Indonesia.
│ ${p}tts en <teks>
│   Voice note bahasa Inggris.
│ ${p}tts ja <teks>
│   Voice note bahasa Jepang.
│ ${p}tts ar <teks>
│   Voice note bahasa Arab.
│
│ Alias: ${p}vn, ${p}suara, ${p}voicenote
╰──────────────────`,

            tools: `╭──「 *UTILITAS & TOOLS* 」──
│ Kumpulan tool praktis serba guna.
│
│ ${p}short <link>
│   Perpendek URL panjang (TinyURL).
│ ${p}unshort <shortlink>
│   Cek dan buka link tujuan asli (keamanan).
│ ${p}qr <teks/link>
│   Buat gambar QR Code instan.
│ ${p}pass <panjang>
│   Generate password acak yang kuat (6-64 char).
│ ${p}ip <ip/domain>
│   Cek lokasi server, ISP, timezone & detail IP.
│ ${p}base64 encode/decode <teks>
│   Encode atau decode teks Base64.
│ ${p}hash <teks>
│   Generate MD5, SHA1, SHA256 dari teks.
╰──────────────────`,

            cuaca: `╭──「 *INFO CUACA REALTIME* 」──
│ Cek prakiraan cuaca seluruh dunia.
│
│ ${p}cuaca <nama kota>
│   Info suhu, kelembaban, angin & kondisi hari ini.
│
│ Contoh:
│ • ${p}cuaca Jakarta
│ • ${p}cuaca Surabaya
│ • ${p}cuaca Bandung
│
│ Alias: ${p}weather, ${p}prakiraan
╰──────────────────`,

            pdf: `╭──「 *GAMBAR KE PDF & SCAN* 」──
│ Konversi foto jadi dokumen PDF & Scanner.
│
│ *1 Gambar Cepat:*
│ Reply foto lalu ketik:
│ ${p}topdf
│   Foto jadi dokumen PDF (Warna asli).
│ ${p}scan
│   Foto jadi dokumen Scan (B&W High Contrast).
│
│ *Banyak Gambar (Multi Halaman):*
│ 1. Ketik \`${p}topdf\` atau \`${p}scan\` untuk mulai sesi.
│ 2. Kirim foto-foto dokumen secara berurutan.
│ 3. Ketik \`${p}pdfdone\` untuk download PDF!
│
│ Alias: ${p}topdf, ${p}scan, ${p}pdfdone, ${p}pdfcancel
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
        menus.vision = menus.ai;
        menus.tanya = menus.ai;
        menus.gpt = menus.ai;
        menus.tiktok = menus.downloader;
        menus.tt = menus.downloader;
        menus.dl = menus.downloader;
        menus.ig = menus.downloader;
        menus.instagram = menus.downloader;
        menus.reels = menus.downloader;
        menus.reel = menus.downloader;
        menus.vn = menus.tts;
        menus.suara = menus.tts;
        menus.tool = menus.tools;
        menus.utilitas = menus.tools;
        menus.util = menus.tools;
        menus.weather = menus.cuaca;
        menus.prakiraan = menus.cuaca;
        menus.topdf = menus.pdf;
        menus.scan = menus.pdf;
        menus.document = menus.pdf;
        menus.dokumen = menus.pdf;

        menus.all = `${menus.main}

${menus.basic}

${menus.efek}

${menus.gif}

${menus.text}

${menus.meme}

${menus.ai}

${menus.downloader}

${menus.tts}

${menus.tools}

${menus.cuaca}

${menus.pdf}

${menus.template}

${menus.convert}

${menus.preset}

${menus.pack}`;

        const text = menus[topic] || `Topik menu tidak dikenal: *${topic}*\n\nGunakan *${p}menu* untuk melihat daftar submenu.`;

        await sock.sendMessage(remoteJid, { text }, { quoted: msg });
        logger.info(`Menu sent to ${remoteJid}: ${topic}`);
    }
};
