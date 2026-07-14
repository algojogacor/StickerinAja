// Reddit Sticker Discovery — uses You.com Web Search to find popular Reddit posts.
// No Reddit OAuth required. Results are normalized into a minimal structure that
// redditMediaResolver.js can consume.

const { parseRedditPostUrl } = require("../utils/redditUrlParser");

// ── Config ──────────────────────────────────────────────────

const YDC_API_KEY = () => process.env.YDC_API_KEY || "";
const WEB_SEARCH_URL = "https://ydc-index.io/v1/search";
const TIMEOUT_MS = 25000;

const DISCOVERY_QUERIES = () => {
  const custom = process.env.REDDIT_DISCOVERY_QUERIES;
  if (custom) {
    try {
      return JSON.parse(custom);
    } catch {
      // fall through to defaults
    }
  }
  return [
    "site:reddit.com/r/memes/comments popular meme today",
    "site:reddit.com/r/me_irl/comments top meme today",
    "site:reddit.com/r/wholesomememes/comments popular post today",
    "site:reddit.com/r/funny/comments funny image gif today",
    "site:reddit.com/r/ProgrammerHumor/comments popular programming meme today",
    "site:reddit.com/r/gifs/comments popular gif today",
  ];
};

const SEARCH_SUBREDDITS = () =>
  (process.env.REDDIT_SEARCH_SUBREDDITS || "memes,me_irl,wholesomememes,funny,gifs,ProgrammerHumor")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const FRESHNESS = () => process.env.REDDIT_SEARCH_FRESHNESS || "day";
const FALLBACK_FRESHNESS = () => process.env.REDDIT_SEARCH_FALLBACK_FRESHNESS || "week";
const RESULTS_PER_QUERY = () =>
  parseInt(process.env.REDDIT_SEARCH_RESULTS_PER_QUERY || "10", 10);
const MAX_QUERIES = () =>
  parseInt(process.env.REDDIT_SEARCH_MAX_QUERIES || "6", 10);

// ── Helpers ─────────────────────────────────────────────────

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

/**
 * Normalize a You.com search result into a minimal Reddit-post-like object
 * that redditMediaResolver.js can consume.
 *
 * This is the ADAPTER between You.com raw results and the existing resolver.
 * We do NOT fake missing Reddit metadata — we only populate what we actually have.
 */
function normalizeSearchResult(raw, searchIndex) {
  const url = raw.url || "";
  const parsed = parseRedditPostUrl(url);
  if (!parsed) return null;

  // Estimate age from You.com page_age string if available
  let createdUtc = 0;
  if (raw.page_age) {
    const hoursMatch = String(raw.page_age).match(/(\d+)\s*(hours?|h)\s*ago/i);
    const daysMatch = String(raw.page_age).match(/(\d+)\s*(days?|d)\s*ago/i);
    const minsMatch = String(raw.page_age).match(/(\d+)\s*(minutes?|min|m)\s*ago/i);
    if (hoursMatch) {
      createdUtc = Math.floor(Date.now() / 1000) - parseInt(hoursMatch[1], 10) * 3600;
    } else if (daysMatch) {
      createdUtc = Math.floor(Date.now() / 1000) - parseInt(daysMatch[1], 10) * 86400;
    } else if (minsMatch) {
      createdUtc = Math.floor(Date.now() / 1000) - parseInt(minsMatch[1], 10) * 60;
    } else {
      // Unknown age — treat as recent
      createdUtc = Math.floor(Date.now() / 1000) - 3600;
    }
  } else {
    createdUtc = Math.floor(Date.now() / 1000) - 3600;
  }

  // Build thumbnail from search result if available
  const thumbnail = raw.thumbnail || raw.image || raw.favicon || "";

  // Build a minimal preview structure for the resolver
  const title = (raw.title || "").trim();
  const description = (raw.description || raw.snippet || "").trim();

  // The resolver needs certain fields. We provide what we have:
  return {
    // ── Core identity ──
    id: parsed.postId,
    subreddit: parsed.subreddit || "",
    subreddit_name_prefixed: parsed.subreddit ? `r/${parsed.subreddit}` : "",
    permalink: parsed.permalink,
    title,
    author: raw.author || "",
    url: url,

    // ── Metadata from search ──
    created_utc: createdUtc,
    score: 0,            // You.com doesn't provide upvotes — don't fake it
    num_comments: 0,     // You.com doesn't provide comment count
    upvote_ratio: 0,

    // ── Flags (conservative defaults) ──
    over_18: false,
    spoiler: false,
    is_self: false,
    is_video: false,
    is_gif: false,
    stickied: false,
    removed_by_category: null,
    post_hint: null,

    // ── Media placeholders (resolver will try to populate these) ──
    thumbnail: thumbnail || "image",  // "image" tells resolver to try harder
    url_overridden_by_dest: url,
    preview: thumbnail ? {
      images: [{ source: { url: thumbnail, width: 512, height: 512 }, resolutions: [] }],
    } : null,
    media: null,
    secure_media: null,
    media_metadata: null,
    gallery_data: null,
    crosspost_parent_list: [],

    // ── Discovery metadata (not from Reddit OAuth) ──
    _source: "you.com",
    _searchIndex: searchIndex,
    _searchTitle: title,
    _searchDescription: description,
    _searchThumbnailUrl: thumbnail || null,
    _publishedAt: raw.page_age || null,
  };
}

// ── Fetch ───────────────────────────────────────────────────

/**
 * Execute one You.com search query and return normalized Reddit candidates.
 */
async function searchReddit(query, { logger, freshness, count } = {}) {
  const apiKey = YDC_API_KEY();
  if (!apiKey) {
    logger?.warn("YDC_API_KEY not set — Reddit discovery disabled");
    return [];
  }

  const params = new URLSearchParams({
    query,
    freshness: freshness || FRESHNESS(),
    count: String(count || RESULTS_PER_QUERY()),
    safesearch: "strict",
  });

  const searchUrl = `${WEB_SEARCH_URL}?${params.toString()}`;

  try {
    const res = await fetchWithTimeout(
      searchUrl,
      {
        method: "GET",
        headers: {
          "X-API-Key": apiKey,
          Accept: "application/json",
        },
      },
      TIMEOUT_MS
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger?.warn(
        { status: res.status, body: body.slice(0, 200) },
        "[Reddit Discovery] You.com API error"
      );
      return [];
    }

    const data = await res.json();

    // Support both results.news and results.web formats
    const rawResults = data?.results?.news || data?.results?.web || data?.hits || [];

    if (!Array.isArray(rawResults) || rawResults.length === 0) {
      logger?.info("[Reddit Discovery] No search results");
      return [];
    }

    logger?.info(
      { query: query.slice(0, 60), rawCount: rawResults.length },
      `[Reddit Discovery] ${rawResults.length} raw results`
    );

    // Normalize and filter
    const candidates = rawResults
      .map((raw, i) => normalizeSearchResult(raw, i))
      .filter(Boolean);

    return candidates;
  } catch (err) {
    logger?.warn(
      { err: String(err.message).slice(0, 100) },
      "[Reddit Discovery] Search exception"
    );
    return [];
  }
}

// ── Public API ──────────────────────────────────────────────

/**
 * Discover trending Reddit posts via You.com Web Search.
 * Used by the cron generator.
 *
 * @param {object} options
 * @param {object} options.logger
 * @returns {Promise<Array>} Normalized Reddit post candidates
 */
async function discoverTrendingPosts({ logger } = {}) {
  const queries = DISCOVERY_QUERIES().slice(0, MAX_QUERIES());
  const freshness = FRESHNESS();

  logger?.info(
    { queryCount: queries.length, freshness },
    "[Reddit Discovery] Starting trending discovery"
  );

  // Run queries concurrently (limited by MAX_QUERIES)
  const allResults = await Promise.allSettled(
    queries.map((q) =>
      searchReddit(q, { logger, freshness })
    )
  );

  // Collect, deduplicate by post ID
  const seen = new Set();
  const candidates = [];

  for (const result of allResults) {
    if (result.status !== "fulfilled") continue;
    for (const candidate of result.value) {
      if (!seen.has(candidate.id)) {
        seen.add(candidate.id);
        candidates.push(candidate);
      }
    }
  }

  logger?.info(
    { total: candidates.length, queries: queries.length },
    `[Reddit Discovery] ${candidates.length} unique Reddit posts found`
  );

  // If too few results, try fallback freshness
  if (candidates.length < 3 && freshness !== FALLBACK_FRESHNESS()) {
    logger?.info(
      { fallbackFreshness: FALLBACK_FRESHNESS() },
      "[Reddit Discovery] Low results — trying fallback freshness"
    );

    const fallbackResults = await Promise.allSettled(
      queries.slice(0, 3).map((q) =>
        searchReddit(q, { logger, freshness: FALLBACK_FRESHNESS() })
      )
    );

    for (const result of fallbackResults) {
      if (result.status !== "fulfilled") continue;
      for (const candidate of result.value) {
        if (!seen.has(candidate.id)) {
          seen.add(candidate.id);
          candidates.push(candidate);
        }
      }
    }

    logger?.info(
      { total: candidates.length },
      `[Reddit Discovery] After fallback: ${candidates.length} posts`
    );
  }

  return candidates;
}

/**
 * Search Reddit for a specific keyword via You.com.
 * Used by the manual keyword command.
 *
 * @param {string} keyword - User-provided search keyword
 * @param {object} options
 * @param {object} options.logger
 * @returns {Promise<Array>} Normalized Reddit post candidates
 */
async function discoverByKeyword(keyword, { logger } = {}) {
  const sanitized = String(keyword || "")
    .replace(/[\x00-\x1f]/g, "")
    .trim()
    .slice(0, 100);

  if (!sanitized) {
    return [];
  }

  const subreddits = SEARCH_SUBREDDITS();
  const subredditConstraint = subreddits
    .map((s) => `site:reddit.com/r/${s}/comments`)
    .join(" OR ");

  const query = `(${subredditConstraint}) "${sanitized}" meme`;

  logger?.info(
    { keyword: sanitized, query: query.slice(0, 100) },
    "[Reddit Discovery] Keyword search"
  );

  return searchReddit(query, { logger, freshness: FALLBACK_FRESHNESS(), count: 15 });
}

/**
 * Lightweight Reddit page metadata fetch — ONE attempt, no auth, no cookies.
 * Only called for URL import where we have a post URL but need OG metadata.
 *
 * On 401/403/429: returns null immediately, no retry.
 *
 * @param {string} redditUrl - Full Reddit post URL
 * @returns {Promise<object|null>} OG metadata or null
 */
async function fetchRedditPageMetadata(redditUrl) {
  const parsed = parseRedditPostUrl(redditUrl);
  if (!parsed) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000); // 8s timeout

  try {
    const res = await fetch(parsed.normalizedUrl, {
      method: "GET",
      headers: {
        "User-Agent": "StickerinBot/1.0 (Koyeb; compatible; Reddit public metadata fetch)",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    if (!res.ok) {
      // 401, 403, 429 → unavailable, don't retry
      if ([401, 403, 429].includes(res.status)) {
        return { available: false, reason: `reddit_page_unavailable_${res.status}` };
      }
      return null;
    }

    const html = await res.text();

    // Extract OG metadata with simple regex (no HTML parser needed)
    const ogImage = extractMetaTag(html, "og:image");
    const ogVideo = extractMetaTag(html, "og:video");
    const ogTitle = extractMetaTag(html, "og:title");
    const ogDescription = extractMetaTag(html, "og:description");
    const twitterImage = extractMetaTag(html, "twitter:image");
    const twitterPlayerStream = extractMetaTag(html, "twitter:player:stream");

    return {
      available: true,
      ogImage: ogImage || twitterImage || null,
      ogVideo: ogVideo || twitterPlayerStream || null,
      ogTitle: ogTitle || null,
      ogDescription: ogDescription || null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractMetaTag(html, property) {
  // Match both property="og:image" and name="twitter:image" patterns
  const patterns = [
    new RegExp(`<meta\\s[^>]*property=["']${escapeRegex(property)}["'][^>]*content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta\\s[^>]*name=["']${escapeRegex(property)}["'][^>]*content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta\\s[^>]*content=["']([^"']+)["'][^>]*property=["']${escapeRegex(property)}["']`, "i"),
    new RegExp(`<meta\\s[^>]*content=["']([^"']+)["'][^>]*name=["']${escapeRegex(property)}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  discoverTrendingPosts,
  discoverByKeyword,
  fetchRedditPageMetadata,
  normalizeSearchResult,
  searchReddit,
  DISCOVERY_QUERIES,
};
