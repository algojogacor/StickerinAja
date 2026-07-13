# Modularisasi Sistem Bot + Hapus Hermes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Memisahkan sistem Baileys (`src/core/`) dari sistem fitur (`src/commands/`, `src/schedulers/`), menghapus total Hermes relay, tanpa mengubah perilaku bot ke user.

**Architecture:** `src/core/` memegang infrastruktur (koneksi, socket accessor, HTTP server). Fitur bertemu core hanya lewat dua antarmuka sempit: callback `onMessage` (connection → handler) dan `getSock()` (scheduler → socket aktif). `global.hermesSock` diganti modul `core/socket.js`.

**Tech Stack:** Node.js, `@whiskeysockets/baileys`, `pino`, HTTP native. Tanpa dependency baru.

## Global Constraints

- **Target runtime:** Koyeb free tier, 512 MB RAM. Tidak menambah dependency apa pun.
- **Bukan git repo:** tidak ada `git commit`. Setiap task diakhiri checkpoint verifikasi (smoke test), bukan commit.
- **Tanpa test framework:** verifikasi memakai `node -e` require-check, `grep`, dan startup manual — bukan unit test.
- **Perilaku tak berubah:** command stiker, menu, settings harus identik. Hanya struktur & Hermes yang berubah.
- **`require` berat tetap lazy:** `canvas`/`sharp`/`ffmpeg` tetap hanya di-`require` di dalam `commands/sticker.js`. Jangan pindahkan ke top-level bootstrap.
- **Shell:** Windows. Perintah verifikasi ditulis untuk Bash tool (`node`, `grep` tersedia).

---

### Task 1: Buat `core/socket.js` (accessor pengganti global)

**Files:**
- Create: `src/core/socket.js`

**Interfaces:**
- Produces: `getSock()` → mengembalikan `sock` aktif atau `null`. `setSock(sock)` → menyimpan referensi (terima `null` untuk clear).

- [ ] **Step 1: Tulis modul accessor**

`src/core/socket.js`:
```js
// Menyimpan satu referensi socket Baileys aktif.
// Pengganti global.hermesSock — satu pintu bagi kode non-command (scheduler)
// untuk mengambil socket yang sedang tersambung.
let currentSock = null;

/** Simpan socket aktif. Panggil setSock(null) saat koneksi tertutup. */
function setSock(sock) {
    currentSock = sock;
}

/** Ambil socket aktif, atau null bila belum/sedang tidak tersambung. */
function getSock() {
    return currentSock;
}

module.exports = { getSock, setSock };
```

- [ ] **Step 2: Verifikasi modul load & kontrak dasar**

Run:
```bash
cd /d/stickerinaja && node -e "const s=require('./src/core/socket'); s.setSock({id:1}); console.log(s.getSock().id===1?'OK':'FAIL'); s.setSock(null); console.log(s.getSock()===null?'OK':'FAIL');"
```
Expected: dua baris `OK`.

---

### Task 2: Buat `core/connection.js` (dari `baileys.js`, tanpa Hermes)

**Files:**
- Create: `src/core/connection.js`
- Consumes: `getSock`/`setSock` dari `src/core/socket.js`, `useTursoAuthState` dari `src/utils/tursoAuthState.js`

**Interfaces:**
- Consumes: `setSock(sock)` dari Task 1.
- Produces: `startBot({ authDir, logger, onMessage })` → memulai koneksi Baileys, memanggil `onMessage(sock, msg)` untuk tiap pesan masuk yang bukan `fromMe`.

> Catatan path: file berada di `src/core/`, jadi utils diakses via `../utils/tursoAuthState` (bukan `./utils/...` seperti di `baileys.js` lama).

- [ ] **Step 1: Tulis `connection.js` tanpa kode Hermes**

`src/core/connection.js`:
```js
const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QR = require('qrcode-terminal');
const fs = require('fs');
const { useTursoAuthState } = require('../utils/tursoAuthState');
const { setSock } = require('./socket');

function startBot({ authDir, logger, onMessage }) {
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    let reconnectTimer;
    let sock = null;

    async function connect() {
        const authState = await useTursoAuthState({ logger });
        const { state, saveCreds } = authState || (await useMultiFileAuthState(authDir));
        if (!authState) {
            logger.info(`Using file auth state: ${authDir}`);
        }

        let version = [2, 3000, 1035194821]; // Fallback ke versi terverifikasi
        try {
            const latest = await fetchLatestBaileysVersion();
            version = latest.version;
            logger.info(`ℹ️ Using WA version: ${version.join('.')}`);
        } catch (err) {
            logger.warn({ err }, 'Failed to fetch latest WA version, using fallback');
        }

        sock = makeWASocket({
            version,
            auth: state,
            browser: Browsers.windows('StickerinBot'),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            logger: logger.child({ module: 'baileys' }),
            generateHighQualityLinkPreview: false,
            shouldIgnoreJid: jid => !jid.endsWith('@g.us') && !jid.endsWith('@s.whatsapp.net')
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                global.botState.status = 'qr';
                global.botState.qr = qr;
                QR.generate(qr, { small: true });
                logger.info('📱 Scan QR code above to login');
            }
            if (connection === 'open') {
                global.botState.status = 'connected';
                global.botState.qr = null;
                global.botState.user = sock.user;
                setSock(sock);
                logger.info('✅ Bot connected!');
                logger.info(`📱 Logged in as: ${sock.user?.name || sock.user?.id}`);
            }
            if (connection === 'close') {
                global.botState.status = 'connecting';
                global.botState.qr = null;
                global.botState.user = null;
                setSock(null);
                const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = reason !== DisconnectReason.loggedOut;
                logger.info(`🔌 Disconnected: ${reason || 'unknown'} | Reconnect: ${shouldReconnect}`);
                if (shouldReconnect) {
                    reconnectTimer = setTimeout(connect, 3000);
                } else {
                    logger.warn('🚪 Logged out. Delete auth folder and restart.');
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Semua pesan masuk (grup + private)
        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;
                try {
                    await onMessage(sock, msg);
                } catch (err) {
                    logger.error({ err }, 'Handler error');
                }
            }
        });

        return sock;
    }

    connect().catch(err => logger.error({ err }, 'Failed to start'));
}

module.exports = { startBot };
```

- [ ] **Step 2: Verifikasi tidak ada sisa Hermes & modul load**

Run:
```bash
cd /d/stickerinaja && grep -in "hermes\|hermesSock\|pushToHermes\|longPoll\|normalizeJid" src/core/connection.js; echo "exit=$?"
```
Expected: tidak ada baris cocok, `exit=1` (grep tidak menemukan apa pun = benar).

- [ ] **Step 3: Verifikasi require chain (butuh global.botState stub)**

Run:
```bash
cd /d/stickerinaja && node -e "global.botState={}; require('dotenv').config(); const {startBot}=require('./src/core/connection'); console.log(typeof startBot==='function'?'OK':'FAIL');"
```
Expected: `OK` (tanpa error require path).

---

### Task 3: Buat `core/server.js` (HTTP server tanpa endpoint Hermes)

**Files:**
- Create: `src/core/server.js`
- Reference: `src/utils/login.html` (dibaca sekali ke memori)

**Interfaces:**
- Produces: `startServer({ logger })` → memulai HTTP server di `process.env.PORT || 8000`. Endpoint: `/health`, `/api/status`, `/qr-string`, `/`.

> `login.html` berada di `src/utils/login.html`. Dari `src/core/server.js`, path-nya `path.join(__dirname, '../utils/login.html')`.

- [ ] **Step 1: Tulis `server.js`**

`src/core/server.js`:
```js
const http = require('http');
const fs = require('fs');
const path = require('path');

function startServer({ logger }) {
    // Muat HTML sekali ke memori saat start (hemat: tidak baca file per request)
    const htmlPath = path.join(__dirname, '../utils/login.html');
    let loginHtml = '<h1>Login Page</h1>';
    try {
        loginHtml = fs.readFileSync(htmlPath, 'utf8');
    } catch (err) {
        logger.error({ err }, 'Failed to load login.html');
    }

    const PORT = process.env.PORT || 8000;

    http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        if (url.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', uptime: Math.floor(process.uptime()) }));
        } else if (url.pathname === '/api/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(global.botState));
        } else if (url.pathname === '/qr-string') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(global.botState.qr || 'No QR code available. Already connected or connecting...');
        } else if (url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(loginHtml);
        } else {
            res.writeHead(404);
            res.end();
        }
    }).listen(PORT, () => {
        logger.info(`🌐 Server on port ${PORT}`);
    });
}

module.exports = { startServer };
```

- [ ] **Step 2: Verifikasi tidak ada sisa Hermes**

Run:
```bash
cd /d/stickerinaja && grep -in "hermes" src/core/server.js; echo "exit=$?"
```
Expected: `exit=1` (tidak ada match).

- [ ] **Step 3: Verifikasi server listen & endpoint (start lalu curl lalu kill)**

Run:
```bash
cd /d/stickerinaja && node -e "
global.botState={status:'connecting',qr:null,user:null};
const pino=require('pino');
const {startServer}=require('./src/core/server');
startServer({logger:pino({level:'silent'})});
setTimeout(async()=>{
  const h=await fetch('http://localhost:8000/health').then(r=>r.json());
  const s=await fetch('http://localhost:8000/api/status').then(r=>r.json());
  console.log(h.status==='ok'?'health OK':'health FAIL');
  console.log(s.status==='connecting'?'status OK':'status FAIL');
  process.exit(0);
},500);
"
```
Expected: `health OK` dan `status OK`.

---

### Task 4: Buat kerangka `src/schedulers/`

**Files:**
- Create: `src/schedulers/index.js`
- Create: `src/schedulers/README.md`

**Interfaces:**
- Consumes: (nanti oleh job) `getSock()` dari `src/core/socket.js`.
- Produces: `registerSchedulers({ logger })` → no-op sekarang; titik integrasi untuk job masa depan.

- [ ] **Step 1: Tulis `schedulers/index.js`**

`src/schedulers/index.js`:
```js
// Registry scheduler. Saat ini belum ada job — fungsi ini no-op.
// Saat menambah job pertama: tambahkan node-cron ke dependencies,
// buat file job di folder ini, lalu daftarkan di sini.
function registerSchedulers({ logger }) {
    logger.info('🕒 Scheduler registry ready (no jobs registered)');
}

module.exports = { registerSchedulers };
```

- [ ] **Step 2: Tulis `schedulers/README.md`**

`src/schedulers/README.md`:
````markdown
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
````

- [ ] **Step 3: Verifikasi modul load & no-op berjalan**

Run:
```bash
cd /d/stickerinaja && node -e "const {registerSchedulers}=require('./src/schedulers'); const pino=require('pino'); registerSchedulers({logger:pino({level:'silent'})}); console.log('OK');"
```
Expected: `OK`.

---

### Task 5: Sederhanakan `index.js` (bootstrap tipis)

**Files:**
- Modify: `index.js` (ganti seluruh isi)

**Interfaces:**
- Consumes: `startBot` (Task 2), `startServer` (Task 3), `registerSchedulers` (Task 4), `handler` dari `src/handler.js`.

> `handler` tetap dipanggil langsung sebagai `onMessage` — wrapper `hermesAwareHandler` dihapus. Handler sendiri sudah mengabaikan pesan tanpa prefix (`if (!messageText.startsWith(PREFIX)) return;`), jadi perilaku identik.

- [ ] **Step 1: Tulis ulang `index.js`**

`index.js`:
```js
require('dotenv').config();

// State global untuk monitoring HTTP & serving QR
global.botState = {
    status: 'connecting',
    qr: null,
    user: null
};

const path = require('path');
const fs = require('fs');
const pino = require('pino');
const { startBot } = require('./src/core/connection');
const { startServer } = require('./src/core/server');
const { registerSchedulers } = require('./src/schedulers');
const { handler } = require('./src/handler');

// Pastikan temp dir ada
const TEMP_DIR = process.env.TEMP_DIR || './temp';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Bersihkan temp file tiap menit
const KEEP_MINUTES = parseInt(process.env.KEEP_TEMP_MINUTES || '5');
setInterval(async () => {
    const cutoff = Date.now() - KEEP_MINUTES * 60 * 1000;
    try {
        const files = await fs.promises.readdir(TEMP_DIR);
        await Promise.all(files.map(async (file) => {
            const fp = path.join(TEMP_DIR, file);
            try {
                const stat = await fs.promises.stat(fp);
                if (stat.isFile() && stat.mtimeMs < cutoff) {
                    await fs.promises.unlink(fp);
                }
            } catch {}
        }));
    } catch {}
}, 60_000);

// pino-pretty spawn worker thread + format per baris — skip di production
// untuk hemat ~10-15MB RAM & kurangi CPU per log
const isDev = (process.env.NODE_ENV || 'development') !== 'production';
const logger = pino({
    ...(isDev ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } } } : {}),
    level: process.env.LOG_LEVEL || 'info'
});

startServer({ logger });
registerSchedulers({ logger });
startBot({
    authDir: process.env.AUTH_DIR || './auth',
    logger,
    onMessage: (sock, msg) => handler(sock, msg, logger)
});
```

- [ ] **Step 2: Verifikasi tidak ada sisa Hermes di index.js**

Run:
```bash
cd /d/stickerinaja && grep -in "hermes" index.js; echo "exit=$?"
```
Expected: `exit=1` (tidak ada match).

---

### Task 6: Hapus `src/baileys.js` & bersihkan sisa referensi

**Files:**
- Delete: `src/baileys.js`

- [ ] **Step 1: Hapus file lama**

Run:
```bash
cd /d/stickerinaja && rm -f src/baileys.js && echo "deleted"
```
Expected: `deleted`.

- [ ] **Step 2: Verifikasi tidak ada referensi ke `./src/baileys` atau `hermes` di seluruh proyek (kecuali docs)**

Run:
```bash
cd /d/stickerinaja && grep -rin "baileys')\|require.*baileys'\|hermes" index.js src/ | grep -v "@whiskeysockets/baileys"; echo "exit=$?"
```
Expected: `exit=1` (tidak ada match — semua referензi `baileys.js` lama & hermes sudah hilang; import paket `@whiskeysockets/baileys` sengaja dikecualikan).

---

### Task 7: Verifikasi integrasi penuh (startup end-to-end)

**Files:** (tidak ada perubahan — verifikasi saja)

- [ ] **Step 1: Cek seluruh modul me-require tanpa error**

Run:
```bash
cd /d/stickerinaja && node -e "
require('dotenv').config();
global.botState={status:'connecting',qr:null,user:null};
require('./src/core/socket');
require('./src/core/connection');
require('./src/core/server');
require('./src/schedulers');
require('./src/handler');
console.log('all modules OK');
"
```
Expected: `all modules OK`.

- [ ] **Step 2: Startup penuh selama 8 detik, pastikan server naik & tidak crash**

Run:
```bash
cd /d/stickerinaja && timeout 8 node index.js 2>&1 | head -40; echo "--- startup selesai ---"
```
Expected: muncul log `🌐 Server on port ...`, `🕒 Scheduler registry ready`, dan upaya koneksi WA (QR atau connecting). **Tidak ada** `Error`/`Cannot find module`/stack trace. (Timeout mematikan proses setelah 8 detik — itu normal.)

- [ ] **Step 3: Verifikasi struktur akhir sesuai spec**

Run:
```bash
cd /d/stickerinaja && ls src/core/ && echo "---" && ls src/schedulers/ && echo "---" && test ! -f src/baileys.js && echo "baileys.js removed OK"
```
Expected: `core/` berisi `connection.js socket.js server.js`; `schedulers/` berisi `index.js README.md`; `baileys.js removed OK`.

---

## Catatan Verifikasi Perilaku Manual (opsional, oleh user)

Refactor ini tak bisa memverifikasi pengiriman stiker nyata tanpa akun WA login. Setelah deploy/login, konfirmasi manual:
- `!menu` menampilkan menu.
- `!s` (reply foto) menghasilkan stiker.
- `!sgif` (reply video) menghasilkan stiker animasi.
- `!pack <nama>` mengubah pack.
- `/qr-string` & `/health` merespons di browser.

Logika command tidak disentuh, sehingga risiko regресi hanya pada path require — sudah ditutup Task 7.
