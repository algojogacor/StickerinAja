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
