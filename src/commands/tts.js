const https = require('https');

const SUPPORTED_LANGS = new Set([
    'id', 'en', 'ja', 'ko', 'ar', 'es', 'fr', 'de', 'ru', 'zh', 'jv', 'su'
]);

async function fetchTTS(text, lang = 'id') {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&q=${encodeURIComponent(text)}`;
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        }, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`TTS API HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.setTimeout(15000, () => {
            req.destroy();
            reject(new Error('Timeout fetching TTS'));
        });
    });
}

module.exports = {
    names: ['tts', 'vn', 'voicenote', 'suara'],
    execute: async (sock, msg, args, ctx) => {
        const remoteJid = msg.key?.remoteJid;

        if (args.length === 0) {
            return sock.sendMessage(remoteJid, {
                text: `🔊 *TEXT TO SPEECH (VOICE NOTE)*\n\n` +
                      `Ubah teks menjadi pesan suara WhatsApp secara instan!\n\n` +
                      `📌 *Format:* \`!tts <teks>\`\n` +
                      `🌍 *Pilih Bahasa:* \`!tts <kode-bahasa> <teks>\`\n\n` +
                      `💡 *Contoh:*\n` +
                      `• \`!tts Halo semuanya, selamat pagi!\`\n` +
                      `• \`!tts en Good morning everyone, have a nice day!\`\n` +
                      `• \`!tts ja Konnichiwa, ogenki desu ka?\`\n` +
                      `• \`!tts ar Assalamualaikum warahmatullah\`\n\n` +
                      `_Bahasa didukung: id, en, ja, ko, ar, es, fr, de, ru, zh, jv, su_`
            }, { quoted: msg });
        }

        let lang = 'id';
        let textWords = [...args];

        // Check if first arg is a supported language code
        if (args.length > 1 && SUPPORTED_LANGS.has(args[0].toLowerCase())) {
            lang = args[0].toLowerCase();
            textWords = args.slice(1);
        }

        const text = textWords.join(' ').trim().slice(0, 300);
        if (!text) {
            return sock.sendMessage(remoteJid, { text: '❌ Teks tidak boleh kosong.' }, { quoted: msg });
        }

        try {
            const audioBuffer = await fetchTTS(text, lang);
            return sock.sendMessage(remoteJid, {
                audio: audioBuffer,
                mimetype: 'audio/mp4',
                ptt: true
            }, { quoted: msg });
        } catch (error) {
            ctx?.logger?.error({ err: error }, '[TTS] Error generating voice note');
            return sock.sendMessage(remoteJid, {
                text: `❌ *Gagal Membuat Voice Note:* ${error.message}`
            }, { quoted: msg });
        }
    }
};
