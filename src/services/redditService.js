// Reddit Data API service — OAuth token management and API calls.
// Uses Reddit's official OAuth endpoint for script-type apps.
// Token is cached in memory and auto-refreshed near expiry.

const REDDIT_OAUTH_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_API_BASE = "https://oauth.reddit.com";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry
const API_TIMEOUT_MS = 15000;

// ── Token cache ──────────────────────────────────────────

let tokenCache = {
  accessToken: null,
  expiresAt: 0,
  pending: null, // Promise for in-flight refresh
};

// ── Helpers ──────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeForLog(text) {
  if (!text) return "";
  return String(text).slice(0, 100);
}

// ── OAuth ────────────────────────────────────────────────

async function getAccessToken() {
  const now = Date.now();

  // Return cached token if still valid
  if (tokenCache.accessToken && tokenCache.expiresAt > now + TOKEN_REFRESH_MARGIN_MS) {
    return tokenCache.accessToken;
  }

  // If a refresh is already in progress, wait for it
  if (tokenCache.pending) {
    return tokenCache.pending;
  }

  // Start new token fetch
  tokenCache.pending = fetchNewToken();

  try {
    const token = await tokenCache.pending;
    return token;
  } finally {
    tokenCache.pending = null;
  }
}

async function fetchNewToken() {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("REDDIT_CREDENTIALS_MISSING");
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetchWithTimeout(REDDIT_OAUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": process.env.REDDIT_USER_AGENT || "WhatsAppGroupStickerBot/1.0",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`REDDIT_OAUTH_FAILED: ${res.status} ${body.slice(0, 200)}`);
  }

  const data = await res.json();

  if (!data.access_token) {
    throw new Error("REDDIT_OAUTH_NO_TOKEN");
  }

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    pending: null,
  };

  return data.access_token;
}

function clearTokenCache() {
  tokenCache = { accessToken: null, expiresAt: 0, pending: null };
}

// ── API helpers ──────────────────────────────────────────

async function redditGet(path, queryParams = {}) {
  const token = await getAccessToken();

  const url = new URL(path, REDDIT_API_BASE);
  for (const [key, val] of Object.entries(queryParams)) {
    if (val !== undefined && val !== null) {
      url.searchParams.set(key, String(val));
    }
  }

  const res = await fetchWithTimeout(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": process.env.REDDIT_USER_AGENT || "WhatsAppGroupStickerBot/1.0",
      Accept: "application/json",
    },
  });

  if (res.status === 401) {
    // Token expired — clear cache and retry once
    clearTokenCache();
    const newToken = await getAccessToken();

    const retryRes = await fetchWithTimeout(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${newToken}`,
        "User-Agent": process.env.REDDIT_USER_AGENT || "WhatsAppGroupStickerBot/1.0",
        Accept: "application/json",
      },
    });

    if (!retryRes.ok) {
      throw new Error(`REDDIT_API_FAILED: ${retryRes.status}`);
    }

    return retryRes.json();
  }

  if (!res.ok) {
    throw new Error(`REDDIT_API_FAILED: ${res.status}`);
  }

  return res.json();
}

// ── Public API methods ───────────────────────────────────

/**
 * Get top posts from a subreddit for the day.
 * @param {string} subreddit
 * @param {number} limit
 * @returns {Promise<object>} Reddit listing response
 */
async function getTopPosts(subreddit, limit = 50) {
  return redditGet(`/r/${subreddit}/top`, {
    t: "day",
    limit: String(limit),
    raw_json: "1",
  });
}

/**
 * Get hot posts from a subreddit.
 * @param {string} subreddit
 * @param {number} limit
 * @returns {Promise<object>} Reddit listing response
 */
async function getHotPosts(subreddit, limit = 50) {
  return redditGet(`/r/${subreddit}/hot`, {
    limit: String(limit),
    raw_json: "1",
  });
}

/**
 * Search a subreddit for posts matching a keyword.
 * @param {string} subreddit
 * @param {string} keyword
 * @param {number} limit
 * @returns {Promise<object>} Reddit listing response
 */
async function searchSubreddit(subreddit, keyword, limit = 50) {
  return redditGet(`/r/${subreddit}/search`, {
    q: keyword,
    restrict_sr: "true",
    sort: "top",
    t: "week",
    limit: String(limit),
    raw_json: "1",
  });
}

/**
 * Get a specific Reddit post by ID.
 * Supports fullname (t3_abc123) or bare ID.
 * @param {string} postId
 * @returns {Promise<object|null>} Post data or null
 */
async function getPostById(postId) {
  // Strip t3_ prefix if present
  const id = postId.replace(/^t3_/, "");

  try {
    // Use /api/info to get the post by its fullname
    const data = await redditGet("/api/info", {
      id: `t3_${id}`,
      raw_json: "1",
    });

    if (data?.data?.children?.length > 0) {
      return data.data.children[0].data;
    }

    // Fallback: try /comments endpoint which also returns post data
    const commentsData = await redditGet(`/comments/${id}`, {
      limit: "1",
      raw_json: "1",
    });

    if (Array.isArray(commentsData) && commentsData.length > 0) {
      const listing = commentsData[0];
      if (listing?.data?.children?.length > 0) {
        return listing.data.children[0].data;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ── URL parsing ──────────────────────────────────────────

const VALID_REDDIT_HOSTS = [
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "redd.it",
];

/**
 * Parse a Reddit post URL and extract the post ID.
 * @param {string} urlStr
 * @returns {{ postId: string, hostname: string }|null}
 */
function parseRedditUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return null;

  let url;
  try {
    url = new URL(urlStr.trim());
  } catch {
    return null;
  }

  // Validate protocol
  if (!["http:", "https:"].includes(url.protocol)) return null;

  // Validate hostname
  const hostname = url.hostname.replace(/^www\./, "").toLowerCase();
  if (!VALID_REDDIT_HOSTS.includes(hostname)) {
    // Also reject impostors like "reddit.com.evil.org"
    return null;
  }

  // redd.it shortlink: redd.it/<postId>
  if (hostname === "redd.it") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 1) {
      return { postId: parts[0], hostname };
    }
    return null;
  }

  // Standard: /r/subreddit/comments/<postId>/...
  const match = url.pathname.match(/\/r\/[^/]+\/comments\/([a-z0-9]+)/i);
  if (match) {
    return { postId: match[1], hostname };
  }

  return null;
}

module.exports = {
  getAccessToken,
  clearTokenCache,
  getTopPosts,
  getHotPosts,
  searchSubreddit,
  getPostById,
  parseRedditUrl,
  VALID_REDDIT_HOSTS,
};
