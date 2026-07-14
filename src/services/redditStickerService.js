// Reddit Sticker Service — orchestrates the full pipeline:
// You.com discovery → filter → rank → download → convert → store in Sticker Bank.
// Also handles search, URL import, bank stats, and sender logic.
//
// NO Reddit OAuth required. Discovery via You.com Web Search API.
// The resolver, downloader, converter, and repository are reused as-is.

const crypto = require("crypto");
const {
  discoverTrendingPosts,
  discoverByKeyword,
  fetchRedditPageMetadata,
} = require("./redditStickerDiscovery");
const { parseRedditPostUrl } = require("../utils/redditUrlParser");
const {
  filterAndRankPosts,
  resolveMedia,
  isEligibleRedditPost,
} = require("./redditMediaResolver");
const {
  downloadMedia,
  cleanupTempFile,
  validateMediaUrl,
} = require("./redditMediaDownloader");
const {
  convertStaticSticker,
  convertAnimatedSticker,
  isAnimatedMedia,
  saveStickerFile,
} = require("./redditMediaConverter");
const {
  insertSticker,
  updateStickerStatus,
  markStickerSent,
  getReadyStickers,
  getLeastRecentlySent,
  getStickerById,
  getStats,
  isDuplicate,
  computeHash,
} = require("../repositories/redditStickerRepository");

// ── Config ──────────────────────────────────────────────────

const GENERATE_COUNT = () =>
  parseInt(process.env.REDDIT_STICKER_GENERATE_COUNT || "5", 10);
const SEND_COUNT = () =>
  parseInt(process.env.REDDIT_STICKER_SEND_COUNT || "1", 10);
const MAX_CONCURRENT_DOWNLOADS = () =>
  parseInt(process.env.REDDIT_MAX_CONCURRENT_DOWNLOADS || "2", 10);

// ── Idempotency ─────────────────────────────────────────────

const generationStatus = new Map();

function getGenerationKey(dateJakarta, slot) {
  return `reddit-sticker:${dateJakarta}:${slot}`;
}

function isSlotGenerated(key) {
  return generationStatus.has(key);
}

function markSlotGenerated(key) {
  generationStatus.set(key, { status: "generated", timestamp: Date.now() });
}

// ── Helpers ─────────────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildStickerRecord(post, downloadResult, convertResult) {
  const media = post._resolvedMedia || resolveMedia(post);

  return {
    id: crypto.randomUUID(),
    redditPostId: post.id,
    originalPostId: media?.originalPostId || post.id,
    subreddit: post.subreddit || "",
    author: post.author || "",
    title: (post.title || "").slice(0, 300),
    permalink: post.permalink ? `https://www.reddit.com${post.permalink}` : "",
    sourceUrl: post.permalink ? `https://www.reddit.com${post.permalink}` : "",
    mediaUrl: media?.mediaUrl || "",
    mediaType: media?.mediaType || "unknown",
    stickerType: isAnimatedMedia(media?.mediaType) ? "animated" : "static",
    localPath: convertResult?.filePath || "",
    fileSizeBytes: convertResult?.fileSizeBytes || 0,
    durationSeconds: convertResult?.durationSeconds || null,
    score: post.score || 0,
    upvoteRatio: post.upvote_ratio || null,
    createdUtc: post.created_utc || 0,
    fetchedAt: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    sentCount: 0,
    lastSentAt: null,
    status: "ready",
    failureReason: null,
    contentHash: downloadResult?.buffer
      ? computeHash(downloadResult.buffer)
      : "",
  };
}

// ── Pipeline step: fetch candidates from You.com discovery ──

async function fetchCandidates({ logger } = {}) {
  // Use You.com Web Search to discover trending Reddit posts
  const candidates = await discoverTrendingPosts({ logger });

  logger?.info({
    feature: "reddit_sticker",
    discovered: candidates.length,
  }, `Discovered ${candidates.length} Reddit posts via You.com`);

  return candidates;
}

// ── Pipeline step: download + convert one post ───────────────

async function processPost(post, { logger } = {}) {
  const media = post._resolvedMedia || resolveMedia(post);
  if (!media?.mediaUrl) {
    return { success: false, reason: "no_supported_media" };
  }

  // Check duplicate by Reddit post ID
  const dup = await isDuplicate({
    redditPostId: post.id,
    originalPostId: media.originalPostId || null,
    contentHash: null, // will check after download
  });
  if (dup) {
    return { success: false, reason: "duplicate_post" };
  }

  const stickerId = crypto.randomUUID();
  let downloadResult = null;

  try {
    // Insert placeholder
    await insertSticker({
      id: stickerId,
      redditPostId: post.id,
      originalPostId: media.originalPostId || post.id,
      subreddit: post.subreddit || "",
      author: post.author || "",
      title: (post.title || "").slice(0, 300),
      permalink: post.permalink || "",
      sourceUrl: post.permalink
        ? `https://www.reddit.com${post.permalink}`
        : "",
      mediaUrl: media.mediaUrl,
      mediaType: media.mediaType,
      stickerType: isAnimatedMedia(media.mediaType) ? "animated" : "static",
      localPath: "",
      fileSizeBytes: 0,
      durationSeconds: null,
      score: post.score || 0,
      upvoteRatio: post.upvote_ratio || null,
      createdUtc: post.created_utc || 0,
      fetchedAt: new Date().toISOString(),
      generatedAt: new Date().toISOString(),
      sentCount: 0,
      lastSentAt: null,
      status: "downloading",
      failureReason: null,
      contentHash: "",
    });

    // Download
    downloadResult = await downloadMedia(media.mediaUrl);

    // Check duplicate by content hash
    const hash = computeHash(downloadResult.buffer);
    const dupByHash = await isDuplicate({
      redditPostId: null,
      originalPostId: null,
      contentHash: hash,
    });
    if (dupByHash) {
      cleanupTempFile(downloadResult.filePath);
      await updateStickerStatus(stickerId, "rejected", "duplicate_post");
      return { success: false, reason: "duplicate_post" };
    }

    // Convert
    await updateStickerStatus(stickerId, "converting");

    let convertResult;
    if (isAnimatedMedia(media.mediaType)) {
      convertResult = await convertAnimatedSticker(downloadResult.filePath);
    } else {
      convertResult = await convertStaticSticker(downloadResult.buffer);
    }

    // Save to persistent sticker storage
    const persistentPath = saveStickerFile(
      convertResult.buffer,
      convertResult.durationSeconds ? "animated" : "static"
    );

    // Update final record
    await insertSticker({
      ...buildStickerRecord(post, downloadResult, convertResult),
      id: stickerId,
      localPath: persistentPath,
      contentHash: hash,
      status: "ready",
    });

    logger?.info({
      feature: "reddit_sticker",
      redditPostId: post.id,
      subreddit: post.subreddit,
      mediaType: media.mediaType,
      stickerType: convertResult.durationSeconds ? "animated" : "static",
      fileSizeBytes: convertResult.fileSizeBytes,
      durationSeconds: convertResult.durationSeconds,
      status: "ready",
    }, `Sticker generated: ${post.id} (${formatStickerBytes(convertResult.fileSizeBytes)})`);

    return {
      success: true,
      stickerId,
      convertResult,
    };
  } catch (err) {
    const reason = String(err.message || "unknown").slice(0, 100);
    await updateStickerStatus(stickerId, "failed", reason);

    logger?.warn({
      feature: "reddit_sticker",
      redditPostId: post.id,
      subreddit: post.subreddit,
      status: "failed",
      failureReason: reason,
    }, `Sticker failed: ${post.id} — ${reason}`);

    return { success: false, reason };
  } finally {
    if (downloadResult?.filePath) {
      cleanupTempFile(downloadResult.filePath);
    }
  }
}

function formatStickerBytes(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// ── Generator: discover → filter → rank → process ────────────

async function generateStickers({ logger, count } = {}) {
  const target = count || GENERATE_COUNT();

  logger?.info({
    feature: "reddit_sticker",
    target,
  }, "Starting sticker generation (You.com discovery)");

  // 1. Discover trending Reddit posts via You.com
  const candidates = await fetchCandidates({ logger });

  if (candidates.length === 0) {
    logger?.warn("[Reddit Sticker] No candidates discovered via You.com");
    return { generated: 0, attempted: 0 };
  }

  // 2. Filter and rank using existing resolver
  const ranked = filterAndRankPosts(candidates);
  logger?.info({
    feature: "reddit_sticker",
    discovered: candidates.length,
    eligible: ranked.length,
  }, `Filtered: ${ranked.length} eligible from ${candidates.length} discovered`);

  if (ranked.length === 0) {
    logger?.warn("[Reddit Sticker] No eligible candidates after filtering");
    return { generated: 0, attempted: 0 };
  }

  // 3. Process candidates (download + convert) with concurrency limit
  let generated = 0;
  let attempted = 0;
  const dlLimit = MAX_CONCURRENT_DOWNLOADS();

  for (let i = 0; i < ranked.length && generated < target; i += dlLimit) {
    const batch = ranked.slice(i, i + dlLimit).slice(0, target - generated + 2);
    attempted += batch.length;

    const results = await Promise.allSettled(
      batch.map((post) => processPost(post, { logger }))
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value.success) {
        generated++;
        if (generated >= target) break;
      }
    }
  }

  logger?.info({
    feature: "reddit_sticker",
    generated,
    attempted,
  }, `Generation complete: ${generated}/${target} stickers`);

  return { generated, attempted };
}

// ── Sender: pick one ready sticker and send ───────────────────

async function sendOneSticker(sock, groupJid, { logger } = {}) {
  const count = SEND_COUNT();
  if (count <= 0) return { sent: 0 };

  const stickers = await getLeastRecentlySent(count);
  if (stickers.length === 0) {
    logger?.info("[Reddit Sticker] No ready stickers in bank");
    return { sent: 0 };
  }

  let sent = 0;

  for (const sticker of stickers) {
    try {
      const fs = require("fs");
      if (!sticker.localPath || !fs.existsSync(sticker.localPath)) {
        await updateStickerStatus(sticker.id, "failed", "file_missing");
        logger?.warn(
          { redditPostId: sticker.redditPostId },
          "[Reddit Sticker] File missing"
        );
        continue;
      }

      const buffer = fs.readFileSync(sticker.localPath);

      await sock.sendMessage(groupJid, {
        sticker: buffer,
      });

      await markStickerSent(sticker.id);

      sent++;
      logger?.info({
        feature: "reddit_sticker",
        redditPostId: sticker.redditPostId,
        subreddit: sticker.subreddit,
        fileSizeBytes: sticker.fileSizeBytes,
      }, `Sticker sent: ${sticker.redditPostId}`);
    } catch (err) {
      logger?.warn({
        feature: "reddit_sticker",
        redditPostId: sticker.redditPostId,
        error: String(err.message).slice(0, 100),
      }, `Failed to send sticker: ${sticker.redditPostId}`);
    }
  }

  return { sent };
}

// ── Search + send (keyword) ──────────────────────────────────

async function searchAndSend(keyword, sock, remoteJid, { logger } = {}) {
  const cleanKeyword = String(keyword || "")
    .replace(/[\x00-\x1f]/g, "")
    .trim()
    .slice(0, 100);
  if (!cleanKeyword) {
    throw new Error("Keyword kosong");
  }

  logger?.info(
    { keyword: cleanKeyword },
    "[Reddit Sticker] Keyword search via You.com"
  );

  // Discover via You.com keyword search
  const candidates = await discoverByKeyword(cleanKeyword, { logger });

  if (candidates.length === 0) {
    return { success: false, reason: "no_results" };
  }

  // Filter and rank, pick best
  const ranked = filterAndRankPosts(candidates);
  if (ranked.length === 0) {
    return { success: false, reason: "no_eligible" };
  }

  // Try the top 3 candidates
  for (const candidate of ranked.slice(0, 3)) {
    const result = await processPost(candidate, { logger });
    if (result.success) {
      // Send immediately
      const sticker = await getStickerById(result.stickerId);
      if (sticker && sticker.localPath) {
        const fs = require("fs");
        if (fs.existsSync(sticker.localPath)) {
          const buffer = fs.readFileSync(sticker.localPath);
          await sock.sendMessage(remoteJid, { sticker: buffer });
          await markStickerSent(sticker.id);
          return {
            success: true,
            postId: candidate.id,
            subreddit: candidate.subreddit,
            title: candidate.title,
            stickerId: sticker.id,
          };
        }
      }
    }
  }

  return { success: false, reason: "conversion_failed" };
}

// ── URL import ───────────────────────────────────────────────

async function importFromUrl(urlStr, sock, remoteJid, { logger } = {}) {
  // Parse URL with strict validation
  const parsed = parseRedditPostUrl(urlStr);
  if (!parsed) {
    return { success: false, reason: "invalid_reddit_url" };
  }

  logger?.info(
    { postId: parsed.postId, subreddit: parsed.subreddit },
    "[Reddit Sticker] URL import"
  );

  // Try lightweight unauthenticated metadata fetch (ONE attempt only)
  let pageMeta = null;
  try {
    pageMeta = await fetchRedditPageMetadata(urlStr);
  } catch {
    // fetchRedditPageMetadata handles its own errors
  }

  if (pageMeta && !pageMeta.available) {
    // 401, 403, 429 — page unavailable
    logger?.warn(
      { postId: parsed.postId, reason: pageMeta.reason },
      "[Reddit Sticker] Reddit page unavailable"
    );
    return { success: false, reason: "reddit_page_unavailable" };
  }

  // Build a minimal post object from URL + available metadata
  const post = {
    id: parsed.postId,
    subreddit: parsed.subreddit || "",
    subreddit_name_prefixed: parsed.subreddit ? `r/${parsed.subreddit}` : "",
    permalink: parsed.permalink,
    title: pageMeta?.ogTitle || parsed.postId,
    author: "",
    url: parsed.normalizedUrl,
    created_utc: Math.floor(Date.now() / 1000) - 3600,
    score: 0,
    num_comments: 0,
    upvote_ratio: 0,
    over_18: false,
    spoiler: false,
    is_self: false,
    is_video: false,
    is_gif: false,
    stickied: false,
    removed_by_category: null,
    post_hint: null,
    thumbnail: pageMeta?.ogImage || "image",
    url_overridden_by_dest: pageMeta?.ogImage || parsed.normalizedUrl,
    preview: pageMeta?.ogImage
      ? {
          images: [
            { source: { url: pageMeta.ogImage, width: 512, height: 512 }, resolutions: [] },
          ],
        }
      : null,
    media: null,
    secure_media: null,
    media_metadata: null,
    gallery_data: null,
    crosspost_parent_list: [],
    _source: "reddit_url_import",
  };

  // Check eligibility
  if (!isEligibleRedditPost(post)) {
    return { success: false, reason: "post_not_eligible" };
  }

  // Resolve media
  let media = resolveMedia(post);
  if (!media?.mediaUrl) {
    // If OG video was found, validate it with the same SSRF-safe check
    // used by the downloader before accepting it as a media source
    if (pageMeta?.ogVideo) {
      const urlCheck = validateMediaUrl(pageMeta.ogVideo);
      if (urlCheck.ok) {
        media = { mediaUrl: urlCheck.url, mediaType: "video" };
      } else {
        logger?.warn(
          { postId: parsed.postId, ogVideoHost: urlCheck.hostname || "unknown", reason: urlCheck.reason },
          "[Reddit Sticker] OG video URL rejected by media validator"
        );
        return { success: false, reason: "unsupported_external_host" };
      }
    } else {
      return { success: false, reason: "no_supported_media" };
    }
  }
  post._resolvedMedia = media;

  const result = await processPost(post, { logger });
  if (!result.success) {
    return { success: false, reason: result.reason };
  }

  // Send immediately
  const sticker = await getStickerById(result.stickerId);
  if (sticker && sticker.localPath) {
    const fs = require("fs");
    if (fs.existsSync(sticker.localPath)) {
      const buffer = fs.readFileSync(sticker.localPath);
      await sock.sendMessage(remoteJid, { sticker: buffer });
      await markStickerSent(sticker.id);
      return {
        success: true,
        postId: post.id,
        subreddit: post.subreddit,
        title: post.title,
        stickerId: sticker.id,
      };
    }
  }

  return { success: false, reason: "file_missing" };
}

// ── Send sticker from bank ───────────────────────────────────

async function sendReadyFromBank(sock, remoteJid, { logger } = {}) {
  const stickers = await getLeastRecentlySent(1);
  if (stickers.length === 0) {
    return { success: false, reason: "bank_empty" };
  }

  const sticker = stickers[0];
  try {
    const fs = require("fs");
    if (!sticker.localPath || !fs.existsSync(sticker.localPath)) {
      await updateStickerStatus(sticker.id, "failed", "file_missing");
      return { success: false, reason: "file_missing" };
    }

    const buffer = fs.readFileSync(sticker.localPath);
    await sock.sendMessage(remoteJid, { sticker: buffer });
    await markStickerSent(sticker.id);

    logger?.info({
      feature: "reddit_sticker",
      redditPostId: sticker.redditPostId,
      subreddit: sticker.subreddit,
    }, `Sent bank sticker: ${sticker.redditPostId}`);

    return {
      success: true,
      postId: sticker.redditPostId,
      subreddit: sticker.subreddit,
      title: sticker.title,
      stickerId: sticker.id,
    };
  } catch (err) {
    logger?.warn(
      { error: String(err.message).slice(0, 100) },
      "[Reddit Sticker] Failed to send bank sticker"
    );
    return { success: false, reason: "send_failed" };
  }
}

// ── Bank stats ───────────────────────────────────────────────

async function getBankStats() {
  return getStats();
}

// ── Get source of a sticker ──────────────────────────────────

async function getStickerSource(stickerId) {
  if (stickerId) {
    return getStickerById(stickerId);
  }
  // Get the most recently sent sticker
  const stickers = await getLeastRecentlySent(1);
  return stickers[0] || null;
}

module.exports = {
  generateStickers,
  sendOneSticker,
  sendReadyFromBank,
  searchAndSend,
  importFromUrl,
  getBankStats,
  getStickerSource,
  getGenerationKey,
  isSlotGenerated,
  markSlotGenerated,
  fetchCandidates,
  processPost,
};
