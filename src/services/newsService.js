// News service — dual-source curated morning briefing for Indonesian WhatsApp groups.
//
// Architecture:
//   A. Indonesia search (40 results, ID domains, lang=ID) → 4 best national articles
//   B. World search     (40 results, trusted intl domains)  → 1 most important global article
//
// Pipeline per article:
//   raw result → buildArticle → isValidArticleUrl → isIndividualArticle
//   → hasClearNewsEvent → isInformativeDescription → importanceScore
//   → verifyUrl → dedup → diversify → translate → format
//
// NO AI-generated URLs. Every URL comes directly from results.news[].url.

const { hasSent, markSent, hashContent } = require('../utils/contentHistory');
const { editNewsWithGroq } = require('./groqNewsEditor');

// Idempotency tracker — prevents duplicate sends after reconnect
const _slotStatus = new Map(); // generationKey → { status, timestamp }

// ═══════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════

const YDC_API_KEY = process.env.YDC_API_KEY || '';
const WEB_SEARCH_URL = 'https://ydc-index.io/v1/search';
const TIMEOUT_MS = 25000;
const URL_VERIFY_TIMEOUT_MS = 10000;
const MAX_ID_ARTICLES = 4;
const MAX_WORLD_ARTICLES = 1;
const MAX_PAGE_AGE_HOURS = 36;
const MAX_SAME_SOURCE = 2;

// Groq editor candidate limits
const MAX_ID_CANDIDATES = 8;
const MAX_WORLD_CANDIDATES = 4;

// ═══════════════════════════════════════════════════════════
// DOMAIN LISTS
// ═══════════════════════════════════════════════════════════

const INDONESIA_DOMAINS = [
    'antaranews.com',
    'kompas.com',
    'tempo.co',
    'cnnindonesia.com',
    'cnbcindonesia.com',
    'detik.com',
    'bisnis.com',
    'kontan.co.id',
    'tirto.id',
    'thejakartapost.com',
    'katadata.co.id',
    'mediaindonesia.com',
    'republika.co.id',
    'suara.com',
    'liputan6.com',
    'merdeka.com',
    'kumparan.com',
    'bbc.com/indonesia',
    'voaindonesia.com',
];

const WORLD_DOMAINS = [
    'reuters.com',
    'apnews.com',
    'bbc.com',
    'bbc.co.uk',
    'npr.org',
    'aljazeera.com',
    'theguardian.com',
    'france24.com',
    'dw.com',
    'cnn.com',
    'nytimes.com',
    'washingtonpost.com',
    'bloomberg.com',
    'wsj.com',
    'abcnews.go.com',
    'nbcnews.com',
    'cbsnews.com',
    'thehill.com',
    'politico.com',
    'axios.com',
];

const EXCLUDED_DOMAINS = [
    'wild941.com',
    'youtube.com',
    'instagram.com',
    'tiktok.com',
    'facebook.com',
    'x.com',
    'twitter.com',
    'reddit.com',
    'wikipedia.org',
];

// ═══════════════════════════════════════════════════════════
// SLOT DEFINITIONS
// ═══════════════════════════════════════════════════════════

const SLOTS = {
    morning: {
        cron: '0 7 * * *',
        emoji: '☀️',
        title: 'MORNING NEWS',
        greetings: [
            '☀️ Selamat pagi! Kabar penting hari ini.',
            '🌅 Morning briefing — yang perlu kamu tahu hari ini.',
            '🌤️ Pagi! Ini berita penting nasional dan dunia.',
            '⛅ Selamat pagi! Rangkuman berita hari ini:',
        ],
    },
    midday: {
        cron: '0 12 * * *',
        emoji: '🍽️',
        title: 'MIDDAY BRIEF',
        greetings: [
            '🍽️ Teman makan siang — update berita:',
            '📊 Sambil istirahat, ini kabar terbaru:',
            '☕ Rehat siang sambil baca berita:',
            '🍱 Lunch break + update berita:',
        ],
    },
    evening: {
        cron: '0 17 * * *',
        emoji: '🌆',
        title: 'EVENING BRIEF',
        greetings: [
            '🌆 Sore! Rekap berita hari ini:',
            '🌇 Waktunya update — yang terjadi hari ini:',
            '🏙️ Dalam perjalanan pulang? Baca ini:',
            '🌄 Slow down, ini kabar penting hari ini:',
        ],
    },
    nightcap: {
        cron: '0 21 * * *',
        emoji: '🌙',
        title: 'NIGHTCAP',
        greetings: [
            '🌙 Sebelum tidur — cerita penting hari ini:',
            '🌃 Nightcap — yang terjadi hari ini:',
            '✨ Akhiri hari dengan kabar baik:',
            '🛌 Briefing malam sebelum istirahat:',
        ],
    },
};

// ═══════════════════════════════════════════════════════════
// URL HELPERS
// ═══════════════════════════════════════════════════════════

function normalizeNewsUrl(rawUrl) {
    if (typeof rawUrl !== 'string') return null;
    const cleaned = rawUrl
        .normalize('NFC')
        .replace(/[​-‍⁠﻿]/g, '')
        .replace(/ /g, '')
        .trim();
    try {
        const parsed = new URL(cleaned);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        return parsed.href;
    } catch {
        return null;
    }
}

/**
 * Full URL validation — checks domain, path, and structural integrity.
 * Returns { ok: boolean, reason?: string, hostname?: string }
 */
function isValidArticleUrl(urlStr) {
    try {
        const url = new URL(urlStr);
        const hostname = url.hostname.replace(/^www\./, '');
        const pathname = url.pathname.replace(/\/+$/, '').toLowerCase();

        // Excluded domains
        if (EXCLUDED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) {
            return { ok: false, reason: 'excluded_domain', hostname };
        }

        // Suspicious path patterns
        const suspiciousPaths = [
            '/exports/', '/tag/', '/tags/', '/topic/', '/topics/',
            '/category/', '/categories/', '/search/', '/author/',
            '/feed/', '/rss/', '/wp-content/', '/cdn-cgi/',
        ];
        if (suspiciousPaths.some(p => pathname.includes(p))) {
            return { ok: false, reason: 'suspicious_path', hostname };
        }

        // Bare section pages
        const sectionPaths = [
            '/news', '/money', '/sports', '/weather', '/local',
            '/latest', '/live', '/video', '/photos', '/podcasts',
            '/mostpopular', '/trending',
        ];
        if (sectionPaths.includes(pathname)) {
            return { ok: false, reason: 'section_page_not_article', hostname };
        }

        // Homepage
        if (pathname === '' || pathname === '/') {
            return { ok: false, reason: 'homepage', hostname };
        }

        return { ok: true, hostname };
    } catch {
        return { ok: false, reason: 'invalid_url' };
    }
}

function containsValidClickableUrl(text) {
    return /https?:\/\/[^\s]+/i.test(text);
}

// ═══════════════════════════════════════════════════════════
// CONTENT QUALITY HELPERS
// ═══════════════════════════════════════════════════════════

/**
 * Check whether this looks like an individual article (not a section page).
 */
function isLikelyIndividualArticle(article) {
    const title = article.title?.trim() ?? '';
    const urlStr = article.url ?? '';

    let pathname = '';
    try { pathname = new URL(urlStr).pathname.replace(/\/+$/, '').toLowerCase(); } catch { /* ignore */ }

    // Generic section paths
    const genericPaths = ['/news', '/money', '/sports', '/weather', '/local', '/latest', '/live'];
    if (genericPaths.includes(pathname)) return false;

    // Generic titles that indicate a section page, not an article
    const genericTitlePatterns = [
        /^latest news/i,
        /^breaking news$/i,
        /news, weather, sports/i,
        /news home/i,
        /^live updates:?\s?today/i,
        /^\w+ news, weather/i,
        /^\w+ \| news, weather/i,
        /^home\s*[-–—|]/i,
    ];

    if (genericTitlePatterns.some(p => p.test(title))) return false;

    return true;
}

/**
 * Detect descriptions that contain no substantive news information.
 */
function isUninformativeDescription(description = '') {
    const text = description.trim();
    const lower = text.toLowerCase();

    if (text.length < 40) return true;

    const genericPatterns = [
        /^monday links!?$/i, /^tuesday links!?$/i, /^wednesday links!?$/i,
        /^thursday links!?$/i, /^friday links!?$/i,
        /^saturday links!?$/i, /^sunday links!?$/i,
        /^(the\s+)?latest updates?\.?$/i,
        /^read more here\.?$/i,
        /^click here to read more\.?$/i,
        /^live updates?\.?$/i,
        /^(follow\s+)?our live coverage\.?$/i,
        /^breaking news\.?$/i,
        /^news roundup\.?$/i,
        /^today'?s top stories\.?$/i,
        /^here'?s what you need to know\.?$/i,
        /^what to know\.?$/i,
        /^top stories\.?$/i,
        /^daily news\.?$/i,
        /^your daily briefing\.?$/i,
        /^catch up on the latest\.?$/i,
        /^get the latest\.?$/i,
        /^stay informed\.?$/i,
    ];

    if (genericPatterns.some(p => p.test(text))) return true;

    // Long text that's actually a site profile, not article content
    const siteProfileIndicators = [
        'is your source for',
        'your trusted source for',
        'covering', 'local coverage',
        'weather coverage', 'severe weather',
        'balanced news',
        'app features',
        'download our app',
        'subscribe to',
        'newsletter',
    ];
    const indicatorCount = siteProfileIndicators.filter(p => lower.includes(p)).length;
    if (indicatorCount >= 2) return true;

    // Single indicator + no news substance
    if (indicatorCount >= 1 && text.length < 120) return true;

    return false;
}

/**
 * Determine whether an article contains a clear, understandable news event.
 * An article that lacks this cannot produce a useful summary.
 */
function hasClearNewsEvent(article) {
    const title = article.title?.trim() ?? '';
    const description = article.description?.trim() ?? '';

    if (!title || title.length < 20) return false;
    if (isUninformativeDescription(description)) return false;

    const combined = `${title} ${description}`.toLowerCase();

    // These phrases indicate roundups or section headers, not specific events
    const nonEventPhrases = [
        'latest news', 'news roundup', 'live updates',
        'top stories', 'monday links', 'tuesday links',
        'wednesday links', 'thursday links', 'friday links',
        'weekend links', 'read more', 'breaking news and weather',
        'daily links',
    ];

    if (nonEventPhrases.some(p => combined.includes(p))) return false;

    // Sports roundup detection — only block routine roundups
    const sportsRoundupIndicators = [
        'mariners news:', 'baseball links', 'nfl links',
        'nba links', 'soccer links', 'sports links',
        'fantasy sports', 'game preview', 'game recap:',
    ];
    if (sportsRoundupIndicators.some(p => combined.includes(p))) return false;

    return true;
}

// ═══════════════════════════════════════════════════════════
// IMPORTANCE SCORING
// ═══════════════════════════════════════════════════════════

/**
 * Score an Indonesia article by national significance.
 * Higher = more important for an Indonesian audience.
 */
function scoreIndonesiaArticle(article) {
    let score = 0;
    const text = `${article.title ?? ''} ${article.description ?? ''}`.toLowerCase();
    const hostname = article._hostname || '';

    // ── National keywords (strong signal) ──
    const nationalKeywords = [
        'presiden', 'pemerintah', 'kementerian', 'menteri',
        'kebijakan', 'undang-undang', 'uu ', 'peraturan',
        'dpr', 'mpr', 'mahkamah', 'konstitusi',
        'apbn', 'anggaran negara',
    ];
    for (const kw of nationalKeywords) {
        if (text.includes(kw)) score += 5;
    }

    // ── Economic keywords ──
    const economyKeywords = [
        'ekonomi', 'inflasi', 'rupiah', 'harga', 'subsidi',
        'pajak', 'anggaran', 'investasi', 'perdagangan',
        'ekspor', 'impor', 'bunga', 'kredit', 'perbankan',
        'ojk', 'bank indonesia', 'kemnaker',
    ];
    for (const kw of economyKeywords) {
        if (text.includes(kw)) score += 4;
    }

    // ── Public welfare keywords ──
    const welfareKeywords = [
        'kesehatan', 'pendidikan', 'sekolah', 'universitas',
        'bencana', 'gempa', 'banjir', 'tsunami', 'erupsi',
        'longsor', 'kebakaran', 'bantuan',
        'lingkungan', 'iklim', 'polusi',
        'transportasi', 'infrastruktur', 'jalan tol',
        'listrik', 'air bersih', 'pangan',
    ];
    for (const kw of welfareKeywords) {
        if (text.includes(kw)) score += 3;
    }

    // ── Tech / science / innovation ──
    const techKeywords = [
        'teknologi', 'digital', 'startup', 'inovasi',
        'satelit', 'riset', 'penelitian', 'sains',
        'ai ', 'artificial intelligence', 'energi terbarukan',
    ];
    for (const kw of techKeywords) {
        if (text.includes(kw)) score += 3;
    }

    // ── Law / security ──
    const lawKeywords = [
        'hukum', 'pengadilan', 'kpk', 'korupsi',
        'keamanan', 'polri', 'tni',
        'ham', 'demonstrasi',
    ];
    for (const kw of lawKeywords) {
        if (text.includes(kw)) score += 3;
    }

    // ── Explicit national mention ──
    if (text.includes('indonesia')) score += 3;
    if (text.includes('nasional')) score += 2;

    // ── Source reputation ──
    const topSources = ['antaranews.com', 'kompas.com', 'tempo.co', 'cnnindonesia.com'];
    if (topSources.some(s => hostname === s)) score += 4;

    // ── Penalties: low-value content ──
    const lowValueIndicators = [
        'selebriti', 'gossip', 'sinetron', 'ftv',
        'horoscope', 'zodiak', 'viral dance', 'tiktok',
        'cuaca lokal', 'lalu lintas', 'kecelakaan tunggal',
        'liga 2', 'liga 3',
    ];
    for (const kw of lowValueIndicators) {
        if (text.includes(kw)) score -= 8;
    }

    return score;
}

/**
 * Score a world article by global significance for an Indonesian audience.
 */
function scoreWorldArticle(article) {
    let score = 0;
    const text = `${article.title ?? ''} ${article.description ?? ''}`.toLowerCase();
    const hostname = article._hostname || '';

    // ── War / conflict ──
    const conflictKeywords = [
        'war', 'conflict', 'invasion', 'ceasefire', 'military',
        'missile', 'strike', 'troops', 'nato', 'sanctions',
        'peace talk', 'humanitarian',
    ];
    for (const kw of conflictKeywords) {
        if (text.includes(kw)) score += 6;
    }

    // ── Global economy ──
    const economyKeywords = [
        'global economy', 'recession', 'inflation', 'federal reserve',
        'central bank', 'interest rate', 'trade war', 'tariff',
        'stock market', 'oil price', 'energy crisis', 'supply chain',
        'imf', 'world bank', 'g20', 'g7',
    ];
    for (const kw of economyKeywords) {
        if (text.includes(kw)) score += 5;
    }

    // ── Major disasters ──
    const disasterKeywords = [
        'earthquake', 'hurricane', 'typhoon', 'tsunami',
        'flooding', 'wildfire', 'volcano', 'pandemic',
        'outbreak', 'epidemic',
    ];
    for (const kw of disasterKeywords) {
        if (text.includes(kw)) score += 5;
    }

    // ── Science / tech breakthroughs ──
    const scienceKeywords = [
        'breakthrough', 'discovery', 'nasa', 'space', 'mars',
        'ai breakthrough', 'artificial intelligence breakthrough',
        'cancer', 'vaccine', 'climate change', 'global warming',
        'gene therapy', 'quantum',
    ];
    for (const kw of scienceKeywords) {
        if (text.includes(kw)) score += 4;
    }

    // ── Major government decisions ──
    const govKeywords = [
        'president', 'prime minister', 'election', 'summit',
        'treaty', 'united nations', 'security council',
        'diplomatic', 'embassy', 'evacuation',
    ];
    for (const kw of govKeywords) {
        if (text.includes(kw)) score += 4;
    }

    // ── Indonesia relevance ──
    if (text.includes('indonesia') || text.includes('jakarta') || text.includes('asean')) {
        score += 8;
    }
    if (text.includes('asia') || text.includes('southeast asia') || text.includes('pacific')) {
        score += 3;
    }

    // ── Source reputation ──
    const topSources = ['reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk', 'aljazeera.com'];
    if (topSources.some(s => hostname === s)) score += 5;

    // ── Penalties: local/trivial ──
    const trivialIndicators = [
        'local weather', 'traffic', 'community event',
        'celebrity', 'viral dance', 'tiktok', 'horoscope',
        'business break-in', 'suspects wanted', 'police blotter',
        'game preview', 'transfer rumor', 'fantasy sports',
        'royal family', 'tabloid',
    ];
    for (const kw of trivialIndicators) {
        if (text.includes(kw)) score -= 10;
    }

    return score;
}

// ═══════════════════════════════════════════════════════════
// ARTICLE BUILDER
// ═══════════════════════════════════════════════════════════

function buildArticleFromRaw(rawArticle, rawIndex, category) {
    const url = normalizeNewsUrl(rawArticle.url);
    const urlCheck = url ? isValidArticleUrl(url) : { ok: false, reason: 'no_url' };
    const hostname = urlCheck.hostname || null;

    return {
        _rawIndex: rawIndex,
        _rawUrl: rawArticle.url,
        _hostname: hostname,
        _category: category, // 'indonesia' | 'world'

        title: rawArticle.title?.trim() || '',
        description: (rawArticle.description || rawArticle.snippet || '').trim(),
        url: urlCheck.ok ? url : null,
        source: rawArticle.source || hostname || '',
        pageAge: rawArticle.page_age || rawArticle.pageAge || null,

        // Quality flags (filled during pipeline)
        _urlValid: urlCheck.ok,
        _urlRejectReason: urlCheck.ok ? null : urlCheck.reason,
    };
}

// ═══════════════════════════════════════════════════════════
// SIMPLE INDONESIAN SUMMARIZATION
// ═══════════════════════════════════════════════════════════

/**
 * Produce a 1-2 sentence Indonesian summary from raw article data.
 * For Indonesian articles: title/description are likely already in Indonesian,
 * so we clean and condense. For world articles: we produce a simple Indonesian
 * explanation from the English raw data.
 *
 * NEVER invents facts. Only rephrases what's in title + description.
 */
function buildIndonesianSummary(article) {
    const title = article.title || '';
    const desc = article.description || '';
    const source = article.source || '';
    const category = article._category || 'world';

    // If title is already Indonesian, use a cleaned version of title+desc
    if (category === 'indonesia') {
        return buildIdSummary(article);
    }

    // World article: produce a simple Indonesian explanation
    return buildWorldSummary(article);
}

function buildIdSummary(article) {
    const title = article.title || '';
    let desc = article.description || '';

    // Clean up description — remove site boilerplate
    desc = desc
        .replace(/^(Jakarta|JAKARTA),\s*(KOMPAS\.com|CNN Indonesia|TEMPO\.CO|ANTARA)\s*[-–—]\s*/i, '')
        .replace(/\b(Baca juga|Simak juga|Baca selengkapnya).*$/i, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    // If description is substantial, use it
    if (desc.length >= 60) {
        // Truncate to ~2 sentences
        const sentences = desc.split(/(?<=[.!?])\s+/);
        const short = sentences.slice(0, 2).join(' ').trim();
        if (short.length >= 40) return short;
    }

    // Fallback: use title as the summary
    if (title.length >= 30) return title;

    // Minimal fallback
    return `Perkembangan penting: ${title}`;
}

function buildWorldSummary(article) {
    const title = article.title || '';
    const desc = article.description || '';

    // Template-based translation for common patterns
    // This is a minimal approach — for production, use a translation API
    const combined = `${title}. ${desc}`.toLowerCase();

    // Try to construct a meaningful Indonesian sentence from the English data
    // using a simple structured approach based on keyword detection

    const parts = [];

    // Detect subject and action
    if (combined.includes('announc')) {
        parts.push('mengumumkan');
    } else if (combined.includes('launch')) {
        parts.push('meluncurkan');
    } else if (combined.includes('discover') || combined.includes('breakthrough')) {
        parts.push('menemukan');
    } else if (combined.includes('sign') || combined.includes('agree')) {
        parts.push('menandatangani');
    } else if (combined.includes('attack') || combined.includes('strike')) {
        parts.push('melancarkan serangan');
    } else if (combined.includes('warn')) {
        parts.push('memberikan peringatan');
    } else if (combined.includes('approve')) {
        parts.push('menyetujui');
    } else if (combined.includes('reject') || combined.includes('veto')) {
        parts.push('menolak');
    } else if (combined.includes('increase') || combined.includes('rise') || combined.includes('surge')) {
        parts.push('melonjak');
    } else if (combined.includes('decrease') || combined.includes('drop') || combined.includes('fall')) {
        parts.push('menurun tajam');
    } else if (combined.includes('die') || combined.includes('kill') || combined.includes('death')) {
        parts.push('menewaskan');
    }

    // Construct a fallback summary
    if (parts.length > 0 && desc.length >= 60) {
        // We have a keyword action + description — use description as the summary
        // (it will be in English but that's better than inventing facts)
        const cleanDesc = desc
            .replace(/^(WASHINGTON|LONDON|NEW YORK|PARIS|GENEVA|BRUSSELS|BEIJING|TOKYO),\s*/i, '')
            .replace(/\s{2,}/g, ' ')
            .trim();

        if (cleanDesc.length >= 50) {
            return cleanDesc;
        }
    }

    // Minimal: just the English description (better than inventing)
    if (desc.length >= 40) return desc;

    // Last resort
    return title;
}

// ═══════════════════════════════════════════════════════════
// API HELPERS
// ═══════════════════════════════════════════════════════════

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

function parsePageAgeHours(pageAge) {
    if (!pageAge || typeof pageAge !== 'string') return null;
    const str = pageAge.toLowerCase().trim();

    const hoursMatch = str.match(/(\d+)\s*hours?\s*ago/);
    if (hoursMatch) return parseInt(hoursMatch[1], 10);

    const hMatch = str.match(/(\d+)\s*h\s*ago/);
    if (hMatch) return parseInt(hMatch[1], 10);

    const daysMatch = str.match(/(\d+)\s*days?\s*ago/);
    if (daysMatch) return parseInt(daysMatch[1], 10) * 24;

    const dMatch = str.match(/(\d+)\s*d\s*ago/);
    if (dMatch) return parseInt(dMatch[1], 10) * 24;

    if (/minutes?\s*ago|min\s*ago/.test(str)) return 0;
    if (/weeks?\s*ago|months?\s*ago|years?\s*ago/.test(str)) return 9999;

    return null;
}

async function verifyArticleUrl(url, logger) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), URL_VERIFY_TIMEOUT_MS);
        let response;
        try {
            response = await fetch(url, {
                method: 'GET',
                redirect: 'follow',
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StickerinBot/1.0)' },
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }

        // Validate final URL after redirects — prevent SSRF to untrusted hosts
        const finalUrl = response.url;
        const finalUrlCheck = isValidArticleUrl(finalUrl);
        if (!finalUrlCheck.ok) {
            logger?.info({
                originalUrl: url,
                finalUrl,
                reason: finalUrlCheck.reason,
                hostname: finalUrlCheck.hostname,
            }, 'URL verify: redirect to untrusted host — rejected');
            return { valid: false, status: response.status, finalUrl, contentType: null, error: `redirect_untrusted: ${finalUrlCheck.reason}` };
        }

        return {
            valid: response.status >= 200 && response.status < 400,
            status: response.status,
            finalUrl,
            contentType: response.headers.get('content-type') || undefined,
        };
    } catch (error) {
        return { valid: false, status: null, finalUrl: null, contentType: null, error: error.message };
    }
}

// ═══════════════════════════════════════════════════════════
// DUAL-SOURCE FETCH
// ═══════════════════════════════════════════════════════════

async function fetchIndonesiaNews(logger) {
    if (!YDC_API_KEY) {
        logger?.warn('YDC_API_KEY not set');
        return [];
    }

    const params = new URLSearchParams({
        query: [
            'berita nasional Indonesia terbaru hari ini',
            'perkembangan penting Indonesia hari ini',
            'kebijakan pemerintah ekonomi teknologi pendidikan kesehatan bencana nasional',
            'berita Indonesia yang berdampak luas bagi masyarakat',
        ].join(' '),
        freshness: 'day',
        country: 'ID',
        language: 'ID',
        count: '40',
        safesearch: 'strict',
        include_domains: INDONESIA_DOMAINS.join(','),
    });

    const url = `${WEB_SEARCH_URL}?${params.toString()}`;
    logger?.info('[Indonesia] Fetching...');

    try {
        const res = await fetchWithTimeout(url, {
            method: 'GET',
            headers: { 'X-API-Key': YDC_API_KEY, 'Accept': 'application/json' },
        }, TIMEOUT_MS);

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            logger?.warn({ status: res.status, body: body.slice(0, 200) }, '[Indonesia] API error');
            return [];
        }

        const data = await res.json();
        const rawNews = data?.results?.news ?? [];

        if (!Array.isArray(rawNews) || rawNews.length === 0) {
            logger?.warn('[Indonesia] No results.news');
            return [];
        }

        logger?.info({ count: rawNews.length }, `[Indonesia] ${rawNews.length} raw results`);

        return rawNews
            .map((raw, i) => buildArticleFromRaw(raw, i, 'indonesia'))
            .filter(a => a.url !== null);
    } catch (err) {
        logger?.warn({ err: err.message }, '[Indonesia] Fetch exception');
        return [];
    }
}

async function fetchWorldNews(logger) {
    if (!YDC_API_KEY) {
        logger?.warn('YDC_API_KEY not set');
        return [];
    }

    const params = new URLSearchParams({
        query: [
            'most important world news today',
            'major global development today',
            'breaking international news with worldwide impact',
            'major war economy science technology climate or disaster development',
        ].join(' '),
        freshness: 'day',
        language: 'EN',
        count: '40',
        safesearch: 'strict',
        include_domains: WORLD_DOMAINS.join(','),
    });

    const url = `${WEB_SEARCH_URL}?${params.toString()}`;
    logger?.info('[World] Fetching...');

    try {
        const res = await fetchWithTimeout(url, {
            method: 'GET',
            headers: { 'X-API-Key': YDC_API_KEY, 'Accept': 'application/json' },
        }, TIMEOUT_MS);

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            logger?.warn({ status: res.status, body: body.slice(0, 200) }, '[World] API error');
            return [];
        }

        const data = await res.json();
        const rawNews = data?.results?.news ?? [];

        if (!Array.isArray(rawNews) || rawNews.length === 0) {
            logger?.warn('[World] No results.news');
            return [];
        }

        logger?.info({ count: rawNews.length }, `[World] ${rawNews.length} raw results`);

        return rawNews
            .map((raw, i) => buildArticleFromRaw(raw, i, 'world'))
            .filter(a => a.url !== null);
    } catch (err) {
        logger?.warn({ err: err.message }, '[World] Fetch exception');
        return [];
    }
}

// ═══════════════════════════════════════════════════════════
// DEDUPLICATION
// ═══════════════════════════════════════════════════════════

function deduplicateArticles(articles, logger) {
    const seenUrls = new Set();
    const seenTitleKeys = new Set();
    const result = [];

    for (const article of articles) {
        let urlKey = null;
        try {
            const u = new URL(article.url);
            urlKey = u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
        } catch {
            continue;
        }

        if (seenUrls.has(urlKey)) {
            logger?.info({ url: article.url }, 'Dedup: duplicate URL');
            continue;
        }
        seenUrls.add(urlKey);

        const titleKey = (article.title || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80);

        if (titleKey && seenTitleKeys.has(titleKey)) {
            logger?.info({ title: article.title }, 'Dedup: duplicate title');
            continue;
        }
        if (titleKey) seenTitleKeys.add(titleKey);

        result.push(article);
    }

    return result;
}

// ═══════════════════════════════════════════════════════════
// TOPIC DIVERSIFICATION
// ═══════════════════════════════════════════════════════════

const TOPIC_CATEGORIES = {
    government_politics: {
        keywords: ['presiden', 'pemerintah', 'kementerian', 'menteri', 'dpr', 'kebijakan', 'uu ', 'undang-undang', 'pilpres', 'pemilu', 'politik', 'parlemen'],
    },
    economy: {
        keywords: ['ekonomi', 'rupiah', 'harga', 'inflasi', 'subsidi', 'pajak', 'anggaran', 'investasi', 'perdagangan', 'ekspor', 'bunga', 'kredit', 'perbankan', 'ojk', 'apbn'],
    },
    social_welfare: {
        keywords: ['kesehatan', 'pendidikan', 'sekolah', 'universitas', 'rumah sakit', 'bansos', 'bantuan sosial', 'vaksin', 'obat', 'guru', 'siswa', 'mahasiswa'],
    },
    disaster_environment: {
        keywords: ['bencana', 'gempa', 'banjir', 'tsunami', 'erupsi', 'longsor', 'kebakaran', 'cuaca', 'iklim', 'lingkungan', 'polusi', 'konservasi'],
    },
    tech_science: {
        keywords: ['teknologi', 'digital', 'startup', 'satelit', 'riset', 'penelitian', 'sains', 'inovasi', 'ai ', 'artificial intelligence', 'energi', 'internet', 'data'],
    },
    law_security: {
        keywords: ['hukum', 'pengadilan', 'kpk', 'korupsi', 'keamanan', 'polri', 'tni', 'ham', 'kriminal', 'pidana', 'peradilan'],
    },
    infrastructure_transport: {
        keywords: ['infrastruktur', 'jalan tol', 'transportasi', 'kereta', 'bandara', 'pelabuhan', 'listrik', 'air bersih', 'mbangunan', 'proyek'],
    },
};

function classifyTopic(article) {
    const text = `${article.title ?? ''} ${article.description ?? ''}`.toLowerCase();
    for (const [category, def] of Object.entries(TOPIC_CATEGORIES)) {
        const matchCount = def.keywords.filter(kw => text.includes(kw)).length;
        if (matchCount >= 2) return category;
    }
    return 'general';
}

/**
 * Diversify Indonesian articles: max 2 from same source, max 2 per topic.
 * Picks the highest-scoring article from each available topic first,
 * then fills remaining slots from best remaining articles.
 */
function diversifyIndonesiaArticles(scored, count, logger) {
    if (scored.length === 0) return [];

    // Sort by score descending
    const sorted = [...scored].sort((a, b) => b._score - a._score);

    const selected = [];
    const usedSources = new Map();   // hostname → count
    const usedTopics = new Map();    // topic → count
    const used = new Set();          // indices

    // Pass 1: pick one best article from each distinct topic
    const topicsSeen = new Set();
    for (let i = 0; i < sorted.length && selected.length < count; i++) {
        const article = sorted[i];
        const topic = classifyTopic(article);
        const hostname = article._hostname || '';

        if (topicsSeen.has(topic)) continue;
        if ((usedSources.get(hostname) || 0) >= MAX_SAME_SOURCE) continue;

        selected.push({ ...article, _topic: topic });
        used.add(i);
        topicsSeen.add(topic);
        usedSources.set(hostname, (usedSources.get(hostname) || 0) + 1);
        usedTopics.set(topic, (usedTopics.get(topic) || 0) + 1);

        logger?.info({ title: article.title, topic, score: article._score }, 'Diversify: picked topic leader');
    }

    // Pass 2: fill remaining slots from best remaining articles
    for (let i = 0; i < sorted.length && selected.length < count; i++) {
        if (used.has(i)) continue;

        const article = sorted[i];
        const topic = classifyTopic(article);
        const hostname = article._hostname || '';

        if ((usedSources.get(hostname) || 0) >= MAX_SAME_SOURCE) {
            logger?.info({ title: article.title, hostname }, 'Diversify: source limit reached');
            continue;
        }
        if ((usedTopics.get(topic) || 0) >= 2) {
            logger?.info({ title: article.title, topic }, 'Diversify: topic limit reached');
            continue;
        }

        selected.push({ ...article, _topic: topic });
        used.add(i);
        usedSources.set(hostname, (usedSources.get(hostname) || 0) + 1);
        usedTopics.set(topic, (usedTopics.get(topic) || 0) + 1);
    }

    logger?.info({
        selected: selected.length,
        topics: [...new Set(selected.map(a => a._topic))],
        sources: [...new Set(selected.map(a => a._hostname))],
    }, 'Diversification complete');

    return selected;
}

// ═══════════════════════════════════════════════════════════
// PIPELINE
// ═══════════════════════════════════════════════════════════

async function runIndonesiaPipeline(logger, maxResults = MAX_ID_ARTICLES) {
    // 1. Fetch
    let articles = await fetchIndonesiaNews(logger);
    if (articles.length === 0) {
        logger?.warn('[Indonesia] Pipeline: no articles from fetch');
        return [];
    }
    logger?.info({ count: articles.length }, '[Indonesia] Pipeline: fetched');

    // 2. Filter: individual articles only
    articles = articles.filter(a => {
        if (!isLikelyIndividualArticle(a)) {
            logger?.info({ title: a.title, url: a.url, type: 'indonesia' }, 'Rejected: generic_page');
            return false;
        }
        return true;
    });
    logger?.info({ count: articles.length }, '[Indonesia] Pipeline: after individual-article filter');

    // 3. Filter: must have clear news event
    articles = articles.filter(a => {
        if (!hasClearNewsEvent(a)) {
            logger?.info({ title: a.title, url: a.url, type: 'indonesia' }, 'Rejected: insufficient_article_context');
            return false;
        }
        return true;
    });
    logger?.info({ count: articles.length }, '[Indonesia] Pipeline: after news-event filter');

    // 4. Filter: freshness
    const fresh = [];
    const unknownAge = [];
    for (const a of articles) {
        const hours = parsePageAgeHours(a.pageAge);
        if (hours === null) {
            unknownAge.push(a);
        } else if (hours <= MAX_PAGE_AGE_HOURS) {
            fresh.push(a);
        } else {
            logger?.info({ title: a.title, pageAge: a.pageAge, type: 'indonesia' }, 'Rejected: stale');
        }
    }
    articles = [...fresh, ...unknownAge];
    logger?.info({ fresh: fresh.length, unknown: unknownAge.length }, '[Indonesia] Pipeline: after freshness');

    if (articles.length === 0) return [];

    // 5. Score
    for (const a of articles) {
        a._score = scoreIndonesiaArticle(a);
    }
    // Filter out low-scoring articles (likely sports routine, local crime, etc.)
    articles = articles.filter(a => {
        if (a._score < 0) {
            logger?.info({
                title: a.title, url: a.url, source: a.source,
                type: 'indonesia', importanceScore: a._score,
            }, 'Rejected: local_low_impact');
            return false;
        }
        return true;
    });
    logger?.info({ count: articles.length }, '[Indonesia] Pipeline: after scoring filter');

    // 6. Dedup
    articles = deduplicateArticles(articles, logger);
    logger?.info({ count: articles.length }, '[Indonesia] Pipeline: after dedup');

    // 7. URL verification (top 20 by score)
    const sorted = articles.sort((a, b) => b._score - a._score);
    const toVerify = sorted.slice(0, 20);

    const verificationResults = await Promise.all(toVerify.map(async (a) => {
        const result = await verifyArticleUrl(a.url, logger);
        logger?.info({
            rawTitle: a.title, rawUrl: a.url, rawSource: a.source,
            pageAge: a.pageAge, verifiedStatus: result.status,
            verifiedFinalUrl: result.finalUrl, accepted: result.valid,
        }, result.valid ? 'URL OK' : `URL FAILED: ${result.error || result.status}`);
        return { article: a, ...result };
    }));

    let verified = verificationResults
        .filter(r => r.valid)
        .map(r => r.article);

    logger?.info({ count: verified.length }, '[Indonesia] Pipeline: after URL verification');

    // 8. Diversify and pick top N
    const diversified = diversifyIndonesiaArticles(verified, maxResults, logger);

    // 9. Translate / build Indonesian summaries
    const final = diversified.map(a => ({
        ...a,
        type: 'indonesia',
        importanceScore: a._score || 0,
        qualityScore: Math.min(10, Math.round((a._score || 0) * 0.6)),
        displayTitle: a.title, // Indonesian articles are already in Indonesian
        displaySummary: buildIndonesianSummary(a),
    }));

    return final;
}

async function runWorldPipeline(logger, maxResults = MAX_WORLD_ARTICLES) {
    // 1. Fetch
    let articles = await fetchWorldNews(logger);
    if (articles.length === 0) {
        logger?.warn('[World] Pipeline: no articles from fetch');
        return [];
    }
    logger?.info({ count: articles.length }, '[World] Pipeline: fetched');

    // 2. Filter: individual articles
    articles = articles.filter(a => {
        if (!isLikelyIndividualArticle(a)) {
            logger?.info({ title: a.title, url: a.url, type: 'world' }, 'Rejected: generic_page');
            return false;
        }
        return true;
    });

    // 3. Filter: clear news event
    articles = articles.filter(a => {
        if (!hasClearNewsEvent(a)) {
            logger?.info({ title: a.title, url: a.url, type: 'world' }, 'Rejected: insufficient_article_context');
            return false;
        }
        return true;
    });
    logger?.info({ count: articles.length }, '[World] Pipeline: after quality filter');

    // 4. Freshness
    const fresh = [];
    const unknownAge = [];
    for (const a of articles) {
        const hours = parsePageAgeHours(a.pageAge);
        if (hours === null) {
            unknownAge.push(a);
        } else if (hours <= MAX_PAGE_AGE_HOURS) {
            fresh.push(a);
        } else {
            logger?.info({ title: a.title, pageAge: a.pageAge, type: 'world' }, 'Rejected: stale');
        }
    }
    articles = [...fresh, ...unknownAge];
    logger?.info({ fresh: fresh.length, unknown: unknownAge.length }, '[World] Pipeline: after freshness');

    if (articles.length === 0) return [];

    // 5. Score
    for (const a of articles) {
        a._score = scoreWorldArticle(a);
    }
    articles = articles.filter(a => {
        if (a._score < 5) {
            logger?.info({
                title: a.title, url: a.url, source: a.source,
                type: 'world', importanceScore: a._score,
            }, 'Rejected: local_low_impact');
            return false;
        }
        return true;
    });
    logger?.info({ count: articles.length }, '[World] Pipeline: after scoring filter');

    if (articles.length === 0) return [];

    // 6. Dedup
    articles = deduplicateArticles(articles, logger);

    // 7. Sort by score, pick top 10 to verify
    const sorted = articles.sort((a, b) => b._score - a._score);
    const toVerify = sorted.slice(0, 10);

    const verificationResults = await Promise.all(toVerify.map(async (a) => {
        const result = await verifyArticleUrl(a.url, logger);
        logger?.info({
            rawTitle: a.title, rawUrl: a.url, rawSource: a.source,
            pageAge: a.pageAge, verifiedStatus: result.status,
            verifiedFinalUrl: result.finalUrl, accepted: result.valid,
        }, result.valid ? 'URL OK' : `URL FAILED: ${result.error || result.status}`);
        return { article: a, ...result };
    }));

    let verified = verificationResults
        .filter(r => r.valid)
        .map(r => r.article);

    logger?.info({ count: verified.length }, '[World] Pipeline: after URL verification');

    const best = verified.slice(0, maxResults).map(a => ({
        ...a,
        type: 'world',
        importanceScore: a._score || 0,
        qualityScore: Math.min(10, Math.round((a._score || 0) * 0.5)),
        displayTitle: a.title,
        displaySummary: buildIndonesianSummary(a),
    }));

    return best;
}

// ═══════════════════════════════════════════════════════════
// FORMATTING
// ═══════════════════════════════════════════════════════════

function formatNewsArticle(article, index) {
    const title = article.displayTitle || article.title || 'Tanpa judul';
    const summary = article.summary || article.displaySummary || article.description || 'Tidak ada ringkasan.';
    const source = article.source || 'Sumber tidak diketahui';
    const url = article.url || article._rawUrl;

    return [
        `*${index}. ${title}*`,
        summary,
        `📰 ${source}`,
        url ? `🔗 ${url}` : '⚠️ Link artikel tidak tersedia',
    ].join('\n');
}

function formatNewsMessage(articles, slot) {
    const def = SLOTS[slot] || SLOTS.morning;
    const dateStr = new Date().toLocaleDateString('id-ID', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const greeting = def.greetings[Math.floor(Math.random() * def.greetings.length)];

    const lines = [
        `${def.emoji} *${def.title}* ${def.emoji}`,
        `📅 ${dateStr}`,
        '',
        greeting,
        '',
    ];

    // Split articles by type
    const indonesiaArticles = articles.filter(a => a.type === 'indonesia');
    const worldArticles = articles.filter(a => a.type === 'world');

    // ── Indonesia section ──
    if (indonesiaArticles.length > 0) {
        lines.push('🇮🇩 *INDONESIA*');
        lines.push('');
        indonesiaArticles.forEach((a, i) => {
            lines.push(formatNewsArticle(a, i + 1));
            lines.push('');
        });
    }

    // ── World section ──
    if (worldArticles.length > 0) {
        lines.push('🌍 *MANCANEGARA*');
        lines.push('');
        worldArticles.forEach((a, i) => {
            lines.push(formatNewsArticle(a, indonesiaArticles.length + i + 1));
            lines.push('');
        });
    }

    // ── Note if articles were skipped ──
    const total = indonesiaArticles.length + worldArticles.length;
    if (total < MAX_ID_ARTICLES + MAX_WORLD_ARTICLES) {
        lines.push('_ℹ️ Beberapa berita tidak ditampilkan karena tidak memenuhi standar relevansi dan validasi sumber._');
        lines.push('');
    }

    lines.push(`_Powered by You.com • Disusun Groq AI • Jam ${new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' })} WIB_`);

    const fullText = lines.join('\n');

    // Split if too long (rare with 5 articles)
    if (fullText.length <= 4000) return [fullText];

    // Multi-message fallback — split at section boundaries
    const idSectionEnd = lines.indexOf('🌍 *MANCANEGARA*');
    if (idSectionEnd > 0) {
        const idMsg = lines.slice(0, idSectionEnd).join('\n');
        const worldMsg = lines.slice(idSectionEnd).join('\n');
        return [idMsg, worldMsg].filter(m => m.trim());
    }

    return [fullText];
}

// ═══════════════════════════════════════════════════════════
// CANDIDATE GATHERING (for Groq editor)
// ═══════════════════════════════════════════════════════════

async function getNewsCandidates(logger) {
    const [indonesiaArticles, worldArticles] = await Promise.all([
        runIndonesiaPipeline(logger, MAX_ID_CANDIDATES),
        runWorldPipeline(logger, MAX_WORLD_CANDIDATES),
    ]);

    const candidates = [...indonesiaArticles, ...worldArticles];

    logger?.info({
        indonesia: indonesiaArticles.length,
        world: worldArticles.length,
        total: candidates.length,
    }, `News candidates: ${indonesiaArticles.length} ID + ${worldArticles.length} world = ${candidates.length} total`);

    return candidates;
}

// ═══════════════════════════════════════════════════════════
// IDEMPOTENCY
// ═══════════════════════════════════════════════════════════

function getSlotGenerationKey(groupJid, dateJakarta, slot) {
    return `${groupJid}:${dateJakarta}:${slot}`;
}

function markSlotGenerated(generationKey) {
    _slotStatus.set(generationKey, { status: 'generated', timestamp: Date.now() });
}

function markSlotSent(generationKey) {
    _slotStatus.set(generationKey, { status: 'sent', timestamp: Date.now() });
}

function markSlotFailed(generationKey) {
    _slotStatus.set(generationKey, { status: 'failed', timestamp: Date.now() });
}

function isSlotProcessed(generationKey) {
    const entry = _slotStatus.get(generationKey);
    if (!entry) return false;
    return entry.status === 'generated' || entry.status === 'sent';
}

// ═══════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════

async function getNewsBySlot(slot, options = {}) {
    const { logger, groupJid, dateJakarta } = options;

    if (!SLOTS[slot]) {
        logger?.warn(`Unknown news slot: ${slot}`);
        return null;
    }

    const jid = groupJid || process.env.GROUP_JID || '';
    const dateStr = dateJakarta || new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });
    const generationKey = getSlotGenerationKey(jid, dateStr, slot);

    // Idempotency check — don't process the same slot twice
    if (isSlotProcessed(generationKey)) {
        logger?.info({ slot, generationKey }, 'Slot already processed — skipping');
        return null;
    }

    // 1. Gather candidates through existing code filters
    const candidates = await getNewsCandidates(logger);

    if (candidates.length === 0) {
        logger?.warn(`[${slot}] No candidates from pipelines`);
        markSlotFailed(generationKey);
        return null;
    }

    // 2. Run Groq AI Editor
    const currentDateJakarta = new Date().toLocaleDateString('id-ID', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        timeZone: 'Asia/Jakarta',
    });

    const editorResult = await editNewsWithGroq({
        candidates,
        slot,
        currentDateJakarta,
        logger,
    });

    const finalArticles = editorResult.articles;

    logger?.info({
        slot,
        editorMode: editorResult.editorMode,
        keySlot: editorResult.keySlot,
        total: finalArticles.length,
        indonesia: finalArticles.filter(a => a.type === 'indonesia').length,
        world: finalArticles.filter(a => a.type === 'world').length,
    }, `News editor complete: ${finalArticles.length} articles (mode: ${editorResult.editorMode})`);

    // 3. Mark as generated (not sent yet — that happens after WhatsApp send)
    markSlotGenerated(generationKey);

    if (finalArticles.length === 0) {
        return null;
    }

    // 4. Format for WhatsApp
    const messages = formatNewsMessage(finalArticles, slot);

    return { messages, generationKey };
}

async function confirmNewsSent(generationKey) {
    if (generationKey) {
        markSlotSent(generationKey);
    }
}

/**
 * Get legacy-style messages array for backward compatibility.
 * Used by handler.js manual !news command and scheduler.
 */
async function getNewsMessages(slot, options = {}) {
    const result = await getNewsBySlot(slot, options);
    if (!result) return null;
    return result.messages || null;
}

async function getMorningNews(options = {}) {
    return getNewsBySlot('morning', options);
}

function getSlots() {
    return SLOTS;
}

module.exports = {
    getNewsBySlot,
    getNewsMessages,
    getMorningNews,
    getSlots,
    getNewsCandidates,
    confirmNewsSent,
    normalizeNewsUrl,
    containsValidClickableUrl,
    isValidArticleUrl,
    isLikelyIndividualArticle,
    isUninformativeDescription,
    hasClearNewsEvent,
    scoreIndonesiaArticle,
    scoreWorldArticle,
    classifyTopic,
    diversifyIndonesiaArticles,
    buildIndonesianSummary,
    formatNewsArticle,
    formatNewsMessage,
};
