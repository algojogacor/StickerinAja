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
