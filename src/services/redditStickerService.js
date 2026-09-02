// Reddit & GIPHY Sticker Service — orchestrates the full pipeline:
// Discovery (Meme-API + GIPHY) → filter → rank → download → convert → store in Sticker Bank.
// Also handles search, URL import, bank stats, and sender logic.

const crypto = require("crypto");
const {
  discoverTrendingPosts,
  discoverByKeyword,
  fetchGiphyPosts,
  fetchMemeApiPosts,
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
const { addExifToWebp } = require("../utils/exifHelper");

function prepareStickerWithExif(buffer) {
  if (!buffer) return buffer;
  try {
    return addExifToWebp(
      buffer,
      process.env.STICKERIN_BOT_NAME || "yg buat stiker femboy",
      process.env.STICKERIN_AUTHOR || "rtl femboy"
    );
  } catch {
    return buffer;
  }
}

// ── Config ──────────────────────────────────────────────────

const GENERATE_COUNT = () =>
  parseInt(process.env.REDDIT_STICKER_GENERATE_COUNT || "2", 10);
const SEND_COUNT = () =>
  parseInt(process.env.REDDIT_STICKER_SEND_COUNT || "2", 10);
const MAX_CONCURRENT_DOWNLOADS = () =>
  parseInt(process.env.REDDIT_MAX_CONCURRENT_DOWNLOADS || "2", 10);

const AUTOMATED_MEME_SUBREDDITS = new Set([
  "dankmemes",
  "shitposting",
  "whenthe",
  "indonesia",
  "wkwkwkland",
  "aku_ddn",
  "indowibu",
  "okbuddyretard",
  "bikinibottomtwitter",
  "wunkus",
  "hmmm",
  "blurrypicturesofcats",
  "catmemes",
  "reactiongifs",
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
  const stickerType = convertResult.stickerType || (isAnimatedMedia(media.mediaType) ? "animated" : "static");
  let savedSticker;
  try {
    savedSticker = saveStickerFile(
      convertResult.buffer,
      stickerType
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

  const savedFilePath = typeof savedSticker === "string" ? savedSticker : savedSticker?.filePath;
  const savedSizeBytes = typeof savedSticker === "object" && savedSticker?.fileSizeBytes
    ? savedSticker.fileSizeBytes
    : (convertResult.buffer?.length || convertResult.fileSizeBytes || 0);

  // 7. Store in Sticker Bank repository
  const stickerRecord = buildStickerRecord(
    post,
    downloadResult,
    { ...convertResult, stickerType, filePath: savedFilePath, fileSizeBytes: savedSizeBytes }
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
    fileSizeBytes: savedSizeBytes,
    durationSeconds: stickerRecord.durationSeconds,
    status: "ready",
  }, `Sticker generated: ${postId} (${(savedSizeBytes / 1024).toFixed(1)} KB)`);

  return {
    success: true,
    stickerId: stickerRecord.id,
    postId,
    subreddit: post.subreddit,
    title: post.title,
    fileSizeBytes: savedSizeBytes,
    stickerType: stickerRecord.stickerType,
  };
}

const UNUSABLE_STICKER_SUBREDDITS = new Set([
  "trippinthroughtime",
  "bonehurtingjuice",
  "memes",
  "politicalhumor",
  "whitepeopletwitter",
  "blackpeopletwitter",
  "starterpacks",
  "lotrmemes",
  "historymemes",
  "programmerhumor",
  "therewasanattempt",
  "mildlyinfuriating",
  "comedycemetery",
  "terriblefacebookmemes",
  "wholesomememes",
  "funny",
  "funnymemes",
  "animemes",
  "goodanimemes",
  "adviceanimals",
  "dndmemes",
  "comedyheaven",
  "memes_of_the_dank",
  "dank_meme",
  "wordington",
  "me_irl",
]);

function getJakartaHour() {
  const wib = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return wib.getUTCHours();
}

function isDaytimeJakarta() {
  const hour = getJakartaHour();
  // Daytime in WIB: 05:00 to 20:59 (5 AM to 8:59 PM WIB)
  return hour >= 5 && hour < 21;
}

const SLEEP_GREETINGS_PATTERN = /\b(?:good\s*night|goodnight|sleep\s*tight|selamat\s*tidur|sweet\s*dreams|tidur\s*nyenyak|buonanotte|buenas\s*noches|gute\s*nacht)\b/i;
const CHEESY_FOREIGN_GREETINGS_PATTERN = /\b(?:te\s*iubesc|ti\s*amo|te\s*quiero(?:\s*mucho)?|buongiorno|buon\s*compleanno)\b/i;
const KPOP_PATTERN = /\b(?:kpop|k-pop|fancam|blackpink|bts|twice|aespa|newjeans|ive|nct|seventeen|stray\s*kids|exo|itzy|le\s*sserafim|gidle|enhypen|rose\b|jennie\b|jisoo\b|lisa\b)\b/i;
const COMMERCIAL_ADS_PATTERN = /\b(?:wingscorp|official\s*brand|sponsored|advertisement|commercial|promo\b|promosi|travel\s*curry|mie\s*sedaap)\b/i;

function isAutomatedMemeCandidate(post) {
  const subreddit = String(post?.subreddit || "").trim().toLowerCase();
  if (UNUSABLE_STICKER_SUBREDDITS.has(subreddit)) return false;

  const text = `${post?.title || ""} ${post?._searchDescription || ""}`;

  // Reject foreign political cartoons (Trump, Biden, Kamala, etc.) unless local Indonesian context
  if (/\b(?:trump|biden|kamala|democrat|republican|election|parliament|congress|senate)\b/i.test(text) && !/\b(?:indonesia|prabowo|jokowi|gibran)\b/i.test(text)) {
    return false;
  }

  // Reject starter packs, letters, articles, text walls, and infographics that make unreadable stickers
  if (/\b(?:starter\s*pack|starterpack|infographic|letter|article|essay|newspaper|receipt|chart|graph)\b/i.test(text)) {
    return false;
  }

  // Reject cheesy foreign greetings without meme context (e.g. Romanian "Te Iubesc... INFINIT!", Italian "Buon compleanno")
  if (CHEESY_FOREIGN_GREETINGS_PATTERN.test(text)) {
    return false;
  }

  // Reject bedtime/sleeping greetings during daytime WIB (05:00 to 20:59 WIB)
  if (isDaytimeJakarta() && SLEEP_GREETINGS_PATTERN.test(text)) {
    return false;
  }

  // Reject K-Pop / idol fancams and corporate brand advertisements
  if (KPOP_PATTERN.test(text) || KPOP_PATTERN.test(post?.author || "")) {
    return false;
  }
  if (COMMERCIAL_ADS_PATTERN.test(text) || COMMERCIAL_ADS_PATTERN.test(post?.author || "")) {
    return false;
  }

  // Reject non-meme cultural dance and stock footage (e.g. saungbudaya)
  if (/\b(?:saungbudaya|traditional\s*dance|tari\s*tradisional|stock\s*footage)\b/i.test(text) ||
      /\b(?:saungbudaya)\b/i.test(post?.author || "")) {
    return false;
  }

  if (AUTOMATED_MEME_SUBREDDITS.has(subreddit)) return true;

  return /\b(?:meme|shitpost|reaction|funny|kocak|ngakak|wkwk|lucu|lol|jomok|rusdi|jawir|ngawi|ambasing)\b/i.test(text);
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
  const seenAuthors = new Set();
  const selected = [];

  for (const sticker of Array.isArray(stickers) ? stickers : []) {
    if (sticker?.status !== "ready") continue;
    if (sticker?.subreddit || sticker?.title) {
      if (!isAutomatedMemeCandidate(sticker)) continue;
    }
    const author = String(sticker?.author || "").trim().toLowerCase();
    if (author && seenAuthors.has(author)) {
      continue;
    }
    if (author) seenAuthors.add(author);
    selected.push(sticker);
    if (selected.length >= count) break;
  }

  // Fallback if not enough unique authors
  if (selected.length < count) {
    for (const sticker of Array.isArray(stickers) ? stickers : []) {
      if (!selected.includes(sticker) && sticker?.status === "ready") {
        if (!sticker?.subreddit && !sticker?.title) {
          selected.push(sticker);
        } else if (isAutomatedMemeCandidate(sticker)) {
          selected.push(sticker);
        }
        if (selected.length >= count) break;
      }
    }
  }

  return selected.slice(0, Math.max(0, count));
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

  const selected = selectDiversePosts(pool, pool.length);

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
    { feature: "reddit_sticker", generated, attempted, totalCandidates: pool.length },
    `Generation complete: ${generated}/${targetCount} stickers`
  );

  return { generated, attempted };
}

// ── Send scheduled sticker ───────────────────────────────────

async function sendOneSticker(sock, groupJid, { logger, count } = {}) {
  const targetCount = Number.isInteger(count) && count > 0 ? count : SEND_COUNT();
  if (targetCount <= 0) return { sent: 0 };

  const ready = await getReadyStickers(targetCount * 2);
  const stickers = selectScheduledStickers(ready, targetCount);

  if (stickers.length === 0) {
    // If bank is empty, generate immediately on-the-fly!
    logger?.info("[Reddit Sticker] No ready stickers in bank — generating on-demand");
    await generateStickers({ logger, count: targetCount });
    const freshReady = await getReadyStickers(targetCount);
    stickers.push(...selectScheduledStickers(freshReady, targetCount));
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

      await sock.sendMessage(groupJid, { sticker: prepareStickerWithExif(buffer) });
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

const RANDOM_GIF_QUERIES = [
  // Kucing Lucu, Absurd & Hewan Konyol (Sesuai Referensi Pengguna)
  "who me cat",
  "cat meme reaction",
  "cat staring meme",
  "crying cat meme",
  "cat screaming reaction",
  "confused cat reaction",
  "wi fi acting up cat",
  "silly cat dancing",
  "hamster stare meme",
  "doge meme",
  // Reaksi Streamer & Reaksi Absurd Viral (FlightReacts, LeBron, Brick Wall, dll.)
  "flightreacts screaming",
  "talking to a brick wall",
  "lebron james confused",
  "what is bro talking about",
  "shocked face reaction",
  "side eye meme",
  "bruh reaction",
  "facepalm meme",
  "wheezing laugh",
  "crying laughing reaction",
  "spit take reaction",
  "ratio failed meme",
  "gigachad meme",
  "pepe the frog",
  "troll face",
  "spongebob meme reaction",
  "squidward tired meme",
  "patrick star confused",
  "tom and jerry meme",
  "ishowspeed reaction",
  // Tokoh Publik & Komedi Lokal Indonesia
  "prabowo joget",
  "gemoy",
  "jokowi ketawa",
  "windah basudara ngamuk",
  "windah basudara joget",
  "bahlil",
  "gibran",
  "fufufafa",
  "mulyono",
  "meme indonesia",
  "meme bapak bapak",
  "ngakak kocak",
  "lucu ngakak",
  // Komedi Jomok, Ngawi & Absurd Brainrot
  "jomok",
  "rusdi",
  "rusdi ngawi",
  "si imut",
  "jawir",
  "meme jawir",
  "ambasing",
  "ngawi",
  "ironi",
  "kak gem",
  "skibidi",
  "mewing",
];

const RANDOM_STICKER_QUERIES = [
  // Reaksi Stiker Transparan & Cutout (WhatsApp-friendly, Absurd & Lucu)
  "cat who me sticker",
  "cat reaction sticker",
  "silly cat sticker",
  "staring cat sticker",
  "crying cat sticker",
  "shocked cat sticker",
  "confused cat sticker",
  "wi fi acting up cat sticker",
  "popcat sticker",
  "hamster stare sticker",
  "doge sticker",
  // Reaksi Ekspresi Viral & Kartun Slapstick
  "flightreacts sticker",
  "talking to a brick wall sticker",
  "lebron james confused sticker",
  "what is bro talking about sticker",
  "side eye sticker",
  "facepalm sticker",
  "laughing sticker",
  "crying laughing sticker",
  "wheezing laugh sticker",
  "ratio failed sticker",
  "confused sticker",
  "sus sticker",
  "pepe sticker",
  "pepe cry sticker",
  "spongebob sticker",
  "patrick star sticker",
  "squidward sticker",
  "tom and jerry sticker",
  "angry birds pig sticker",
  "gigachad sticker",
  "awkward smile sticker",
  "meme reaction transparent",
  // Stiker Tokoh, Meme Lokal & Stiker WA Indonesia
  "meme indonesia sticker",
  "stiker wa kocak",
  "stiker ngakak",
  "meme bapak bapak sticker",
  "prabowo gemoy sticker",
  "jokowi sticker",
  "gibran sticker",
  "bahlil sticker",
  "windah basudara sticker",
  "jomok sticker",
  "rusdi sticker",
  "rusdi ngawi sticker",
  "si imut sticker",
  "jawir sticker",
  "ambasing sticker",
  "waduh sticker",
  "siap komandan sticker",
];

const CURATED_REACTION_FALLBACKS = [
  "who me cat",
  "cat meme reaction",
  "flightreacts screaming",
  "lebron james confused",
  "shocked face meme",
  "side eye meme",
  "laughing hard meme",
  "sus meme",
  "wheezing laugh",
  "crying meme",
  "facepalm meme",
  "spongebob funny reaction",
  "meme indonesia",
  "rusdi ngawi",
  "pepe reaction",
  "gigachad meme",
];

const CURATED_STICKER_FALLBACKS = [
  "cat who me sticker",
  "cat reaction sticker",
  "flightreacts sticker",
  "lebron james confused sticker",
  "spongebob sticker",
  "patrick star sticker",
  "side eye sticker",
  "laughing sticker",
  "crying sticker",
  "facepalm sticker",
  "gigachad sticker",
  "doge sticker",
  "pepe sticker",
  "meme reaction transparent",
  "stiker wa kocak",
];

const GIPHY_SLANG_SYNONYMS = {
  esempeh: "jomok",
  smp: "jomok",
  "bocah smp": "jomok",
  "anak smp": "jomok",
  "puding hambali": "jomok",
  hambali: "jomok",
  "pop mie": "jomok",
  "pop mie pop mie": "jomok",
  "mas rusdi": "rusdi",
  "pak rusdi": "rusdi",
  ironi: "jomok",
  ambas: "ambasing",
};

async function searchAndSendGiphy(keyword, sock, remoteJid, { type = "gifs", logger } = {}) {
  const isProactiveRandom = !keyword || !String(keyword).trim();
  const list = type === "stickers" ? RANDOM_STICKER_QUERIES : RANDOM_GIF_QUERIES;
  const maxAttempts = isProactiveRandom ? 3 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let cleanKeyword = String(keyword || "").replace(/[\x00-\x1f]/g, "").trim().slice(0, 100);
    if (!cleanKeyword) {
      cleanKeyword = list[Math.floor(Math.random() * list.length)];
    }

    logger?.info({ keyword: cleanKeyword, type, attempt: attempt + 1 }, "[GIPHY Sticker] Search and send");

    let candidates = await fetchGiphyPosts({
      query: cleanKeyword,
      limit: 8,
      type,
      randomOffset: isProactiveRandom,
      maxRandomOffset: 6,
      logger,
    });

    if (candidates.length === 0 && !isProactiveRandom) {
      const synonym = GIPHY_SLANG_SYNONYMS[cleanKeyword.toLowerCase()];
      if (synonym) {
        logger?.info({ original: cleanKeyword, fallback: synonym }, "[GIPHY Sticker] Fallback to slang synonym");
        candidates = await fetchGiphyPosts({
          query: synonym,
          limit: 8,
          type,
          offset: 0,
          randomOffset: false,
          logger,
        });
      }
    }

    if (candidates.length === 0) {
      continue;
    }

    for (const candidate of candidates) {
      if (isProactiveRandom && !isAutomatedMemeCandidate(candidate)) {
        logger?.info({ id: candidate.id, title: candidate.title }, "[GIPHY Sticker] Proactive check rejected unusable candidate");
        continue;
      }

      // Always filter K-pop unless user explicitly searched for K-pop
      const isExplicitKpop = /\b(?:kpop|k-pop|fancam|blackpink|bts|twice|aespa|newjeans|ive)\b/i.test(cleanKeyword);
      if (!isExplicitKpop && (KPOP_PATTERN.test(candidate.title || "") || KPOP_PATTERN.test(candidate.author || ""))) {
        logger?.info({ id: candidate.id, title: candidate.title }, "[GIPHY Sticker] Rejected K-pop candidate");
        continue;
      }

      // Always filter corporate brand ads unless user explicitly searched for it
      const isExplicitBrand = /\b(?:wingscorp|mie\s*sedaap)\b/i.test(cleanKeyword);
      if (!isExplicitBrand && (COMMERCIAL_ADS_PATTERN.test(candidate.title || "") || COMMERCIAL_ADS_PATTERN.test(candidate.author || ""))) {
        logger?.info({ id: candidate.id, title: candidate.title }, "[GIPHY Sticker] Rejected commercial ad candidate");
        continue;
      }

      const result = await processPost(candidate, { logger });
      if (result.success) {
        const sticker = await getStickerById(result.stickerId);
        if (sticker && sticker.localPath) {
          const fs = require("fs");
          if (fs.existsSync(sticker.localPath)) {
            const buffer = fs.readFileSync(sticker.localPath);
            await sock.sendMessage(remoteJid, { sticker: prepareStickerWithExif(buffer) });
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
  }

  // If specific query failed, try curated reaction fallback instead of raw empty trending
  if (isProactiveRandom) {
    const fallbackList = type === "stickers" ? CURATED_STICKER_FALLBACKS : CURATED_REACTION_FALLBACKS;
    const fallbackQuery = fallbackList[Math.floor(Math.random() * fallbackList.length)];
    logger?.info({ type, fallbackQuery }, "[GIPHY Sticker] Trying curated reaction fallback");
    const fallbackCandidates = await fetchGiphyPosts({
      query: fallbackQuery,
      limit: 8,
      type,
      randomOffset: true,
      maxRandomOffset: 30,
      logger,
    });
    for (const candidate of fallbackCandidates) {
      if (!isAutomatedMemeCandidate(candidate)) continue;
      const result = await processPost(candidate, { logger });
      if (result.success) {
        const sticker = await getStickerById(result.stickerId);
        if (sticker && sticker.localPath) {
          const fs = require("fs");
          if (fs.existsSync(sticker.localPath)) {
            const buffer = fs.readFileSync(sticker.localPath);
            await sock.sendMessage(remoteJid, { sticker: prepareStickerWithExif(buffer) });
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
  }

  return { success: false, reason: "conversion_failed" };
}

// ── Search Reddit meme specifically (Meme-API + Bank) ────────

async function searchAndSendRedditMeme(keyword, sock, remoteJid, { logger } = {}) {
  const cleanKeyword = String(keyword || "").replace(/[\x00-\x1f]/g, "").trim().slice(0, 100);

  // 1. Fetch fresh meme candidates from Meme-API
  let candidates = [];
  try {
    const memePosts = await fetchMemeApiPosts({ logger, countPerSubreddit: 4 });
    if (cleanKeyword) {
      const kwLower = cleanKeyword.toLowerCase();
      const matched = memePosts.filter((p) => (p.title || "").toLowerCase().includes(kwLower));
      candidates = matched.length > 0 ? matched : memePosts;
    } else {
      candidates = memePosts;
    }
  } catch (err) {
    logger?.warn({ err: err?.message }, "[Reddit Meme] Meme-API fetch error");
  }

  // 2. Process candidate and send
  if (candidates.length > 0) {
    const eligible = filterAndRankPosts(candidates);
    const memeCandidates = eligible.filter(isAutomatedMemeCandidate);
    const pool = memeCandidates.length > 0 ? memeCandidates : eligible;

    for (const candidate of pool.slice(0, 4)) {
      const result = await processPost(candidate, { logger });
      if (result.success) {
        const sticker = await getStickerById(result.stickerId);
        if (sticker && sticker.localPath) {
          const fs = require("fs");
          if (fs.existsSync(sticker.localPath)) {
            const buffer = fs.readFileSync(sticker.localPath);
            await sock.sendMessage(remoteJid, { sticker: prepareStickerWithExif(buffer) });
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
  }

  // 3. Fallback to ready sticker from database bank
  const bankResult = await sendOneSticker(sock, remoteJid, { logger, count: 1 });
  if (bankResult?.sent > 0) {
    return { success: true, source: "bank" };
  }

  return { success: false, reason: "no_candidates" };
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
          await sock.sendMessage(remoteJid, { sticker: prepareStickerWithExif(buffer) });
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
      await sock.sendMessage(remoteJid, { sticker: prepareStickerWithExif(buffer) });
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

// ── Send fresh sticker (on-demand or bank) ───────────────────

async function sendReadyFromBank(sock, remoteJid, { logger } = {}) {
  // 1. Check for any un-sent ready stickers in bank first
  const ready = await getReadyStickers(5);
  const unSent = (ready || []).filter((s) => s.status === "ready" && (!s.sentCount || s.sentCount === 0));

  let stickerToSend = null;

  if (unSent.length > 0) {
    stickerToSend = unSent[Math.floor(Math.random() * unSent.length)];
  } else {
    // 2. Bank has no un-sent stickers -> generate brand new ones directly from Meme-API & GIPHY!
    logger?.info("[Fresh Meme] Fetching brand new meme candidates on-demand");
    const candidates = await discoverTrendingPosts({ logger });
    const eligible = filterAndRankPosts(candidates);

    for (const post of eligible) {
      const res = await processPost(post, { logger });
      if (res.success) {
        const fresh = await getStickerById(res.stickerId);
        if (fresh) {
          stickerToSend = fresh;
          break;
        }
      }
    }
  }

  if (!stickerToSend) {
    return { success: false, reason: "no_fresh_candidates" };
  }

  try {
    const fs = require("fs");
    let buffer = null;
    if (stickerToSend.localPath && fs.existsSync(stickerToSend.localPath)) {
      buffer = fs.readFileSync(stickerToSend.localPath);
    } else if (stickerToSend.mediaUrl) {
      try {
        const dl = await downloadMedia(stickerToSend.mediaUrl);
        const isAnim = isAnimatedMedia(stickerToSend.mediaType);
        const conv = isAnim
          ? await convertAnimatedSticker(dl.filePath)
          : await convertStaticSticker(dl.filePath);
        cleanupTempFile(dl.filePath);
        if (conv?.filePath && fs.existsSync(conv.filePath)) {
          buffer = fs.readFileSync(conv.filePath);
        }
      } catch (dlErr) {
        logger?.warn({ err: String(dlErr.message) }, "[Fresh Meme] Fallback download failed");
      }
    }

    if (!buffer) {
      await updateStickerStatus(stickerToSend.id, "failed", "file_missing");
      return { success: false, reason: "file_missing" };
    }

    await sock.sendMessage(remoteJid, { sticker: prepareStickerWithExif(buffer) });
    await markStickerSent(stickerToSend.id);

    logger?.info({
      feature: "reddit_sticker",
      redditPostId: stickerToSend.redditPostId,
      subreddit: stickerToSend.subreddit,
    }, `Sent fresh sticker: ${stickerToSend.redditPostId}`);

    return {
      success: true,
      postId: stickerToSend.redditPostId,
      subreddit: stickerToSend.subreddit,
      title: stickerToSend.title,
      stickerId: stickerToSend.id,
    };
  } catch (err) {
    logger?.warn({ error: String(err.message).slice(0, 100) }, "[Fresh Meme] Failed to send sticker");
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
  searchAndSendRedditMeme,
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
  UNUSABLE_STICKER_SUBREDDITS,
  CURATED_REACTION_FALLBACKS,
  CURATED_STICKER_FALLBACKS,
  isDaytimeJakarta,
  SLEEP_GREETINGS_PATTERN,
  CHEESY_FOREIGN_GREETINGS_PATTERN,
  KPOP_PATTERN,
  COMMERCIAL_ADS_PATTERN,
};
