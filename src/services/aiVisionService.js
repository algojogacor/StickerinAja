// Groq AI Vision & Chat Service — Multimodal Image & Text Analysis
const sharp = require('sharp');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';
const TEXT_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';

function getApiKeys() {
    const keys = [
        process.env.GROQ_API_KEY_PRIMARY,
        process.env.GROQ_API_KEY_SECONDARY,
        process.env.GROQ_API_KEY_1,
        process.env.GROQ_API_KEY_2
    ].filter(Boolean);
    return [...new Set(keys)];
}

/**
 * Optimizes an image buffer for fast Vision API transmission (max 1024px, JPEG 80%)
 * @param {Buffer} buffer 
 * @returns {Promise<string>} Base64 Data URL
 */
async function optimizeImageForVision(buffer) {
    try {
        const optimized = await sharp(buffer)
            .rotate() // auto-orient
            .resize(1024, 1024, {
                fit: 'inside',
                withoutEnlargement: true
            })
            .jpeg({ quality: 80 })
            .toBuffer();

        return `data:image/jpeg;base64,${optimized.toString('base64')}`;
    } catch {
        // Fallback to raw base64 if sharp transformation fails
        return `data:image/jpeg;base64,${buffer.toString('base64')}`;
    }
}

/**
 * Executes a request to Groq with API key rotation on failure
 */
async function callGroqWithRotation(payload, logger) {
    const keys = getApiKeys();
    if (keys.length === 0) {
        return { success: false, error: 'GROQ_API_KEY belum dikonfigurasi di server.' };
    }

    let lastError = null;

    for (const key of keys) {
        try {
            const res = await fetch(GROQ_API_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            const data = await res.json();

            if (res.ok && data.choices?.[0]?.message?.content) {
                return {
                    success: true,
                    text: data.choices[0].message.content.trim(),
                    usage: data.usage
                };
            }

            const errMsg = data.error?.message || `HTTP ${res.status}`;
            logger?.warn({ err: errMsg }, '[AI Vision] Key attempt failed, trying next key');
            lastError = errMsg;
        } catch (err) {
            logger?.warn({ err: err.message }, '[AI Vision] Network error on key attempt');
            lastError = err.message;
        }
    }

    return { success: false, error: lastError || 'Gagal menghubungi server Groq AI.' };
}

/**
 * Analyzes an image with an optional prompt using Groq Vision
 */
async function analyzeImage({ imageBuffer, prompt, logger }) {
    if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
        return { success: false, error: 'Buffer gambar tidak valid.' };
    }

    const dataUrl = await optimizeImageForVision(imageBuffer);
    const userPrompt = String(prompt || '').trim() || 'Jelaskan dan baca teks di dalam gambar ini secara ringkas, jelas, dan santai dalam bahasa Indonesia.';

    const payload = {
        model: VISION_MODEL,
        messages: [
            {
                role: 'system',
                content: 'Kamu adalah asisten AI WhatsApp yang cerdas, ramah, dan solutif. Analisis gambar dengan teliti, baca teks di dalamnya jika ada, dan jawab dalam bahasa Indonesia yang rapi dan mudah dibaca.'
            },
            {
                role: 'user',
                content: [
                    { type: 'text', text: userPrompt },
                    { type: 'image_url', image_url: { url: dataUrl } }
                ]
            }
        ],
        max_tokens: 800,
        temperature: 0.7
    };

    return callGroqWithRotation(payload, logger);
}

/**
 * Answers a text-only question using Groq LLM
 */
async function chatText({ prompt, logger }) {
    const userPrompt = String(prompt || '').trim();
    if (!userPrompt) {
        return { success: false, error: 'Pertanyaan tidak boleh kosong.' };
    }

    const payload = {
        model: TEXT_MODEL,
        messages: [
            {
                role: 'system',
                content: 'Kamu adalah asisten AI WhatsApp yang cerdas, ringkas, informatif, dan ramah. Jawab dalam bahasa Indonesia yang baik.'
            },
            {
                role: 'user',
                content: userPrompt
            }
        ],
        max_tokens: 1000,
        temperature: 0.7
    };

    return callGroqWithRotation(payload, logger);
}

module.exports = {
    analyzeImage,
    chatText,
    optimizeImageForVision,
    VISION_MODEL
};
