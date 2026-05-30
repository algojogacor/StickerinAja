require('dotenv').config();
const { startBot } = require('./src/baileys');
const { handler } = require('./src/handler');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// Ensure temp dir exists
const TEMP_DIR = process.env.TEMP_DIR || './temp';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Cleanup temp files every 5 minutes
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

// ⚡ pino-pretty spawns a worker thread + does string formatting per log line
// Skip in production to save ~10-15MB RAM and reduce CPU per log call
const isDev = (process.env.NODE_ENV || 'development') !== 'production';
const logger = pino({
    ...(isDev ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } } } : {}),
    level: process.env.LOG_LEVEL || 'info'
});

startBot({
    authDir: process.env.AUTH_DIR || './auth',
    logger,
    onMessage: (sock, msg) => handler(sock, msg, logger)
});
