// Meme service — generates meme images using api.memegen.link.
// Supports auto-meme (1-2x/day via cron) and manual on-demand generation.

const { hasSent, markSent, hashContent } = require('../utils/contentHistory');

// ── Memegen API Config ───────────────────────────────────

const MEMEGEN_BASE = 'https://api.memegen.link';
const TIMEOUT_MS = 10000;

// ── Curated popular meme templates ───────────────────────

const TEMPLATES = [
    'doge', 'buzz', 'fine', 'both', 'chosen', 'grumpycat',
    'awkward', 'bad', 'boat', 'fry', 'ggg', 'iw', 'older',
    'puffin', 'sohappy', 'tenguy', 'wonka', 'yuno', 'success',
    'disastergirl', 'rollsafe', 'morpheus', 'facepalm', 'everywhere',
    'db', 'keanu', 'cb', 'fwp'
];

// ── Auto-meme text pairs (top, bottom) ──────────────────

const AUTO_MEME_TEXTS = [
    { top: 'When you deploy', bottom: 'on Friday afternoon' },
    { top: 'Writing code at 3am', bottom: "it works but i don't know why" },
    { top: 'Production server', bottom: 'has 99 problems' },
    { top: 'Me looking at the bug', bottom: 'the bug looking back at me' },
    { top: 'When someone says', bottom: 'just restart the server' },
    { top: 'Waiting for npm install', bottom: '...' },
    { top: 'Stack Overflow', bottom: 'marked as duplicate' },
    { top: 'QA finds a bug', bottom: "it's a feature" },
    { top: 'Me explaining my code', bottom: 'to future me' },
    { top: 'When the client asks', bottom: 'can you make it pop more' },
    { top: 'My code works', bottom: "and i'm scared to touch it" },
    { top: 'Database migration', bottom: 'on production' },
    { top: 'Testing in production', bottom: 'because why not' },
    { top: 'Agile daily standup', bottom: 'what did you do yesterday?' },
    { top: 'When AI writes my code', bottom: 'and it actually runs' },
    { top: 'API documentation', bottom: 'left as an exercise' },
    { top: 'My last brain cell', bottom: 'during the meeting' },
    { top: 'Bug in production', bottom: "it's fine.jpg" },
];

// ── Helpers ──────────────────────────────────────────────

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

function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

// ── Public API ───────────────────────────────────────────

/**
 * Generate a meme image URL using memegen.link.
 *
 * @param {string} template - Meme template ID (e.g. 'doge', 'buzz')
 * @param {string} topText - Top caption
 * @param {string} bottomText - Bottom caption
 * @returns {string} Meme image URL
 */
function buildMemeUrl(template, topText, bottomText) {
    const top = encodeURIComponent(topText || '_');
    const bottom = encodeURIComponent(bottomText || '_');
    return `${MEMEGEN_BASE}/images/${template}/${top}/${bottom}.png`;
}

/**
 * Get a list of available meme templates.
 */
function getTemplates() {
    return [...TEMPLATES];
}

/**
 * Generate a random auto-meme.
 * Picks a random template + random text pair, generates the image URL.
 *
 * @param {Object} options
 * @param {Object} options.logger
 * @returns {Promise<{imageUrl: string, caption: string}|null>}
 */
async function getRandomMeme(options = {}) {
    const { logger } = options;

    // Pick random template + text pair
    const template = pick(TEMPLATES);
    const memeText = pick(AUTO_MEME_TEXTS);
    const top = memeText.top;
    const bottom = memeText.bottom;

    // Dedup: check if this exact combo sent before
    const dedupKey = hashContent(`${template}|${top}|${bottom}`);
    if (hasSent(dedupKey)) {
        logger?.info('Auto-meme: duplicate combo, trying another');
        // Try with shuffled templates to get a fresh combo
        const shuffledTemplates = shuffle([...TEMPLATES]);
        for (const t of shuffledTemplates) {
            const altText = pick(AUTO_MEME_TEXTS);
            const altKey = hashContent(`${t}|${altText.top}|${altText.bottom}`);
            if (!hasSent(altKey)) {
                markSent(altKey);
                const url = buildMemeUrl(t, altText.top, altText.bottom);
                return {
                    type: 'image',
                    imageUrl: url,
                    caption: `*Meme Auto* 🎭\n${altText.top} / ${altText.bottom}`,
                    label: 'Auto Meme'
                };
            }
        }
        // All seen — return the original anyway
    }

    markSent(dedupKey);
    const imageUrl = buildMemeUrl(template, top, bottom);

    return {
        type: 'image',
        imageUrl,
        caption: `*Meme Auto* 🎭\n${top} / ${bottom}`,
        label: 'Auto Meme'
    };
}

/**
 * Generate a meme on demand with custom text.
 *
 * @param {string} template - Template ID or 'random'
 * @param {string} topText
 * @param {string} bottomText
 * @returns {{imageUrl: string, caption: string}}
 */
function getCustomMeme(template, topText, bottomText) {
    const t = template === 'random' ? pick(TEMPLATES) : template;
    const imageUrl = buildMemeUrl(t, topText || '', bottomText || '');

    // Don't dedup manual memes — user might want to tweak
    return {
        type: 'image',
        imageUrl,
        caption: `*Meme* 🎭\nTemplate: ${t}`
    };
}

module.exports = {
    getRandomMeme,
    getCustomMeme,
    getTemplates,
    buildMemeUrl
};
