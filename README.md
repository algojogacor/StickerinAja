# ⚡ Stickerin Bot (WhatsApp Sticker Maker)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-20+-blue.svg)](https://nodejs.org)
[![Docker Support](https://img.shields.io/badge/docker-supported-blue.svg)](https://www.docker.com/)

**Stickerin Bot** adalah bot WhatsApp pembuat stiker premium, cepat, dan hemat memori yang dibangun menggunakan **Node.js** dan library **[@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys)**. Bot ini dirancang agar dapat berjalan dengan stabil bahkan di server dengan spesifikasi rendah (seperti gratisan **Koyeb 512MB RAM**) tanpa mengalami crash akibat kebocoran memori (*OOM - Out of Memory*).

---

## ✨ Fitur Unggulan

*   🖼️ **Foto ke Stiker**: Mengubah gambar langsung atau membalas (reply) gambar menjadi stiker.
*   🎬 **Video ke Stiker Animasi**: Mengonversi video pendek / GIF menjadi stiker animasi (`.webp`).
*   ✏️ **Teks ke Stiker**: Membuat stiker berisi tulisan secara instan dengan dukungan penggantian warna latar belakang (`--bg #warna`).
*   🎯 **Transformasi Bentuk**: Mendukung pembuatan stiker berbentuk bulat (*circle*), kotak (*crop*), maupun sudut membulat (*rounded*).
*   🎨 **Efek Stiker**: Grayscale, invert, sepia, blur, sharpen, rotate, mirror, background transparan sederhana, dan teks overlay.
*   😂 **Meme Sticker**: Membuat meme sticker dari gambar atau teks dengan format caption atas/bawah.
*   💬 **Quote, Emoji, dan Template**: Membuat stiker quote, emoji besar, label, warning, bubble, dan poster teks.
*   ⚡ **Preset Efek Cepat**: Shortcut efek seperti vintage, mono, deepfried, dan glow.
*   🎨 **Konfigurasi Kualitas**: Menyesuaikan tingkat kompresi kualitas stiker secara langsung saat mengirim perintah.
*   ⚙️ **Pengaturan Dinamis per Chat**: Mengubah nama paket (*pack name*) dan pembuat (*author*) stiker langsung melalui ruang obrolan.
*   🖼️ **Stiker ke Gambar**: Mengonversi stiker statis kembali menjadi gambar biasa (`!toimg`).
*   🎞️ **Stiker Animasi ke GIF/MP4**: Mengonversi animated sticker kembali menjadi file GIF (`!togif`) atau MP4 (`!tomp4`).
*   🛡️ **Optimasi Performa Ekstrim**:
    *   **Byte-Aware LRU Cache**: Caching pintar berbasis hash untuk stiker teks & gambar agar tidak memproses ulang file yang sama, dengan batas memori ketat (20MB untuk gambar, 10MB untuk teks).
    *   **Memory Queues**: Antrean eksekusi ffmpeg (max 1 proses concurrent) dan sharp/canvas (max 2 proses concurrent) untuk mencegah lonjakan CPU/RAM.
    *   **Async File I/O**: Operasi tulis/baca file sementara menggunakan metode asinkron (non-blocking).
    *   **Garbage Collection Proaktif**: Membebaskan buffer memori yang tidak lagi digunakan sesegera mungkin.

---

## 🛠️ Prasyarat (Prerequisites)

Sebelum menjalankan bot ini, pastikan sistem Anda sudah terinstal:
1.  **Node.js v20** atau versi yang lebih baru.
2.  **FFmpeg** (diperlukan untuk pemrosesan video stiker animasi).
    *   *Windows*: Unduh dari situs resmi atau gunakan `winget install Gyan.FFmpeg`.
    *   *Linux (Ubuntu/Debian)*: `sudo apt update && sudo apt install -y ffmpeg`
    *   *macOS*: `brew install ffmpeg`

---

## 🚀 Panduan Instalasi Lokal

1.  **Clone Repositori**
    ```bash
    git clone https://github.com/username/stickerin-bot.git
    cd stickerin-bot
    ```

2.  **Instal Dependensi**
    ```bash
    npm install
    ```

3.  **Konfigurasi Variabel Lingkungan**
    Salin file `.env.example` menjadi `.env` lalu sesuaikan pengaturannya:
    ```bash
    cp .env.example .env
    ```

4.  **Jalankan Bot**
    *   **Mode Pengembangan (Auto-reload)**:
        ```bash
        npm run dev
        ```
    *   **Mode Produksi**:
        ```bash
        npm start
        ```

5.  **Hubungkan WhatsApp**
    Pindai (scan) kode QR yang muncul di terminal menggunakan fitur **Perangkat Tertaut (Linked Devices)** di WhatsApp Anda.

---

## ⚙️ Variabel Lingkungan (.env)

Berikut adalah daftar variabel lingkungan yang dapat Anda gunakan di file `.env`:

| Variabel | Deskripsi | Default |
| :--- | :--- | :--- |
| `PREFIX` | Karakter awalan perintah bot. | `!` |
| `STICKERIN_BOT_NAME` | Nama default pembuat paket stiker. | `Stikerin Aja` |
| `STICKERIN_AUTHOR` | Nama default pembuat stiker (author). | `Bot` |
| `NODE_ENV` | Mode aplikasi (`development` atau `production`). | `development` |
| `LOG_LEVEL` | Tingkat detail pencatatan log pino (`info`, `debug`, `error`, dll). | `info` |
| `AUTH_DIR` | Folder penyimpanan sesi WhatsApp agar tidak perlu scan ulang. | `./auth` |
| `TURSO_DATABASE_URL` | URL database Turso/libSQL untuk menyimpan sesi WhatsApp secara persisten. Jika kosong, bot memakai `AUTH_DIR`. | kosong |
| `TURSO_AUTH_TOKEN` | Token akses Turso untuk database di atas. | kosong |
| `TURSO_AUTH_SESSION_ID` | ID session auth di Turso, berguna jika satu database dipakai untuk beberapa bot. | `default` |
| `TEMP_DIR` | Folder penyimpanan file media sementara. | `./temp` |
| `KEEP_TEMP_MINUTES` | Jeda waktu penghapusan file temp lama (dalam menit). | `5` |
| `MAX_FILE_SIZE` | Ukuran file media maksimal yang diizinkan (dalam byte). | `10485760` (10MB) |

---

## 📑 Panduan Perintah (Commands)

Kirim pesan ke bot menggunakan awalan yang telah diatur (default: `!`).

| Perintah | Deskripsi | Cara Penggunaan / Contoh |
| :--- | :--- | :--- |
| `!menu` | Menampilkan menu utama dan daftar submenu. | `!menu`, `!menu efek`, `!menu gif`, `!menu all` |
| `!s` | Mengubah gambar (atau balas/reply gambar) menjadi stiker. | `!s` (sebagai caption gambar) atau balas gambar dengan `!s` |
| `!s --circle` | Membuat stiker bulat instan dari gambar. | `!s --circle` (atau singkat `-o`) |
| `!s --crop` | Memotong gambar secara persegi pas di tengah. | `!s --crop` (atau singkat `-c`) |
| `!s --rounded` | Membuat stiker dengan sudut membulat. | `!s --rounded` (atau singkat `-r`) |
| `!s --q <angka>` | Menentukan kualitas kompresi stiker (1-100). | `!s --q 70` (kualitas lebih rendah = proses lebih cepat) |
| `!s --gray` | Membuat stiker grayscale/hitam putih. | Balas gambar dengan `!s --gray` |
| `!s --invert` | Membuat efek negative/invert. | Balas gambar dengan `!s --invert` |
| `!s --sepia` | Membuat efek sepia. | Balas gambar dengan `!s --sepia` |
| `!s --blur <angka>` | Membuat efek blur. | Balas gambar dengan `!s --blur 4` |
| `!s --sharpen` | Mempertajam gambar sebelum jadi stiker. | Balas gambar dengan `!s --sharpen` |
| `!s --flip` / `!s --mirror` | Membalik gambar vertikal/horizontal. | Balas gambar dengan `!s --mirror` |
| `!s --rotate <derajat>` | Memutar gambar. | Balas gambar dengan `!s --rotate 90` |
| `!s --rmbg` | Membuat background sederhana menjadi transparan. | Cocok untuk background polos/kontras |
| `!s --text <teks>` | Menambahkan teks overlay ke gambar. | `!s --text halo --top --color #ffff00 --stroke #000000 --size 42` |
| `!svintage` / `!smono` / `!sdeepfried` / `!sglow` | Preset efek cepat untuk foto. | Reply foto dengan `!svintage --text nostalgia` |
| `!sgif` | Mengonversi video pendek/GIF menjadi stiker animasi. | Balas video dengan caption `!sgif` |
| `!sgif --start <detik> --dur <detik> --fps <angka>` | Mengambil potongan video/GIF tertentu untuk stiker animasi. | `!sgif --start 2 --dur 4 --fps 12 --text halo` |
| `!meme <atas> \| <bawah>` | Membuat meme sticker dari teks atau gambar yang dibalas. | Reply gambar dengan `!meme atas \| bawah` |
| `!sticker <teks>` | Membuat stiker dari tulisan/teks. | `!sticker Halo Dunia` |
| `!stext <teks>` | Alias untuk stiker teks. | `!stext Halo Dunia` |
| `!sticker <teks> --bg <hex>` | Membuat stiker teks dengan warna background kustom. | `!sticker Halo --bg #ff0000` |
| `!quote <teks>` | Membuat stiker quote, atau reply pesan teks lalu `!quote`. | `!quote hidup adalah sticker` |
| `!emoji <emoji>` | Membuat emoji besar menjadi stiker. | `!emoji 😂` |
| `!label` / `!warning` / `!bubble` / `!poster` | Template stiker teks cepat. | `!warning jangan spam` |
| `!sinfo` | Melihat info media/stiker. | Reply media/stiker dengan `!sinfo` |
| `!toimg` | Mengubah stiker statis kembali menjadi gambar biasa. | Balas stiker dengan `!toimg` |
| `!togif` | Mengubah stiker animasi menjadi GIF. | Balas animated sticker dengan `!togif` |
| `!tomp4` | Mengubah stiker animasi menjadi MP4. | Balas animated sticker dengan `!tomp4` |
| `!pack <nama>` | Mengubah nama paket stiker untuk ruang obrolan Anda saat ini. | `!pack Nama Baru` |
| `!author <nama>` | Mengubah nama pembuat stiker untuk ruang obrolan Anda saat ini. | `!author Arya` |
| `!packpreset <preset>` | Mengaktifkan preset pack/author. | `!packpreset meme`, `!packpreset anime`, `!packpreset personal`, `!packpreset clean` |

---

## ☁️ Panduan Deployment (Koyeb / Cloud Run)

Bot ini sudah menyertakan `Dockerfile` untuk deployment berbasis container.

### 1. Deployment di Koyeb (Rekomendasi 512MB RAM)

Karena bot ini telah dioptimalkan secara ketat untuk penggunaan RAM di bawah 500MB, Anda dapat mendeploynya secara gratis/murah di Koyeb:

1.  Buat akun di [Koyeb](https://www.koyeb.com/).
2.  Hubungkan repositori GitHub Anda ke Koyeb.
3.  Pilih jenis deployment **Docker** atau **Buildpack**. (Docker lebih direkomendasikan karena akan otomatis mengonfigurasi FFmpeg dari `Dockerfile`).
4.  Tambahkan Variabel Lingkungan (Environment Variables) pada panel pengaturan Koyeb:
    *   `NODE_ENV=production` (Wajib, untuk mematikan log pino-pretty yang boros RAM).
    *   `TEMP_DIR=/tmp/stickerin-temp` (Direkomendasikan agar file temp disimpan di `/tmp` Koyeb).
5.  Klik **Deploy**.

> 💡 **Penting untuk Scan QR**: Baileys membutuhkan pemindaian QR sekali saat bot pertama kali dijalankan. Untuk hosting stateless seperti Koyeb, isi `TURSO_DATABASE_URL` dan `TURSO_AUTH_TOKEN` agar sesi WhatsApp tersimpan di Turso. Setelah scan pertama, redeploy/restart berikutnya akan membaca sesi dari Turso tanpa perlu scan ulang. Jika variabel Turso dikosongkan, bot kembali memakai folder `/auth` atau volume persistensi.

### 2. Menjalankan Menggunakan Docker Lokal

Jika ingin menjalankan via Docker secara mandiri di server Anda:

```bash
# Build Docker Image
docker build -t stickerin-bot .

# Jalankan Container (pastikan mounting folder auth agar login tidak hilang)
docker run -d \
  --name my-sticker-bot \
  -v $(pwd)/auth:/app/auth \
  --env-file .env \
  stickerin-bot
```

---

## 📄 Lisensi

Proyek ini dilisensikan di bawah **MIT License**. Lihat berkas [LICENSE](LICENSE) untuk informasi lebih lanjut.
Copyright © 2026 Arya Rizky.
