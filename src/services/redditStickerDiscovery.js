// Reddit & Meme Sticker Discovery — uses Meme-API, GIPHY, and You.com Search to find popular memes.
// No Reddit OAuth required. Results are normalized into a standard structure that
// redditMediaResolver.js and the converter can consume.

const { parseRedditPostUrl } = require("../utils/redditUrlParser");
const crypto = require("crypto");

// ── Config ──────────────────────────────────────────────────

const YDC_API_KEY = () => process.env.YDC_API_KEY || "";
const GIPHY_API_KEY = () => process.env.GIPHY_API_KEY || "";
const WEB_SEARCH_URL = "https://ydc-index.io/v1/search";
const TIMEOUT_MS = 25000;

const DISCOVERY_QUERIES = () => {
  const custom = process.env.REDDIT_DISCOVERY_QUERIES;
  if (custom) {
    try {
      const parsed = JSON.parse(custom);
      if (Array.isArray(parsed) && parsed.every((query) => typeof query === "string" && query.trim())) {
        return parsed.map((query) => query.trim());
      }
    } catch {
      // fall through to defaults
    }
  }
  return SEARCH_SUBREDDITS().map((subreddit) =>
    `site:reddit.com/r/${subreddit}/comments`
  );
};

const SEARCH_SUBREDDITS = () =>
  (process.env.REDDIT_SEARCH_SUBREDDITS || "WkwkwkLand,aku_ddn,indonesia,indowibu,shitposting,okbuddyretard,memes,dankmemes,funny,starterpacks,memes_of_the_dank,dank_meme,Funnymemes,meme,wholesomememes,comedyheaven,bonehurtingjuice,BikiniBottomTwitter,animemes,goodanimemes,trippinthroughtime,AdviceAnimals,ProgrammerHumor,me_irl,therewasanattempt,mildlyinfuriating,wordington")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const FRESHNESS = () => process.env.REDDIT_SEARCH_FRESHNESS || "year";
const FALLBACK_FRESHNESS = () => process.env.REDDIT_SEARCH_FALLBACK_FRESHNESS || "";
const RESULTS_PER_QUERY = () =>
  parseInt(process.env.REDDIT_SEARCH_RESULTS_PER_QUERY || "10", 10);
const MAX_QUERIES = () =>
  parseInt(process.env.REDDIT_SEARCH_MAX_QUERIES || "8", 10);

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

// ── Meme-API Integration (100% Free Pure Reddit Memes) ───────

/**
 * Fetch fresh memes from meme-api.com across top meme subreddits.
 */
async function fetchMemeApiPosts({ subreddits = SEARCH_SUBREDDITS(), countPerSubreddit = 3, logger } = {}) {
  const allSubs = Array.isArray(subreddits) ? subreddits : ["dankmemes", "memes", "wholesomememes"];
  // Randomly shuffle to rotate subreddits across scheduled runs
  const shuffled = [...allSubs].sort(() => Math.random() - 0.5);
  const subs = shuffled.slice(0, 8);
  const candidates = [];

  const promises = subs.map(async (sub) => {
    try {
      const url = `https://meme-api.com/gimme/${encodeURIComponent(sub)}/${countPerSubreddit}`;
      const res = await fetchWithTimeout(url, {
        headers: { "User-Agent": "WhatsAppGroupStickerBot/1.0" },
      }, 10000);

      if (!res.ok) return [];
      const data = await res.json();
      const list = Array.isArray(data?.memes) ? data.memes : (data?.url ? [data] : []);

      return list.map((item, idx) => normalizeMemeApiItem(item, sub, idx)).filter(Boolean);
    } catch (err) {
      logger?.warn({ sub, err: String(err.message) }, "[Meme-API] Subreddit fetch error");
      return [];
    }
  });

  const results = await Promise.allSettled(promises);
  for (const r of results) {
    if (r.status === "fulfilled" && Array.isArray(r.value)) {
      candidates.push(...r.value);
    }
  }

  logger?.info({ count: candidates.length }, "[Meme-API] Fetched meme candidates");
  return candidates;
}

function normalizeMemeApiItem(item, subreddit, index) {
  if (!item?.url) return null;
  const postUrl = item.postLink || `https://reddit.com/r/${subreddit}/comments/${item.author || "post"}_${index}`;
  const parsed = parseRedditPostUrl(postUrl);
  const postId = parsed?.postId || item.postLink?.split("/").pop() || crypto.randomUUID().slice(0, 8);

  const mediaUrl = item.url;
  // Reject placeholder or deleted images
  if (/o0h58lzmax6a1|redditstatic|default_preview|subreddit_default/i.test(mediaUrl)) {
    return null;
  }

  return {
    id: postId,
    subreddit: item.subreddit || subreddit,
    subreddit_name_prefixed: `r/${item.subreddit || subreddit}`,
    permalink: parsed?.permalink || `/r/${subreddit}/comments/${postId}`,
    title: (item.title || "Reddit Meme").trim(),
    author: item.author || "",
    url: mediaUrl,
    created_utc: Math.floor(Date.now() / 1000) - 1800,
    score: Number(item.ups) || 100,
    num_comments: 0,
    upvote_ratio: 0.95,
    over_18: Boolean(item.nsfw),
    spoiler: Boolean(item.spoiler),
    is_self: false,
    is_video: false,
    is_gif: /\.gif(?:\?|$)/i.test(mediaUrl),
    stickied: false,
    removed_by_category: null,
    search_result_generic: false,
    post_hint: "image",
    thumbnail: mediaUrl,
    url_overridden_by_dest: mediaUrl,
    preview: {
      images: [{ source: { url: mediaUrl, width: 512, height: 512 }, resolutions: [] }],
    },
    media: null,
    secure_media: null,
    media_metadata: null,
    gallery_data: null,
    crosspost_parent_list: [],
    _source: "meme-api.com",
    _searchIndex: index,
  };
}

// ── GIPHY API Integration (Trending GIFs & Animated Stickers) ──

/**
 * Fetch GIFs or transparent Stickers from GIPHY API.
 */
async function fetchGiphyPosts({
  query,
  limit = 5,
  type = "gifs",
  rating = "g",
  offset,
  randomOffset = false,
  maxRandomOffset = 50,
  logger,
} = {}) {
  const apiKey = GIPHY_API_KEY();
  if (!apiKey) return [];

  const isSearch = Boolean(query && query.trim());
  const endpoint = isSearch ? "search" : "trending";

  let effectiveOffset = 0;
  if (typeof offset === "number" && offset >= 0) {
    effectiveOffset = Math.floor(offset);
  } else if (randomOffset) {
    effectiveOffset = Math.floor(Math.random() * Math.max(1, maxRandomOffset));
  }

  const buildUrl = (off) => {
    const params = new URLSearchParams({
      api_key: apiKey,
      limit: String(limit),
      rating,
    });
    if (isSearch) {
      params.set("q", query.trim());
    }
    if (off > 0) {
      params.set("offset", String(off));
    }
    return `https://api.giphy.com/v1/${type}/${endpoint}?${params.toString()}`;
  };

  try {
    let res = await fetchWithTimeout(buildUrl(effectiveOffset), { headers: { "User-Agent": "WhatsAppGroupStickerBot/1.0" } }, 10000);
    if (!res.ok) {
      logger?.warn({ status: res.status }, "[GIPHY API] Error response");
      return [];
    }

    let data = await res.json();
    let list = Array.isArray(data?.data) ? data.data : [];

    // Fallback to offset 0 if random offset returned no items (e.g. niche query with < offset results)
    if (list.length === 0 && effectiveOffset > 0) {
      res = await fetchWithTimeout(buildUrl(0), { headers: { "User-Agent": "WhatsAppGroupStickerBot/1.0" } }, 10000);
      if (res.ok) {
        data = await res.json();
        list = Array.isArray(data?.data) ? data.data : [];
      }
    }

    return list.map((item, idx) => normalizeGiphyItem(item, type, idx)).filter(Boolean);
  } catch (err) {
    logger?.warn({ err: String(err.message) }, "[GIPHY API] Fetch error");
    return [];
  }
}

function normalizeGiphyItem(item, type, index) {
  if (!item?.id) return null;

  // Prefer original MP4 for animated stickers (highest quality, lowest bytes)
  const mp4Url = item.images?.original_mp4?.mp4 || item.images?.fixed_height?.mp4;
  const webpUrl = item.images?.fixed_height?.webp || item.images?.original?.webp;
  const gifUrl = item.images?.fixed_height?.url || item.images?.original?.url;

  const mediaUrl = mp4Url || webpUrl || gifUrl;
  if (!mediaUrl) return null;

  const id = `giphy_${item.id}`;
  const title = (item.title || "GIPHY Sticker").replace(/\s*GIF\s*by.*$/i, "").trim();

  return {
    id,
    subreddit: "giphy",
    subreddit_name_prefixed: "r/giphy",
    permalink: `/giphy/${item.id}`,
    title: title || "GIPHY Animated Sticker",
    author: item.username || "giphy",
    url: mediaUrl,
    created_utc: Math.floor(Date.now() / 1000) - 3600,
    score: 500,
    num_comments: 0,
    upvote_ratio: 0.99,
    over_18: false,
    spoiler: false,
    is_self: false,
    is_video: true,
    is_gif: !mp4Url,
    stickied: false,
    removed_by_category: null,
    search_result_generic: false,
    post_hint: "video",
    thumbnail: webpUrl || gifUrl || mediaUrl,
    url_overridden_by_dest: mediaUrl,
    preview: {
      images: [{ source: { url: webpUrl || gifUrl || mediaUrl, width: 512, height: 512 }, resolutions: [] }],
    },
    media: {
      reddit_video: {
        fallback_url: mediaUrl,
        duration: 5,
      },
    },
    secure_media: null,
    media_metadata: null,
    gallery_data: null,
    crosspost_parent_list: [],
    _source: "giphy",
    _giphyType: type,
    _searchIndex: index,
  };
}

// ── You.com Search Fallback & Helper Functions ──────────────

function normalizeSearchResult(raw, searchIndex) {
  const url = raw.url || "";
  const parsed = parseRedditPostUrl(url);
  if (!parsed) return null;

  let createdUtc = Math.floor(Date.now() / 1000) - 3600;
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
    }
  }

  const rawThumbnail = raw.thumbnail_url || raw.thumbnail?.src || raw.thumbnail || raw.image || "";
  const thumbnail = isUsableMediaThumbnail(rawThumbnail) ? rawThumbnail : "";
  const mediaHint = getDirectMediaHint(raw.video_url || raw.media_url || raw.content_url || raw.image_url);
  const videoHint = isVideoMediaHint(mediaHint);

  let title = (raw.title || "").trim();
  const description = (raw.description || raw.snippet || (Array.isArray(raw.snippets) ? raw.snippets.join(" ") : "") || "").trim();
  const author = raw.author || (Array.isArray(raw.authors) ? raw.authors[0] : "") || "";

  if (isGenericSearchTitle(title) && thumbnail) {
    const derivedTitle = deriveTitleFromUrl(url);
    if (derivedTitle) title = derivedTitle;
  }
  const removedMarker = /\[\s*(?:removed(?:\s+by\s+moderator)?|deleted)\s*\]/i.test(`${title} ${description}`);
  const genericSearchResult = isGenericSearchTitle(title);

  return {
    id: parsed.postId,
    subreddit: parsed.subreddit || "",
    subreddit_name_prefixed: parsed.subreddit ? `r/${parsed.subreddit}` : "",
    permalink: parsed.permalink,
    title,
    author,
    url: url,
    created_utc: createdUtc,
    score: 0,
    num_comments: 0,
    upvote_ratio: 0,
    over_18: false,
    spoiler: false,
    is_self: false,
    is_video: videoHint,
    is_gif: videoHint && /\.gif(?:\?|$)/i.test(mediaHint),
    stickied: false,
    removed_by_category: removedMarker ? "search_result_removed" : null,
    search_result_generic: genericSearchResult,
    post_hint: null,
    thumbnail,
    url_overridden_by_dest: mediaHint || url,
    preview: thumbnail ? {
      images: [{ source: { url: thumbnail, width: 512, height: 512 }, resolutions: [] }],
    } : null,
    media: videoHint ? {
      reddit_video: {
        fallback_url: mediaHint,
        duration: Number(raw.duration || raw.duration_seconds || 0),
      },
    } : null,
    secure_media: null,
    media_metadata: null,
    gallery_data: null,
    crosspost_parent_list: [],
    _source: "you.com",
    _searchIndex: searchIndex,
    _searchTitle: title,
    _searchDescription: description,
    _searchThumbnailUrl: thumbnail || null,
    _publishedAt: raw.page_age || null,
  };
}

function isUsableMediaThumbnail(value) {
  if (!value || typeof value !== "string") return false;
  const url = value.trim();
  if (/o0h58lzmax6a1|redditstatic|default_preview|subreddit_default|favicon/i.test(url)) {
    return false;
  }
  return /^https?:\/\/(?:i|preview|external-preview)\.redd\.it\//i.test(url)
    || /^https?:\/\/media\d*\.giphy\.com\//i.test(url)
    || /\.(?:jpe?g|png|webp|gif)(?:\?|$)/i.test(url);
}

function getDirectMediaHint(value) {
  if (!value || typeof value !== "string") return "";
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    const allowedHost = ["i.redd.it", "preview.redd.it", "external-preview.redd.it", "v.redd.it", "media.giphy.com", "media0.giphy.com", "media1.giphy.com", "media2.giphy.com", "media3.giphy.com", "media4.giphy.com"]
      .includes(hostname);
    const directExtension = /\.(?:jpe?g|png|webp|gif|mp4|webm)(?:\?|$)/i.test(url.pathname);
    if (/o0h58lzmax6a1|redditstatic|default_preview|subreddit_default/i.test(url.href)) return "";
    return allowedHost && directExtension ? url.href : "";
  } catch {
    return "";
  }
}

function isVideoMediaHint(value) {
  return Boolean(value && /\.(?:mp4|webm|gif)(?:\?|$)/i.test(value));
}

function isGenericSearchTitle(title) {
  const normalized = String(title || "")
    .replace(/[\u2013\u2014]/g, "-")
    .trim()
    .toLowerCase();
  return normalized === "reddit"
    || normalized === "reddit - the heart of the internet"
    || normalized === "reddit - prove your humanity"
    || normalized === "reddit - dive into anything"
    || /^reddit\s*[-:]\s*(?:the heart of the internet|prove your humanity|dive into anything)$/.test(normalized);
}

function deriveTitleFromUrl(url) {
  try {
    const pathname = new URL(url).pathname.replace(/\/+$/, "");
    const slug = pathname.split("/").pop();
    if (!slug || /^(?:removed|deleted|removed_by_moderator)$/i.test(slug)) return "";
    const title = decodeURIComponent(slug)
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (title.length < 4 || /^\d+$/.test(title)) return "";
    return title.slice(0, 300);
  } catch {
    return "";
  }
}

/**
 * Execute one You.com search query and return normalized Reddit candidates.
 */
async function searchReddit(query, { logger, freshness, count } = {}) {
  const apiKey = YDC_API_KEY();
  if (!apiKey) {
    return [];
  }

  const activeFreshness = freshness !== undefined ? freshness : FRESHNESS();
  const params = new URLSearchParams({
    query,
    count: String(count || RESULTS_PER_QUERY()),
    safesearch: process.env.REDDIT_ALLOW_NSFW === "false" ? "strict" : "off",
    livecrawl: "all",
  });
  if (activeFreshness) {
    params.set("freshness", activeFreshness);
  }

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

    if (!res.ok) return [];
    const data = await res.json();
    const rawResults = [
      ...(Array.isArray(data?.results?.web) ? data.results.web : []),
      ...(Array.isArray(data?.results?.news) ? data.results.news : []),
      ...(Array.isArray(data?.hits) ? data.hits : []),
    ];

    if (!Array.isArray(rawResults) || rawResults.length === 0) return [];

    return rawResults
      .map((raw, i) => normalizeSearchResult(raw, i))
      .filter(Boolean);
  } catch (err) {
    logger?.warn({ err: String(err.message).slice(0, 100) }, "[Reddit Discovery] Search exception");
    return [];
  }
}

// ── Public API ──────────────────────────────────────────────

/**
 * Discover trending Meme & GIPHY posts.
 * Combines Meme-API (static memes) and GIPHY (animated/video stickers).
 */
async function discoverTrendingPosts({ logger } = {}) {
  const seen = new Set();
  const candidates = [];

  // 1. Fetch fresh meme images from Meme-API
  try {
    const memePosts = await fetchMemeApiPosts({ logger, countPerSubreddit: 3 });
    for (const post of memePosts) {
      if (!seen.has(post.id)) {
        seen.add(post.id);
        candidates.push(post);
      }
    }
  } catch (e) {
    logger?.warn({ err: e.message }, "[Discovery] Meme-API fetch error");
  }

  // 2. Fetch animated memes from GIPHY if key configured
  try {
    if (GIPHY_API_KEY()) {
      const giphyMemes = await fetchGiphyPosts({
        query: "funny meme",
        limit: 6,
        type: "gifs",
        randomOffset: true,
        maxRandomOffset: 40,
        logger,
      });
      for (const post of giphyMemes) {
        if (!seen.has(post.id)) {
          seen.add(post.id);
          candidates.push(post);
        }
      }
    }
  } catch (e) {
    logger?.warn({ err: e.message }, "[Discovery] GIPHY fetch error");
  }

  logger?.info({ total: candidates.length }, `[Discovery] Total ${candidates.length} candidates gathered`);
  return candidates;
}

/**
 * Search Meme-API or GIPHY for a specific keyword.
 */
async function discoverByKeyword(keyword, { logger, type = "all" } = {}) {
  const sanitized = String(keyword || "")
    .replace(/[\x00-\x1f]/g, "")
    .trim()
    .slice(0, 100);

  if (!sanitized) return [];

  const candidates = [];
  const seen = new Set();

  // Search GIPHY
  if (GIPHY_API_KEY()) {
    const giphyType = type === "stickers" ? "stickers" : "gifs";
    const giphyResults = await fetchGiphyPosts({ query: sanitized, limit: 6, type: giphyType, logger });
    for (const p of giphyResults) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        candidates.push(p);
      }
    }
  }

  // Search Meme-API or You.com if needed
  if (candidates.length === 0 && YDC_API_KEY()) {
    const subreddits = SEARCH_SUBREDDITS();
    const subredditConstraint = subreddits.map((s) => `site:reddit.com/r/${s}/comments`).join(" OR ");
    const query = `(${subredditConstraint}) "${sanitized}" meme`;
    const youResults = await searchReddit(query, { logger, freshness: FALLBACK_FRESHNESS(), count: 10 });
    for (const p of youResults) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        candidates.push(p);
      }
    }
  }

  return candidates;
}

/**
 * Lightweight Reddit page metadata fetch — ONE attempt, no auth, no cookies.
 */
async function fetchRedditPageMetadata(redditUrl) {
  const parsed = parseRedditPostUrl(redditUrl);
  if (!parsed) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

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
      if ([401, 403, 429].includes(res.status)) {
        return { available: false, reason: `reddit_page_unavailable_${res.status}` };
      }
      return null;
    }

    const html = await res.text();
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
  fetchMemeApiPosts,
  fetchGiphyPosts,
  fetchRedditPageMetadata,
  normalizeSearchResult,
  searchReddit,
  DISCOVERY_QUERIES,
};
