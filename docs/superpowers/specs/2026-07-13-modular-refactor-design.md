# Modularisasi Sistem Bot + Hapus Hermes Relay

**Tanggal:** 2026-07-13
**Status:** Design — menunggu review
**Target runtime:** Koyeb free tier (512 MB RAM)

## Tujuan

Memisahkan **sistem Baileys (infrastruktur koneksi WhatsApp)** dari **sistem fitur (command & otomasi)**, agar penambahan fitur baru di luar stiker menjadi mudah dan tidak menyentuh kode koneksi. Sekaligus menghapus total sistem Hermes relay yang tidak dipakai.

Refactor ini **tidak mengubah perilaku bot ke user** — command stiker berperilaku identik. Ini murni pemindahan struktur, penghapusan kode mati (Hermes), dan penyiapan fondasi untuk scheduler.

## Non-Tujuan (YAGNI)

- **Tidak** membangun fitur berita/kurs sekarang.
- **Tidak** menambah dependency `node-cron` atau library scheduler apa pun sekarang.
- **Tidak** menulis ulang logika stiker, menu, atau settings.
- **Tidak** menambah fitur non-command (reaksi tanpa prefix). Semua fitur tetap prefix `!`.

## Keputusan Arsitektur Kunci

### Akses `sock` lewat modul accessor (`core/socket.js`)

Saat ini koneksi diekspos via `global.hermesSock`. Objek `sock` berganti setiap reconnect, sehingga butuh satu sumber kebenaran. Kita ganti global variable dengan modul kecil:

- `setSock(sock)` — dipanggil `connection.js` saat koneksi `open`.
- `setSock(null)` — dipanggil saat koneksi `close`.
- `getSock()` — dipakai konsumen mana pun (scheduler nanti) untuk mengambil `sock` aktif; mengembalikan `null` bila belum tersambung.

Command tidak perlu `getSock()` karena handler sudah meneruskan `sock` sebagai argumen. Accessor ini adalah **satu-satunya pintu** untuk kode yang tidak dipicu pesan masuk (scheduler, background job). Tidak ada dependency baru, tidak ada global.

**Alternatif yang ditolak:** event bus / objek `bot` context yang di-passing ke seluruh modul — overkill untuk kebutuhan saat ini (YAGNI).

## Struktur Direktori Target

```
index.js                    → bootstrap tipis: env, temp cleanup, start server, start bot
src/
  core/                     ← SISTEM BAILEYS (infrastruktur)
    connection.js           → lifecycle koneksi Baileys (dari baileys.js, Hermes DIHAPUS)
    socket.js               → simpan & sediakan sock aktif: getSock() / setSock()
    server.js               → HTTP health + QR (endpoint /hermes/* DIHAPUS)
  handler.js                → router pesan masuk → dispatch ke command
  commands/                 ← SISTEM FITUR (command prefix !)
    sticker.js              (tidak diubah)
    menu.js                 (tidak diubah)
    settings.js             (tidak diubah)
  schedulers/               ← FONDASI BARU (kerangka, belum aktif)
    index.js                → registerSchedulers() — no-op sekarang
    README.md               → pola menulis job cron memakai getSock()
  utils/                    (tidak diubah)
    cache.js
    textRenderer.js
    tursoAuthState.js
```

**Batas antar sistem:** `src/core/` tidak tahu apa pun soal fitur. `src/commands/` dan `src/schedulers/` adalah fitur. Keduanya bertemu core hanya melalui dua antarmuka sempit: `onMessage` (handler dipanggil oleh connection) dan `getSock()` (scheduler mengambil socket).

## Perubahan Per-File

### 1. `src/baileys.js` → `src/core/connection.js`

Pindahkan dan bersihkan. **Dihapus:**
- `hermesMessageQueue`, `hermesLongPollResolvers`, `HERMES_QUEUE_MAX`
- Fungsi: `pushToHermesQueue`, `hermesGetMessages`, `hermesLongPoll`, `hermesSendMessage`, `hermesSendTyping`, `normalizeJid`
- `global.hermesSock`

**Dipertahankan:** `startBot({ authDir, logger, onMessage })`, logika connect/reconnect, QR, `creds.update`, forward `messages.upsert` ke `onMessage`.

**Diubah:** saat `connection === 'open'` panggil `setSock(sock)`; saat `close` panggil `setSock(null)`. Logika reconnect kode 440 disederhanakan — komentar/perilaku "yield ke Hermes bridge" dihapus; diperlakukan sebagai disconnect biasa yang reconnect (interval tetap wajar, mis. 3 detik, bukan 60 detik menunggu bridge).

### 2. `src/core/socket.js` (baru)

Modul minimal: menyimpan satu referensi `sock`, mengekspos `getSock()` dan `setSock()`. ~10 baris. Pengganti `global.hermesSock`.

### 3. `src/core/server.js` (baru — diekstrak dari `index.js`)

HTTP server dipindah keluar dari `index.js` ke fungsi `startServer({ logger })`. **Endpoint dihapus:** `/hermes/send`, `/hermes/typing`, `/hermes/messages`, `/hermes/health`, plus helper `checkHermesAuth` dan konstanta `HERMES_SECRET`. **Endpoint dipertahankan:** `/health`, `/api/status`, `/qr-string`, `/` (login.html). Pola hemat-RAM dipertahankan: `login.html` dibaca sekali ke memori saat start.

### 4. `index.js` (disederhanakan)

Menjadi bootstrap tipis: load env, init `global.botState`, buat temp dir + interval cleanup, konfigurasi `pino` (tetap skip `pino-pretty` di production), `startServer(...)`, lalu `startBot({ onMessage: handler })`. Wrapper `hermesAwareHandler` dan `pushToHermesQueue` **dihapus** — `onMessage` langsung memanggil `handler`.

### 5. `src/schedulers/index.js` + `README.md` (baru)

`index.js` mengekspos `registerSchedulers({ logger })` yang saat ini **no-op** (hanya log "no schedulers registered") dan dipanggil dari bootstrap agar titik integrasinya sudah ada. `README.md` mendokumentasikan pola menambah job: buat file job → import `getSock()` dari `../core/socket` → susun pesan → `getSock()?.sendMessage(jid, ...)`, dengan catatan untuk menambah `node-cron` saat job pertama benar-benar dibuat.

### 6. `src/handler.js`

Hampir tidak berubah. Hanya sesuaikan path require jika perlu (commands tetap di `src/commands/`). Tetap ekspor `handler`.

## Optimasi RAM (Koyeb 512 MB)

Refactor bersifat netral-ke-negatif terhadap RAM (menghapus kode = mengurangi beban). Yang dijaga:

- **Penghapusan Hermes** menghilangkan queue hingga 200 objek pesan + array resolver yang tertahan di memori — penghematan nyata di grup ramai.
- **Tanpa dependency baru** — scheduler hanya kerangka; `node-cron` ditunda sampai dibutuhkan.
- `require` berat (`canvas`, `sharp`, `fluent-ffmpeg`, `ffmpeg-static`) tetap berada di dalam `commands/sticker.js` sehingga hanya dimuat saat command dipakai, tidak membebani startup.
- Concurrency queue (`ffmpegQueue` max 1, `imageQueue`), pola `buffer = null` setelah dipakai, penggunaan temp file untuk FFmpeg, dan cleanup temp per menit — semuanya dipertahankan apa adanya.
- `pino-pretty` tetap di-skip di production; `login.html` tetap dibaca sekali ke memori.

## Verifikasi

Karena tidak ada perubahan perilaku, verifikasi berbasis kesetaraan fungsional:

1. Bot start tanpa error, HTTP server listen di `PORT`.
2. `/health`, `/api/status`, `/qr-string`, `/` merespons seperti sebelumnya.
3. QR muncul saat belum login; `global.botState` terisi saat connected.
4. Command stiker (`!s`, `!sgif`, `!menu`, `!pack`, dll) berperilaku identik.
5. `grep` memastikan tidak ada sisa referensi `hermes` / `global.hermesSock` di seluruh `src/` dan `index.js`.
6. Reconnect tetap berfungsi setelah koneksi terputus.

## Risiko

- **Path require** setelah pemindahan file (`baileys.js` → `core/connection.js`) — utils diakses via `../utils/...` menjadi `../utils/...` dari `core/`, perlu disesuaikan. Diverifikasi dengan menjalankan bot.
- **`.env` / dokumentasi**: `.env.example` sudah bersih (tidak menyebut Hermes). `HERMES_RELAY_SECRET` hanya dibaca di `index.js` dan akan hilang bersama refactor. `.env` milik user mungkin masih memuatnya — cukup diabaikan, tidak error.
