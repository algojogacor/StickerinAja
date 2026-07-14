// Entertainment service — fetches jokes, facts, quotes, and animal pics from multiple APIs.
// Features: random API selection, fallback chain, deduplication, text + image content types.

const { hasSent, markSent, hashContent } = require('../utils/contentHistory');

// ── API Definitions ──────────────────────────────────────

const API_DEFS = [
    // ── Text APIs ──
    {
        name: 'Joke (Official)',
        label: 'Random Joke',
        type: 'text',
        url: 'https://official-joke-api.appspot.com/random_joke',
        headers: { Accept: 'application/json' },
        parse: (data) => ({
            id: hashContent(`${data.setup} ${data.punchline}`),
            text: `*Random Joke* 🃏\n\n${data.setup}\n\n${data.punchline}`,
            raw: `${data.setup}\n${data.punchline}`
        })
    },
    {
        name: 'Dad Joke',
        label: 'Dad Joke',
        type: 'text',
        url: 'https://icanhazdadjoke.com/',
        headers: { Accept: 'application/json' },
        parse: (data) => ({
            id: hashContent(data.joke),
            text: `*Dad Joke* 👨\n\n${data.joke}`,
            raw: data.joke
        })
    },
    {
        name: 'Useless Fact',
        label: 'Useless Fact',
        type: 'text',
        url: 'https://uselessfacts.jsph.pl/api/v2/facts/random?language=en',
        headers: { Accept: 'application/json' },
        parse: (data) => ({
            id: hashContent(data.text),
            text: `*Useless Fact* 🤓\n\n${data.text}`,
            raw: data.text
        })
    },
    {
        name: 'Yo Mama',
        label: 'Yo Mama Joke',
        type: 'text',
        url: 'https://yo-mama.tankobliterator.net/random',
        headers: { Accept: 'application/json' },
        parse: (data) => ({
            id: hashContent(data.joke),
            text: `*Yo Mama Joke* 🤣\n\n${data.joke}`,
            raw: data.joke
        }),
        optional: true
    },
    {
        name: 'Quotable',
        label: 'Quote',
        type: 'text',
        url: 'https://api.quotable.io/random',
        headers: { Accept: 'application/json' },
        parse: (data) => ({
            id: hashContent(data.content),
            text: `*Quote* 💬\n\n_"${data.content}"_\n\n— ${data.author}`,
            raw: `"${data.content}" — ${data.author}`
        })
    },
    {
        name: 'Cat Facts',
        label: 'Cat Fact',
        type: 'text',
        url: 'https://catfact.ninja/fact',
        headers: { Accept: 'application/json' },
        parse: (data) => ({
            id: hashContent(data.fact),
            text: `*Cat Fact* 🐱\n\n${data.fact}`,
            raw: data.fact
        })
    },
    // ── Image APIs ──
    {
        name: 'Random Dog',
        label: 'Random Dog',
        type: 'image',
        url: 'https://dog.ceo/api/breeds/image/random',
        headers: { Accept: 'application/json' },
        parse: (data) => ({
            id: hashContent(data.message || ''),
            imageUrl: data.message,
            caption: '🐕 *Random Dog!*'
        })
    },
    {
        name: 'Random Cat',
        label: 'Random Cat',
        type: 'image',
        url: 'https://cataas.com/cat?json=true',
        headers: { Accept: 'application/json' },
        parse: (data) => {
            const imageUrl = data.url ? `https://cataas.com${data.url}` : 'https://cataas.com/cat';
            return {
                id: hashContent(imageUrl),
                imageUrl,
                caption: data.tags?.length ? `🐱 *Random Cat!*\nTags: ${data.tags.join(', ')}` : '🐱 *Random Cat!*'
            };
        }
    }
];

// ── Config ───────────────────────────────────────────────

const TIMEOUT_MS = 8000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

// ── Helpers ──────────────────────────────────────────────

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(timer);
    }
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// ── Core API ─────────────────────────────────────────────

async function fetchFromApi(apiDef, logger) {
    const { name, url, headers, parse, type } = apiDef;

    try {
        const res = await fetchWithTimeout(url, { headers });
        if (!res.ok) {
            logger?.warn({ status: res.status, api: name }, `API ${name} returned ${res.status}`);
            return null;
        }

        const data = await res.json();
        if (!data) return null;

        const parsed = parse(data);
        if (!parsed) return null;

        // Determine content ID for dedup
        const contentId = parsed.id || (type === 'image' ? hashContent(parsed.imageUrl) : hashContent(parsed.text));
        if (!contentId) return null;

        // Check for duplicate
        if (hasSent(contentId)) {
            logger?.info({ api: name }, `Duplicate from ${name}, skipping`);
            return null;
        }

        markSent(contentId);
        return { ...parsed, type, id: contentId, source: name };
    } catch (err) {
        if (err.name === 'AbortError') {
            logger?.warn({ api: name }, `API ${name} timed out`);
        } else {
            logger?.warn({ err, api: name }, `API ${name} failed`);
        }
        return null;
    }
}

/**
 * Get one random entertainment item.
 * Tries APIs in random order with fallback.
 *
 * @param {Object} options
 * @param {boolean} options.includeYoMama - Whether to include Yo Mama jokes
 * @param {string} options.type - 'text', 'image', or undefined for any
 * @param {Object} options.logger - Pino logger instance
 * @returns {Promise<object|null>}
 */
async function getRandomEntertainment(options = {}) {
    const { includeYoMama = false, type, logger } = options;

    let apis = API_DEFS.filter(api => {
        if (api.optional && !includeYoMama) return false;
        if (type && api.type !== type) return false;
        return true;
    });

    if (apis.length === 0) {
        logger?.warn('No entertainment APIs available for the given filters');
        return null;
    }

    apis = shuffle([...apis]);

    for (const apiDef of apis) {
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            const result = await fetchFromApi(apiDef, logger);
            if (result) {
                logger?.info({ api: apiDef.name, attempt, type: result.type }, `Entertainment fetched from ${apiDef.name}`);
                return {
                    type: result.type,
                    text: result.text || null,
                    imageUrl: result.imageUrl || null,
                    caption: result.caption || null,
                    label: apiDef.label,
                    source: apiDef.name
                };
            }
            if (attempt < MAX_RETRIES) await delay(RETRY_DELAY_MS * attempt);
        }
    }

    logger?.warn('All entertainment APIs exhausted');
    return null;
}

/**
 * Get a specific content type on demand.
 */
async function getQuote() { return getRandomEntertainment({ type: 'text', logger: null }); }
async function getDogImage() { return getRandomEntertainment({ type: 'image', logger: null }); }

/**
 * Fallback pool for when all APIs fail.
 */
function getFallbackEntertainment() {
    const pool = [
        { text: '*Random Joke* 🃏\n\nKenapa programmer selalu bingung antara Halloween dan Natal?\n\nKarena Oct 31 = Dec 25!', label: 'Local' },
        { text: '*Fakta Acak* 🤓\n\nSidik jari koala hampir identik dengan sidik jari manusia, bahkan di bawah mikroskop sekalipun.', label: 'Local' },
        { text: '*Quote* 💬\n\n_"The only way to do great work is to love what you do."_\n\n— Steve Jobs', label: 'Local' },
        { text: '*Random Joke* 🃏\n\nKenapa wifi suka sama HP?\n\nKarena sinyalnya nyambung terus!', label: 'Local' },
        { text: '*Cat Fact* 🐱\n\nRata-rata kucing tidur 13-14 jam per hari — artinya kucing menghabiskan ~70% hidupnya untuk tidur.', label: 'Local' },
        { text: '*Fakta Acak* 🤓\n\nHiu sudah ada di Bumi lebih dulu dari pohon — sekitar 400 juta vs 350 juta tahun lalu.', label: 'Local' },
        { text: '*Dad Joke* 👨\n\nWhat do you call a fake noodle?\n\nAn impasta.', label: 'Local' },
        { text: '*Quote* 💬\n\n_"In the middle of difficulty lies opportunity."_\n\n— Albert Einstein', label: 'Local' },
    ];

    const item = pool[Math.floor(Math.random() * pool.length)];
    const id = hashContent(item.text);
    if (!hasSent(id)) markSent(id);

    return { type: 'text', text: item.text, label: item.label, source: 'Fallback' };
}

module.exports = {
    getRandomEntertainment,
    getFallbackEntertainment,
    getQuote,
    getDogImage,
    API_DEFS
};
