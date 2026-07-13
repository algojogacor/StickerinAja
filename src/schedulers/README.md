# Schedulers

Folder ini berisi job terjadwal (cron) yang berjalan **tanpa** dipicu pesan
masuk — misalnya kirim berita + kurs USD→IDR tiap pagi jam 7.

## Cara kerja

Job mengakses koneksi WhatsApp lewat `getSock()` dari `../core/socket`.
`getSock()` mengembalikan socket aktif, atau `null` bila bot sedang tidak
tersambung — **selalu cek null** sebelum mengirim.

## Menambah job pertama

1. Tambahkan `node-cron` ke `package.json`:
   ```bash
   npm install node-cron
   ```
2. Buat file job, misal `morning-brief.js`:
   ```js
   const cron = require('node-cron');
   const { getSock } = require('../core/socket');

   // Ganti dengan JID chat/grup tujuan.
   const TARGET_JIDS = ['62812xxxx@s.whatsapp.net'];

   function schedule({ logger }) {
       // '0 7 * * *' = tiap hari jam 07:00. Set timezone lewat opsi.
       cron.schedule('0 7 * * *', async () => {
           const sock = getSock();
           if (!sock) return logger.warn('Morning brief dilewati: bot tidak tersambung');
           const text = await buildMorningBrief(); // susun berita + kurs di sini
           for (const jid of TARGET_JIDS) {
               await sock.sendMessage(jid, { text });
           }
           logger.info('✅ Morning brief terkirim');
       }, { timezone: 'Asia/Jakarta' });
   }

   async function buildMorningBrief() {
       return 'Halo! Ini ringkasan pagi.'; // TODO: isi logika berita + kurs
   }

   module.exports = { schedule };
   ```
3. Daftarkan di `index.js` folder ini:
   ```js
   const morningBrief = require('./morning-brief');
   function registerSchedulers({ logger }) {
       morningBrief.schedule({ logger });
       logger.info('🕒 Schedulers registered');
   }
   ```

## Catatan RAM (Koyeb 512 MB)

- Jangan `require` job berat di top-level bila belum dipakai.
- Kirim ke banyak JID secara berurutan (loop `await`), bukan paralel, agar
  tidak melonjakkan memori/koneksi.
