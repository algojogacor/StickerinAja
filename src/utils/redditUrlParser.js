// Strict Reddit post URL parser — validates and extracts post IDs.
// Uses exact hostname matching (no substring checks) to prevent impostor domains.
// Accepts only post/detail URLs; rejects subreddit homepages, search, user pages, etc.

// ── Allowed Reddit hostnames (exact match only) ─────────────

const REDDIT_POST_HOSTS = new Set([
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "redd.it",
]);

// ── Path patterns that are NOT individual posts ─────────────

const REJECTED_PATH_PATTERNS = [
  /^\/r\/[^/]+\/?$/,                          // subreddit homepage
  /^\/r\/[^/]+\/(hot|new|top|rising|controversial|gilded|wiki)\/?/,  // listing pages
  /^\/r\/popular\/?/,
  /^\/r\/all\/?/,
  /^\/search\/?/,
  /^\/user\/[^/]+\/?/,
  /^\/u\/[^/]+\/?/,
  /^\/message\/?/,
  /^\/settings\/?/,
  /^\/prefs\/?/,
  /^\/submit\/?/,
  /^\/login\/?/,
  /^\/register\/?/,
  /^\/media\/?/,
  /^\/live\/?/,
  /^\/chat\/?/,
  /^\/poll\/?/,
  /^\/rpan\/?/,
  /^\/coins\/?/,
  /^\/premium\/?/,
];

// ── Public API ──────────────────────────────────────────────

/**
 * Parse a Reddit post URL and extract normalized metadata.
 *
 * @param {string} urlStr - Raw URL string
 * @returns {{
 *   postId: string,
 *   subreddit: string|null,
 *   hostname: string,
 *   normalizedUrl: string,
 *   permalink: string
 * } | null} Parsed result or null if invalid
 */
function parseRedditPostUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return null;

  let url;
  try {
    url = new URL(urlStr.trim());
  } catch {
    return null;
  }

  // Protocol must be http or https
  if (!["http:", "https:"].includes(url.protocol)) return null;

  // Exact hostname match — no substring/endsWith tricks
  const hostname = url.hostname.toLowerCase();
  if (!REDDIT_POST_HOSTS.has(hostname)) return null;

  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  // Reject known non-post paths
  for (const pattern of REJECTED_PATH_PATTERNS) {
    if (pattern.test(pathname)) return null;
  }

  let postId = null;
  let subreddit = null;
  let permalink = null;

  // ── redd.it shortlink: /<postId> ──
  if (hostname === "redd.it") {
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length >= 1 && /^[a-z0-9]{5,13}$/i.test(parts[0])) {
      postId = parts[0];
      // redd.it doesn't carry subreddit info
    }
  } else {
    // ── Standard: /r/<subreddit>/comments/<postId>/<optional-slug> ──
    const match = pathname.match(
      /^\/r\/([^/]+)\/comments\/([a-z0-9]{5,13})(?:\/[^/]*)?$/i
    );
    if (match) {
      subreddit = match[1];
      postId = match[2];
      permalink = `/r/${subreddit}/comments/${postId}/`;
    }
  }

  if (!postId) return null;

  return {
    postId,
    subreddit,
    hostname,
    normalizedUrl: `https://www.reddit.com/r/${subreddit || "unknown"}/comments/${postId}/`,
    permalink: permalink || `/comments/${postId}/`,
  };
}

/**
 * Quick check: is this a valid Reddit post URL?
 * @param {string} urlStr
 * @returns {boolean}
 */
function isRedditPostUrl(urlStr) {
  return parseRedditPostUrl(urlStr) !== null;
}

/**
 * Extract just the post ID from a Reddit URL.
 * @param {string} urlStr
 * @returns {string|null}
 */
function extractPostId(urlStr) {
  const parsed = parseRedditPostUrl(urlStr);
  return parsed ? parsed.postId : null;
}

module.exports = {
  REDDIT_POST_HOSTS,
  parseRedditPostUrl,
  isRedditPostUrl,
  extractPostId,
};
