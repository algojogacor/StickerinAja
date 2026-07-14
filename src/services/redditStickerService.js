// Reddit Sticker Service — orchestrates the full pipeline:
// fetch → filter → rank → download → convert → store in Sticker Bank.
// Also handles search, URL import, bank stats, and sender logic.

const crypto = require("crypto");
const {
  getTopPosts,
  getHotPosts,
  searchSubreddit,
  getPostById,
  parseRedditUrl,
} = require("./redditService");
const {
  filterAndRankPosts,
  resolveMedia,
} = require("./redditMediaResolver");
const {
  downloadMedia,
  cleanupTempFile,
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

// ── Config ───────────────────────────────────────────────

const DEFAULT_SUBREDDITS = () =>
  (process.env.REDDIT_DEFAULT_SUBREDDITS || "memes,dankmemes,wholesomememes,me_irl,funny,gifs,ProgrammerHumor")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const GENERATE_COUNT = () =>
  parseInt(process.env.REDDIT_STICKER_GENERATE_COUNT || "5", 10);
const SEND_COUNT = () =>
  parseInt(process.env.REDDIT_STICKER_SEND_COUNT || "1", 10);
const FETCH_LIMIT = () =>
  parseInt(process.env.REDDIT_FETCH_LIMIT || "50", 10);
const MAX_CONCURRENT_DOWNLOADS = () =>
  parseInt(process.env.REDDIT_MAX_CONCURRENT_DOWNLOADS || "2", 10);

// ── Idempotency ──────────────────────────────────────────

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

// ── Helpers ──────────────────────────────────────────────

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
    sourceUrl: post.url ? `https://www.reddit.com${post.permalink || ""}` : "",
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

// ── Pipeline step: fetch posts from Reddit ────────────────

async function fetchCandidates({ logger } = {}) {
  const subreddits = shuffle(DEFAULT_SUBREDDITS());
  const limit = FETCH_LIMIT();

  const seenIds = new Set();
  const allPosts = [];

  // Take a subset of subreddits to avoid over-fetching
  const batch = subreddits.slice(0, 5);

  for (const subreddit of batch) {
    try {
      // Fetch both /top and /hot
      const [topData, hotData] = await Promise.all([
        getTopPosts(subreddit, limit).catch(() => null),
        getHotPosts(subreddit, limit).catch(() => null),
      ]);

      const topPosts = topData?.data?.children?.map((c) => c.data) || [];
      const hotPosts = hotData?.data?.children?.map((c) => c.data) || [];

      const combined = [...topPosts, ...hotPosts];

      for (const post of combined) {
        if (!seenIds.has(post.id)) {
          seenIds.add(post.id);
          allPosts.push(post);
        }
      }

      logger?.info({
        feature: "reddit_sticker",
        subreddit,
        topCount: topPosts.length,
        hotCount: hotPosts.length,
      }, `Fetched r/${subreddit}: ${topPosts.length} top + ${hotPosts.length} hot`);
    } catch (err) {
      logger?.warn({
        feature: "reddit_sticker",
        subreddit,
        error: String(err.message).slice(0, 100),
      }, `Failed to fetch r/${subreddit}`);
    }
  }

  return allPosts;
}

// ── Pipeline step: download + convert one post ────────────

async function processPost(post, { logger } = {}) {
  const media = post._resolvedMedia || resolveMedia(post);
  if (!media?.mediaUrl) {
    return { success: false, reason: "no_supported_media" };
  }

  // Check duplicate
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
      sourceUrl: `https://www.reddit.com${post.permalink || ""}`,
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
    await updateStickerStatus(stickerId, "downloading");
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
    const persistentPath = saveStickerFile(convertResult.buffer, convertResult.durationSeconds ? "animated" : "static");

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

// ── Generator: fetch → filter → rank → process ────────────

async function generateStickers({ logger, count } = {}) {
  const target = count || GENERATE_COUNT();
  const subreddits = shuffle(DEFAULT_SUBREDDITS());

  logger?.info({
    feature: "reddit_sticker",
    target,
    subreddits: subreddits.slice(0, 5),
  }, "Starting sticker generation");

  // 1. Fetch from multiple subreddits with concurrency limit of 3
  const allPosts = await fetchCandidates({ logger });

  // 2. Filter and rank
  const candidates = filterAndRankPosts(allPosts);
  logger?.info({
    feature: "reddit_sticker",
    fetched: allPosts.length,
    candidates: candidates.length,
  }, `Filtered: ${candidates.length} candidates from ${allPosts.length} posts`);

  if (candidates.length === 0) {
    logger?.warn("No eligible Reddit candidates found");
    return { generated: 0, attempted: 0 };
  }

  // 3. Process candidates (download + convert) with concurrency limit
  let generated = 0;
  let attempted = 0;
  const dlLimit = MAX_CONCURRENT_DOWNLOADS();

  for (let i = 0; i < candidates.length && generated < target; i += dlLimit) {
    const batch = candidates.slice(i, i + dlLimit).slice(0, target - generated + 2);
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

// ── Sender: pick one ready sticker and send ────────────────

async function sendOneSticker(sock, groupJid, { logger } = {}) {
  const count = SEND_COUNT();
  if (count <= 0) return { sent: 0 };

  const stickers = await getLeastRecentlySent(count);
  if (stickers.length === 0) {
    logger?.info("No ready stickers in bank");
    return { sent: 0 };
  }

  let sent = 0;

  for (const sticker of stickers) {
    try {
      // Verify file exists
      const fs = require("fs");
      if (!sticker.localPath || !fs.existsSync(sticker.localPath)) {
        await updateStickerStatus(sticker.id, "failed", "file_missing");
        logger?.warn({ redditPostId: sticker.redditPostId }, "Sticker file missing");
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

// ── Search + send ─────────────────────────────────────────

async function searchAndSend(keyword, sock, remoteJid, { logger } = {}) {
  const subreddits = DEFAULT_SUBREDDITS();
  const limit = FETCH_LIMIT();

  // Sanitize keyword
  const cleanKeyword = String(keyword || "").replace(/[\x00-\x1f]/g, "").trim().slice(0, 100);
  if (!cleanKeyword) {
    throw new Error("Keyword kosong");
  }

  let allPosts = [];
  const seenIds = new Set();

  // Search up to 3 subreddits with concurrency limit of 3
  const searchBatch = subreddits.slice(0, 5);
  for (let i = 0; i < searchBatch.length; i += 3) {
    const batch = searchBatch.slice(i, i + 3);
    const results = await Promise.allSettled(
      batch.map(async (subreddit) => {
        try {
          const data = await searchSubreddit(subreddit, cleanKeyword, limit);
          const posts = data?.data?.children?.map((c) => c.data) || [];
          return { subreddit, posts };
        } catch {
          return { subreddit, posts: [] };
        }
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        for (const post of r.value.posts) {
          if (!seenIds.has(post.id)) {
            seenIds.add(post.id);
            post._searchSubreddit = r.value.subreddit;
            allPosts.push(post);
          }
        }
      }
    }

    if (allPosts.length >= 30) break;
  }

  if (allPosts.length === 0) {
    return { success: false, reason: "no_results" };
  }

  // Filter and rank, pick best
  const candidates = filterAndRankPosts(allPosts);
  if (candidates.length === 0) {
    return { success: false, reason: "no_eligible" };
  }

  // Try the top 3 candidates
  for (const candidate of candidates.slice(0, 3)) {
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

// ── URL import ────────────────────────────────────────────

async function importFromUrl(urlStr, sock, remoteJid, { logger } = {}) {
  const parsed = parseRedditUrl(urlStr);
  if (!parsed) {
    return { success: false, reason: "invalid_reddit_url" };
  }

  const post = await getPostById(parsed.postId);
  if (!post) {
    return { success: false, reason: "post_not_found" };
  }

  // Check eligibility
  const { isEligibleRedditPost } = require("./redditMediaResolver");
  if (!isEligibleRedditPost(post)) {
    return { success: false, reason: "post_not_eligible" };
  }

  // Resolve media
  const media = resolveMedia(post);
  if (!media) {
    return { success: false, reason: "no_supported_media" };
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

// ── Send sticker from bank ────────────────────────────────

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
    logger?.warn({ error: String(err.message).slice(0, 100) }, "Failed to send bank sticker");
    return { success: false, reason: "send_failed" };
  }
}

// ── Bank stats ────────────────────────────────────────────

async function getBankStats() {
  return getStats();
}

// ── Get source of a sticker ──────────────────────────────

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
