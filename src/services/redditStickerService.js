// Reddit & GIPHY Sticker Service — orchestrates the full pipeline:
// Discovery (Meme-API + GIPHY) → filter → rank → download → convert → store in Sticker Bank.
// Also handles search, URL import, bank stats, and sender logic.

const crypto = require("crypto");
const {
  discoverTrendingPosts,
  discoverByKeyword,
  fetchGiphyPosts,
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
  parseInt(process.env.REDDIT_STICKER_GENERATE_COUNT || "2", 10);
const SEND_COUNT = () =>
  parseInt(process.env.REDDIT_STICKER_SEND_COUNT || "2", 10);
const MAX_CONCURRENT_DOWNLOADS = () =>
  parseInt(process.env.REDDIT_MAX_CONCURRENT_DOWNLOADS || "2", 10);

const AUTOMATED_MEME_SUBREDDITS = new Set([
  "memes",
  "dankmemes",
  "me_irl",
  "wholesomememes",
  "funny",
  "programmerhumor",
  "starterpacks",
  "lotrmemes",
  "historymemes",
  "animemes",
  "comedycemetery",
  "therewasanattempt",
  "dndmemes",
  "shitposting",
  "whenthe",
  "indonesia",
  "adviceanimals",
  "giphy",
]);

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
    permalink: post.permalink ? (post.permalink.startsWith("http") ? post.permalink : `https://www.reddit.com${post.permalink}`) : "",
    sourceUrl: post.url || "",
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

// ── Pipeline step: fetch candidates ──

async function fetchCandidates({ logger } = {}) {
  const candidates = await discoverTrendingPosts({ logger });

  logger?.info({
    feature: "reddit_sticker",
    discovered: candidates.length,
  }, `Discovered ${candidates.length} posts`);

  return candidates;
}

// ── Pipeline step: process single post ───────────────────────

async function processPost(post, { logger } = {}) {
  const postId = post.id;
  const originalPostId = post.crosspost_parent_list?.[0]?.id || postId;

  // 1. Dedup check by post ID
  const dupById = await isDuplicate({ redditPostId: postId, originalPostId });
  if (dupById) {
    logger?.info(
      { feature: "reddit_sticker", redditPostId: postId },
      `Duplicate post ID: ${postId}`
    );
    return { success: false, reason: "duplicate_post_id" };
  }

  // 2. Resolve media URL
  const media = post._resolvedMedia || resolveMedia(post);
  if (!media) {
    logger?.info(
      { feature: "reddit_sticker", redditPostId: postId },
      `No supported media: ${postId}`
    );
    return { success: false, reason: "no_supported_media" };
  }

  // 3. Download media (with SSRF protection)
  let downloadResult;
  try {
    downloadResult = await downloadMedia(media.mediaUrl);
  } catch (err) {
    logger?.warn(
      { feature: "reddit_sticker", redditPostId: postId, error: String(err.message).slice(0, 100) },
      `Download failed: ${postId}`
    );
    return { success: false, reason: `download_failed_${err.message}` };
  }

  // 4. Dedup check by content hash
  const contentHash = computeHash(downloadResult.buffer);
  const dupByHash = await isDuplicate({ contentHash });
  if (dupByHash) {
    cleanupTempFile(downloadResult.filePath);
    logger?.info(
      { feature: "reddit_sticker", redditPostId: postId, contentHash: contentHash.slice(0, 12) },
      `Duplicate content hash: ${postId}`
    );
    return { success: false, reason: "duplicate_content_hash" };
  }

  // 5. Convert to sticker WebP
  let convertResult;
  try {
    if (isAnimatedMedia(media.mediaType)) {
      convertResult = await convertAnimatedSticker(downloadResult.filePath, {
        durationSeconds: post.media?.reddit_video?.duration || post.secure_media?.reddit_video?.duration,
      });
    } else {
      convertResult = await convertStaticSticker(downloadResult.filePath);
    }
  } catch (err) {
    cleanupTempFile(downloadResult.filePath);
    logger?.warn(
      { feature: "reddit_sticker", redditPostId: postId, error: String(err.message).slice(0, 100) },
      `Conversion failed: ${postId}`
    );
    return { success: false, reason: `conversion_failed_${err.message}` };
  }

  // Clean up download temp file (converted file is saved in permanent sticker dir)
  cleanupTempFile(downloadResult.filePath);

  // 6. Save permanent sticker file
  let savedSticker;
  try {
    savedSticker = saveStickerFile(
      convertResult.buffer,
      convertResult.stickerType
    );
  } catch (err) {
    cleanupTempFile(convertResult.filePath);
    logger?.warn(
      { feature: "reddit_sticker", redditPostId: postId, error: String(err.message).slice(0, 100) },
      `Save file failed: ${postId}`
    );
    return { success: false, reason: `save_failed_${err.message}` };
  }

  // Clean up converter temp file
  cleanupTempFile(convertResult.filePath);

  // 7. Store in Sticker Bank repository
  const stickerRecord = buildStickerRecord(
    post,
    downloadResult,
    { ...convertResult, filePath: savedSticker.filePath, fileSizeBytes: savedSticker.fileSizeBytes }
  );

  try {
    await insertSticker(stickerRecord);
  } catch (err) {
    logger?.warn(
      { feature: "reddit_sticker", redditPostId: postId, error: String(err.message).slice(0, 100) },
      `Repository insert failed: ${postId}`
    );
    return { success: false, reason: `repo_insert_failed_${err.message}` };
  }

  logger?.info({
    feature: "reddit_sticker",
    redditPostId: postId,
    subreddit: post.subreddit,
    mediaType: media.mediaType,
    stickerType: stickerRecord.stickerType,
    fileSizeBytes: savedSticker.fileSizeBytes,
    durationSeconds: stickerRecord.durationSeconds,
    status: "ready",
  }, `Sticker generated: ${postId} (${(savedSticker.fileSizeBytes / 1024).toFixed(1)} KB)`);

  return {
    success: true,
    stickerId: stickerRecord.id,
    postId,
    subreddit: post.subreddit,
    title: post.title,
    fileSizeBytes: savedSticker.fileSizeBytes,
    stickerType: stickerRecord.stickerType,
  };
}

// ── Selection helper ────────────────────────────────────────

function isAutomatedMemeCandidate(post) {
  const subreddit = String(post?.subreddit || "").trim().toLowerCase();
  if (AUTOMATED_MEME_SUBREDDITS.has(subreddit)) return true;

  const text = `${post?.title || ""} ${post?._searchDescription || ""}`;
  return /\b(?:meme|shitpost|reaction|starter\s*pack|funny|lol)\b/i.test(text);
}

function selectDiversePosts(posts, count = posts?.length || 0) {
  const buckets = new Map();
  for (const post of Array.isArray(posts) ? posts : []) {
    const key = String(post?.subreddit || `unknown:${post?.id || buckets.size}`).toLowerCase();
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(post);
  }

  const selected = [];
  let round = 0;
  while (selected.length < Math.max(0, count)) {
    let addedThisRound = false;
    for (const bucket of buckets.values()) {
      if (!bucket[round]) continue;
      selected.push(bucket[round]);
      addedThisRound = true;
      if (selected.length >= count) break;
    }
    if (!addedThisRound) break;
    round += 1;
  }
  return selected;
}

function selectScheduledStickers(stickers, count = 1) {
  return (Array.isArray(stickers) ? stickers : [])
    .filter((sticker) => sticker?.status === "ready")
    .filter((sticker) => {
      if (!sticker?.subreddit && !sticker?.title) return true;
      return isAutomatedMemeCandidate(sticker);
    })
    .slice(0, Math.max(0, count));
}

// ── Full generation cycle ────────────────────────────────────

async function generateStickers({ logger, count = GENERATE_COUNT() } = {}) {
  const targetCount = count || 2;
  logger?.info(
    { feature: "reddit_sticker", target: targetCount },
    "Starting sticker generation"
  );

  const candidates = await fetchCandidates({ logger });
  if (candidates.length === 0) {
    logger?.warn("[Reddit Sticker] No candidates discovered");
    return { generated: 0, attempted: 0 };
  }

  const eligible = filterAndRankPosts(candidates);
  const memeCandidates = eligible.filter(isAutomatedMemeCandidate);
  const pool = memeCandidates.length > 0 ? memeCandidates : eligible;

  const selected = selectDiversePosts(pool, Math.max(targetCount * 2, 4));

  let generated = 0;
  let attempted = 0;

  for (const post of selected) {
    if (generated >= targetCount) break;
    attempted++;

    const result = await processPost(post, { logger });
    if (result.success) {
      generated++;
    }
  }

  logger?.info(
    { feature: "reddit_sticker", generated, attempted },
    `Generation complete: ${generated}/${targetCount} stickers`
  );

  return { generated, attempted };
}

// ── Send scheduled sticker ───────────────────────────────────

async function sendOneSticker(sock, groupJid, { logger } = {}) {
  const count = SEND_COUNT();
  if (count <= 0) return { sent: 0 };

  const ready = await getReadyStickers(count * 2);
  const stickers = selectScheduledStickers(ready, count);

  if (stickers.length === 0) {
    // If bank is empty, generate immediately on-the-fly!
    logger?.info("[Reddit Sticker] No ready stickers in bank — generating on-demand");
    await generateStickers({ logger, count });
    const freshReady = await getReadyStickers(count);
    stickers.push(...selectScheduledStickers(freshReady, count));
  }

  if (stickers.length === 0) {
    logger?.info("[Reddit Sticker] Still no ready stickers available");
    return { sent: 0 };
  }

  let sent = 0;

  for (const sticker of stickers) {
    try {
      const fs = require("fs");
      let buffer = null;
      if (sticker.localPath && fs.existsSync(sticker.localPath)) {
        buffer = fs.readFileSync(sticker.localPath);
      } else if (sticker.mediaUrl) {
        try {
          const dl = await downloadMedia(sticker.mediaUrl);
          const isAnim = isAnimatedMedia(sticker.mediaType);
          const conv = isAnim
            ? await convertAnimatedSticker(dl.filePath)
            : await convertStaticSticker(dl.filePath);
          cleanupTempFile(dl.filePath);
          if (conv?.filePath && fs.existsSync(conv.filePath)) {
            buffer = fs.readFileSync(conv.filePath);
          }
        } catch (dlErr) {
          logger?.warn({ err: String(dlErr.message) }, "[Reddit Sticker] Fallback download failed");
        }
      }

      if (!buffer) {
        await updateStickerStatus(sticker.id, "failed", "file_missing");
        continue;
      }

      await sock.sendMessage(groupJid, { sticker: buffer });
      await markStickerSent(sticker.id);
      sent++;

      logger?.info({
        feature: "reddit_sticker",
        redditPostId: sticker.redditPostId,
        subreddit: sticker.subreddit,
        fileSizeBytes: sticker.fileSizeBytes,
      }, `Sticker sent: ${sticker.redditPostId}`);

      // 2 second gap between stickers
      if (stickers.length > 1) {
        await new Promise((r) => setTimeout(r, 2000));
      }
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

// ── Search + send GIPHY ──────────────────────────────────────

async function searchAndSendGiphy(keyword, sock, remoteJid, { type = "gifs", logger } = {}) {
  const cleanKeyword = String(keyword || "").replace(/[\x00-\x1f]/g, "").trim().slice(0, 100);
  if (!cleanKeyword) {
    throw new Error("Keyword kosong");
  }

  logger?.info({ keyword: cleanKeyword, type }, "[GIPHY Sticker] Search and send");

  const candidates = await fetchGiphyPosts({ query: cleanKeyword, limit: 3, type, logger });
  if (candidates.length === 0) {
    return { success: false, reason: "no_results" };
  }

  for (const candidate of candidates) {
    const result = await processPost(candidate, { logger });
    if (result.success) {
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
            title: candidate.title,
            stickerId: sticker.id,
          };
        }
      }
    }
  }

  return { success: false, reason: "conversion_failed" };
}

// ── Search + send (general) ──────────────────────────────────

async function searchAndSend(keyword, sock, remoteJid, { logger } = {}) {
  const cleanKeyword = String(keyword || "").replace(/[\x00-\x1f]/g, "").trim().slice(0, 100);
  if (!cleanKeyword) {
    throw new Error("Keyword kosong");
  }

  // Try GIPHY first if keyword present
  const giphyResult = await searchAndSendGiphy(cleanKeyword, sock, remoteJid, { type: "gifs", logger });
  if (giphyResult.success) return giphyResult;

  const candidates = await discoverByKeyword(cleanKeyword, { logger });
  if (candidates.length === 0) {
    return { success: false, reason: "no_results" };
  }

  const ranked = filterAndRankPosts(candidates);
  for (const candidate of ranked.slice(0, 3)) {
    const result = await processPost(candidate, { logger });
    if (result.success) {
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
  const parsed = parseRedditPostUrl(urlStr);
  if (!parsed) {
    return { success: false, reason: "invalid_reddit_url" };
  }

  let pageMeta = null;
  try {
    pageMeta = await fetchRedditPageMetadata(urlStr);
  } catch {
    // metadata fetch handles its own errors
  }

  if (pageMeta && !pageMeta.available) {
    return { success: false, reason: "reddit_page_unavailable" };
  }

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
      ? { images: [{ source: { url: pageMeta.ogImage, width: 512, height: 512 }, resolutions: [] }] }
      : null,
    media: null,
    secure_media: null,
    media_metadata: null,
    gallery_data: null,
    crosspost_parent_list: [],
    _source: "reddit_url_import",
  };

  if (!isEligibleRedditPost(post)) {
    return { success: false, reason: "post_not_eligible" };
  }

  let media = resolveMedia(post);
  if (!media?.mediaUrl) {
    if (pageMeta?.ogVideo) {
      const urlCheck = validateMediaUrl(pageMeta.ogVideo);
      if (urlCheck.ok) {
        media = { mediaUrl: urlCheck.url, mediaType: "video" };
      } else {
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
    // Auto-generate 1 on-demand
    await generateStickers({ logger, count: 2 });
    const fresh = await getLeastRecentlySent(1);
    if (fresh.length === 0) {
      return { success: false, reason: "bank_empty" };
    }
    stickers.push(fresh[0]);
  }

  const sticker = stickers[0];
  try {
    const fs = require("fs");
    let buffer = null;
    if (sticker.localPath && fs.existsSync(sticker.localPath)) {
      buffer = fs.readFileSync(sticker.localPath);
    } else if (sticker.mediaUrl) {
      try {
        const dl = await downloadMedia(sticker.mediaUrl);
        const isAnim = isAnimatedMedia(sticker.mediaType);
        const conv = isAnim
          ? await convertAnimatedSticker(dl.filePath)
          : await convertStaticSticker(dl.filePath);
        cleanupTempFile(dl.filePath);
        if (conv?.filePath && fs.existsSync(conv.filePath)) {
          buffer = fs.readFileSync(conv.filePath);
        }
      } catch (dlErr) {
        logger?.warn({ err: String(dlErr.message) }, "[Reddit Sticker] Fallback download for bank sticker failed");
      }
    }

    if (!buffer) {
      await updateStickerStatus(sticker.id, "failed", "file_missing");
      return { success: false, reason: "file_missing" };
    }

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
    logger?.warn({ error: String(err.message).slice(0, 100) }, "[Reddit Sticker] Failed to send bank sticker");
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
  const stickers = await getLeastRecentlySent(1);
  return stickers[0] || null;
}

module.exports = {
  generateStickers,
  sendOneSticker,
  sendReadyFromBank,
  searchAndSend,
  searchAndSendGiphy,
  importFromUrl,
  getBankStats,
  getStickerSource,
  getGenerationKey,
  isSlotGenerated,
  markSlotGenerated,
  fetchCandidates,
  processPost,
  selectScheduledStickers,
  selectDiversePosts,
  isAutomatedMemeCandidate,
  AUTOMATED_MEME_SUBREDDITS,
};
