// FX Market Context Service — economic news for USD/IDR reports.
// Searches You.com every 3 hours, summarizes via shared Groq editor.
// Reuses You.com search pattern from newsService.js (NOT a second client).

const { summarizeFxMarketContext } = require("./groqNewsEditor");

// ── Configuration ─────────────────────────────────────────

const YDC_API_KEY = () => process.env.YDC_API_KEY || "";
const WEB_SEARCH_URL = "https://ydc-index.io/v1/search";
const TIMEOUT_MS = 25000;

function getConfig() {
  return {
    maxArticles: parseInt(process.env.FX_MARKET_CONTEXT_MAX_ARTICLES || "3", 10),
    maxAgeHours: parseInt(process.env.FX_MARKET_CONTEXT_MAX_AGE_HOURS || "12", 10),
    refreshHours: parseInt(process.env.FX_MARKET_CONTEXT_REFRESH_HOURS || "3", 10),
  };
}

// ── Authoritative Source Preferences ──────────────────────

const AUTHORITATIVE_SOURCES = [
  "reuters.com",
  "bloomberg.com",
  "cnbc.com",
  "bisnis.com",
  "kontan.co.id",
  "cnbcindonesia.com",
  "antaranews.com",
  "kompas.com",
  "tempo.co",
  "cnnindonesia.com",
  "thejakartapost.com",
  "katadata.co.id",
];

const FINANCE_KEYWORDS = [
  "rupiah", "dollar", "USD", "IDR", "kurs", "exchange rate",
  "bank indonesia", "federal reserve", "suku bunga", "interest rate",
  "moneter", "monetary", "inflasi", "inflation", "nilai tukar",
  "the fed", "bi rate", "currency", "forex",
];

// ── Helpers ───────────────────────────────────────────────

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

function normalizeUrl(rawUrl) {
  if (typeof rawUrl !== "string") return null;
  const cleaned = rawUrl.trim();
  try {
    const parsed = new URL(cleaned);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function isValidArticleUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.replace(/^www\./, "");
    const pathname = url.pathname.replace(/\/+$/, "").toLowerCase();

    // Exclude non-article domains
    const excluded = [
      "youtube.com", "instagram.com", "tiktok.com", "facebook.com",
      "x.com", "twitter.com", "reddit.com", "wikipedia.org",
    ];
    if (excluded.some((d) => hostname === d || hostname.endsWith("." + d))) {
      return false;
    }

    // Exclude section pages
    const sectionPaths = [
      "/news", "/money", "/sports", "/weather", "/local",
      "/latest", "/live", "/video", "/photos", "/podcasts",
    ];
    if (sectionPaths.includes(pathname) || pathname === "" || pathname === "/") {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function parsePageAgeHours(pageAge) {
  if (!pageAge || typeof pageAge !== "string") return null;
  const str = pageAge.toLowerCase().trim();

  const hoursMatch = str.match(/(\d+)\s*hours?\s*ago/);
  if (hoursMatch) return parseInt(hoursMatch[1], 10);

  const hMatch = str.match(/(\d+)\s*h\s*ago/);
  if (hMatch) return parseInt(hMatch[1], 10);

  const daysMatch = str.match(/(\d+)\s*days?\s*ago/);
  if (daysMatch) return parseInt(daysMatch[1], 10) * 24;

  const minsMatch = str.match(/(\d+)\s*minutes?\s*ago/);
  if (minsMatch) return 0;

  if (/weeks?\s*ago|months?\s*ago/i.test(str)) return 9999;

  return null;
}

function isFinanceRelevant(article) {
  const text = `${article.title || ""} ${article.description || ""}`.toLowerCase();
  // Must contain at least one finance keyword
  return FINANCE_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));
}

function sourceAuthorityScore(hostname) {
  const idx = AUTHORITATIVE_SOURCES.findIndex(
    (s) => hostname === s || hostname.endsWith("." + s)
  );
  if (idx >= 0) return AUTHORITATIVE_SOURCES.length - idx; // Higher = better
  return 0;
}

function generateArticleId(article, index) {
  const crypto = require("crypto");
  const raw = `${article.source || "unknown"}:${article.title || "untitled"}:${index}`;
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
}

// ── You.com Search ────────────────────────────────────────

async function searchEconomicNews(query, logger) {
  const apiKey = YDC_API_KEY();
  if (!apiKey) {
    logger?.warn("[FX Context] YDC_API_KEY not set");
    return [];
  }

  const params = new URLSearchParams({
    query,
    freshness: "day",
    count: "20",
    safesearch: "strict",
  });

  const url = `${WEB_SEARCH_URL}?${params.toString()}`;

  logger?.info({ query }, "[FX Context] Searching You.com...");

  try {
    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: {
        "X-API-Key": apiKey,
        "Accept": "application/json",
      },
    }, TIMEOUT_MS);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger?.warn(
        { status: response.status, body: body.slice(0, 200) },
        "[FX Context] You.com API error"
      );
      return [];
    }

    const data = await response.json();
    const rawArticles = data?.results?.news || data?.news || [];

    if (!Array.isArray(rawArticles) || rawArticles.length === 0) {
      logger?.warn("[FX Context] No news results from You.com");
      return [];
    }

    logger?.info({ count: rawArticles.length }, `[FX Context] ${rawArticles.length} raw results`);

    return rawArticles;
  } catch (err) {
    logger?.warn({ err: err.message }, "[FX Context] You.com search exception");
    return [];
  }
}

// ── Article Processing Pipeline ───────────────────────────

function processArticles(rawArticles, logger) {
  const config = getConfig();

  // Build structured articles
  let articles = rawArticles
    .map((raw, i) => {
      const url = normalizeUrl(raw.url);
      if (!url || !isValidArticleUrl(url)) return null;

      let hostname = "";
      try {
        hostname = new URL(url).hostname.replace(/^www\./, "");
      } catch {}

      return {
        _index: i,
        title: (raw.title || "").trim(),
        description: (raw.description || raw.snippet || "").trim(),
        url,
        source: raw.source || hostname || "",
        _hostname: hostname,
        pageAge: raw.page_age || raw.pageAge || null,
      };
    })
    .filter(Boolean);

  logger?.info({ count: articles.length }, "[FX Context] After URL validation");

  // Filter: finance relevance
  articles = articles.filter((a) => {
    if (!isFinanceRelevant(a)) {
      return false;
    }
    return true;
  });

  logger?.info({ count: articles.length }, "[FX Context] After finance relevance filter");

  // Filter: freshness
  const fresh = [];
  const unknownAge = [];
  for (const a of articles) {
    const hours = parsePageAgeHours(a.pageAge);
    if (hours === null) {
      unknownAge.push(a);
    } else if (hours <= config.maxAgeHours) {
      fresh.push(a);
    }
  }
  articles = [...fresh, ...unknownAge];

  logger?.info(
    { fresh: fresh.length, unknown: unknownAge.length },
    "[FX Context] After freshness filter"
  );

  // Deduplicate by URL
  const seenUrls = new Set();
  const deduped = [];
  for (const a of articles) {
    try {
      const key = new URL(a.url).hostname.replace(/^www\./, "") +
        new URL(a.url).pathname.replace(/\/+$/, "");
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      deduped.push(a);
    } catch {
      deduped.push(a);
    }
  }

  // Rank: authority score + explicit relevance
  const scored = deduped.map((a) => {
    const authorityScore = sourceAuthorityScore(a._hostname);
    const text = `${a.title} ${a.description}`.toLowerCase();
    const keywordMatches = FINANCE_KEYWORDS.filter((kw) =>
      text.includes(kw.toLowerCase())
    ).length;
    a._score = authorityScore + keywordMatches * 2;
    return a;
  });

  scored.sort((a, b) => b._score - a._score);

  // Select top N
  const selected = scored.slice(0, config.maxArticles);

  // Add IDs
  const withIds = selected.map((a, i) => ({
    ...a,
    id: generateArticleId(a, i),
  }));

  return withIds;
}

// ── Public API ────────────────────────────────────────────

/**
 * Refresh the market context by searching You.com and calling Groq.
 *
 * @param {Object} options
 * @param {Object} options.logger
 * @param {Object} [options.rateStatistics] - Current rate stats for context
 * @returns {Object} { status: 'ready'|'partial'|'failed', contextId, generatedAt, validUntil, articles, narrative }
 */
async function refreshContext({ logger, rateStatistics }) {
  const config = getConfig();

  // 1. Primary You.com query
  const primaryQuery =
    "USD IDR rupiah dollar Bank Indonesia Federal Reserve latest";

  let rawArticles = await searchEconomicNews(primaryQuery, logger);

  // 2. Fallback query if primary yields insufficient results
  if (rawArticles.length < 5) {
    logger?.info("[FX Context] Primary query insufficient — trying fallback");
    const fallbackQuery =
      "rupiah exchange rate Indonesia monetary policy latest";
    const fallbackResults = await searchEconomicNews(fallbackQuery, logger);
    // Merge and deduplicate by URL
    const seenUrls = new Set();
    rawArticles = [...rawArticles, ...fallbackResults].filter((a) => {
      const url = normalizeUrl(a.url);
      if (!url || seenUrls.has(url)) return false;
      seenUrls.add(url);
      return true;
    });
  }

  if (rawArticles.length === 0) {
    logger?.warn("[FX Context] No articles from You.com — context refresh failed");
    return {
      status: "failed",
      contextId: null,
      generatedAt: new Date().toISOString(),
      validUntil: null,
      articles: [],
      narrative: "",
    };
  }

  // 3. Process articles through pipeline
  const articles = processArticles(rawArticles, logger);

  if (articles.length === 0) {
    logger?.warn("[FX Context] No articles passed processing pipeline");
    return {
      status: "failed",
      contextId: null,
      generatedAt: new Date().toISOString(),
      validUntil: null,
      articles: [],
      narrative: "",
    };
  }

  // 4. Call Groq for editorial summary
  const groqResult = await summarizeFxMarketContext({
    articles,
    rateStatistics,
    logger,
  });

  const generatedAt = new Date().toISOString();
  const validUntil = new Date(
    Date.now() + config.refreshHours * 60 * 60 * 1000
  ).toISOString();

  if (groqResult.status === "ready" || groqResult.status === "partial") {
    return {
      status: groqResult.status,
      contextId: `fx-ctx-${Date.now()}`,
      generatedAt,
      validUntil,
      articles: groqResult.articles,
      narrative: groqResult.narrative || "",
    };
  }

  // Groq failed entirely — use verified headlines as fallback
  return {
    status: "partial",
    contextId: `fx-ctx-${Date.now()}`,
    generatedAt,
    validUntil,
    articles: articles.slice(0, config.maxArticles).map((a) => ({
      id: a.id,
      headline: a.title,
      url: a.url,
      publisher: a.source || a._hostname,
      summary: (a.description || "").slice(0, 200),
    })),
    narrative: "",
  };
}

// ── Exports ───────────────────────────────────────────────

module.exports = {
  refreshContext,
  searchEconomicNews,   // exported for testing
  processArticles,       // exported for testing
  isFinanceRelevant,     // exported for testing
  AUTHORITATIVE_SOURCES,
  FINANCE_KEYWORDS,
};
