// Reddit Sticker Bank commands.
// Prefix is read from the existing router — no hardcoded prefix.
//
// Commands (both naming conventions supported):
//   reddit / meme           — Send one sticker from the bank
//   reddit <kw> / meme <kw> — Search Reddit for keyword, convert, send
//   reddit <url> / meme <url> — Import media from a Reddit post URL
//   rbank / memebank        — Show sticker bank stats
//   rrefresh / memerefresh  — Admin: run generator manually
//   rmode / mememode on/off — Admin: toggle scheduled sender
//   rsource / memesource    — Show source (permalink) of last sticker
//   rtest / memetest        — Admin: diagnostic test

const {
  sendReadyFromBank,
  searchAndSend,
  searchAndSendGiphy,
  searchAndSendRedditMeme,
  importFromUrl,
  getBankStats,
  getStickerSource,
  generateStickers,
} = require("../services/redditStickerService");
const { parseRedditPostUrl } = require("../utils/redditUrlParser");
const { addExifToWebp } = require("../utils/exifHelper");

// Scheduled-sender toggle — in-memory, resets on restart
let cronSenderEnabled = process.env.REDDIT_STICKER_CRON_ENABLED !== "false";

function isCronSenderEnabled() {
  return cronSenderEnabled;
}

function toggleCronSender(enable) {
  cronSenderEnabled = !!enable;
}

// All command names are normalized to canonical names for routing
const CANONICAL_MAP = {
  reddit: "reddit", meme: "reddit", rmeme: "reddit",
  gif: "gif", giphy: "gif",
  sgif: "sgif", sgiphy: "sgif", gsticker: "sgif", gstick: "sgif",
  rbank: "rbank", memebank: "rbank",
  rrefresh: "rrefresh", memerefresh: "rrefresh",
  rmode: "rmode", mememode: "rmode",
  rsource: "rsource", memesource: "rsource",
  rtest: "rtest", memetest: "rtest",
};

module.exports = {
  names: [
    "reddit", "meme", "rmeme",
    "gif", "giphy", "sgif", "sgiphy", "gsticker", "gstick",
    "rbank", "memebank",
    "rrefresh", "memerefresh",
    "rmode", "mememode",
    "rsource", "memesource",
    "rtest", "memetest",
  ],

  isCronSenderEnabled,
  toggleCronSender,
  handleGiphySearch,
  handleSearch,
  handleDualSearch,

  async execute({
    sock,
    msg,
    args,
    cmdName,
    remoteJid,
    logger,
    PREFIX,
  }) {
    // Map to canonical command name
    const canonical = CANONICAL_MAP[cmdName] || cmdName;

    const OWNER_JID = process.env.OWNER_JID || "";
    const isOwner =
      OWNER_JID &&
      (remoteJid === OWNER_JID || msg.key.participant === OWNER_JID);
    const isGroup = remoteJid.endsWith("@g.us");
    const isAdmin = isGroup && msg.key.fromMe;
    const isPrivileged = Boolean(msg.key?.fromMe || isOwner || isAdmin);

    // ── rbank / memebank ──────────────────────────────
    if (canonical === "rbank") {
      await handleBank(sock, msg, remoteJid, logger);
      return;
    }

    // ── rrefresh / memerefresh ─────────────────────────
    if (canonical === "rrefresh") {
      if (!isPrivileged) {
        await sock.sendMessage(remoteJid, {
          text: "⚠️ Command ini hanya untuk admin/owner.",
        }, { quoted: msg });
        return;
      }
      await handleRefresh(sock, msg, remoteJid, logger);
      return;
    }

    // ── rmode / mememode ───────────────────────────────
    if (canonical === "rmode") {
      if (!isPrivileged) {
        await sock.sendMessage(remoteJid, {
          text: "⚠️ Command ini hanya untuk admin/owner.",
        }, { quoted: msg });
        return;
      }
      await handleMode(sock, msg, args, remoteJid, logger);
      return;
    }

    // ── rsource / memesource ───────────────────────────
    if (canonical === "rsource") {
      await handleSource(sock, msg, remoteJid, logger);
      return;
    }

    // ── rtest / memetest ───────────────────────────────
    if (canonical === "rtest") {
      if (!isPrivileged) {
        await sock.sendMessage(remoteJid, {
          text: "⚠️ Command ini hanya untuk admin/owner.",
        }, { quoted: msg });
        return;
      }
      await handleTest(sock, msg, remoteJid, logger);
      return;
    }

    // ── gif / giphy (Unified dual search: GIPHY + Reddit) ──
    if (canonical === "gif") {
      const query = args.join(" ").trim();
      await handleDualSearch(query, sock, msg, remoteJid, logger);
      return;
    }

    // ── sgif (Transparent cutout sticker search) ──────
    if (canonical === "sgif") {
      const query = args.join(" ").trim();
      await handleGiphySearch(query, "stickers", sock, msg, remoteJid, logger);
      return;
    }

    // ── reddit / meme / rmeme (Unified dual search) ───
    const input = args.join(" ").trim();

    if (!input) {
      // No args → send dual fresh stickers (1 GIPHY + 1 Reddit)
      await handleDualSearch("", sock, msg, remoteJid, logger);
      return;
    }

    // Check if input is a Reddit URL (using strict parser)
    if (parseRedditPostUrl(input)) {
      await handleUrlImport(input, sock, msg, remoteJid, logger);
      return;
    }

    // Otherwise, treat as dual keyword search (GIPHY + Reddit)
    await handleDualSearch(input, sock, msg, remoteJid, logger);
  },
};

// ── Command handlers ─────────────────────────────────────

async function handleDualSearch(keyword, sock, msg, remoteJid, logger) {
  const cleanKeyword = String(keyword || "").trim();
  const searchMsg = cleanKeyword
    ? `🔍 Mencari stiker "${cleanKeyword}" (GIPHY & Reddit)...`
    : `🔍 Mengambil stiker terbaru (GIPHY & Reddit)...`;

  await sock.sendMessage(remoteJid, { text: searchMsg }, { quoted: msg });

  // 1. Send Animated GIF Sticker from GIPHY
  let giphySuccess = false;
  try {
    const giphyRes = await searchAndSendGiphy(cleanKeyword, sock, remoteJid, { type: "gifs", logger });
    if (giphyRes?.success) {
      giphySuccess = true;
      logger?.info({ chat: remoteJid, postId: giphyRes.postId }, "✅ GIPHY sticker sent (1/2)");
    }
  } catch (err) {
    logger?.warn({ err: err?.message }, "[Dual Search] GIPHY send failed");
  }

  // 1.5s gap between sends to prevent WhatsApp dropping concurrent media
  await new Promise((r) => setTimeout(r, 1500));

  // 2. Send Photo Meme Sticker from Reddit (Meme-API)
  let redditSuccess = false;
  try {
    const redditRes = await searchAndSendRedditMeme(cleanKeyword, sock, remoteJid, { logger });
    if (redditRes?.success) {
      redditSuccess = true;
      logger?.info({ chat: remoteJid }, "✅ Reddit meme sticker sent (2/2)");
    }
  } catch (err) {
    logger?.warn({ err: err?.message }, "[Dual Search] Reddit send failed");
  }

  if (!giphySuccess && !redditSuccess) {
    await sock.sendMessage(remoteJid, {
      text: cleanKeyword
        ? `❌ Tidak ditemukan stiker untuk "${cleanKeyword}". Coba kata kunci lain.`
        : `❌ Gagal mengambil stiker. Coba lagi sebentar.`,
    }, { quoted: msg });
  }
}

async function handleGiphySearch(keyword, type, sock, msg, remoteJid, logger) {
  const typeLabel = type === "stickers" ? "stiker transparan" : "animasi GIF";
  const searchMsg = keyword
    ? `🔍 Mencari ${typeLabel} "${keyword}" di GIPHY...`
    : `🔍 Mengambil ${typeLabel} meme terbaru dari GIPHY...`;

  await sock.sendMessage(remoteJid, { text: searchMsg }, { quoted: msg });

  try {
    const result = await searchAndSendGiphy(keyword, sock, remoteJid, { type, logger });
    if (!result.success) {
      await sock.sendMessage(remoteJid, {
        text: keyword
          ? `❌ Tidak ditemukan ${typeLabel} untuk "${keyword}". Coba kata kunci lain.`
          : `❌ Gagal mengambil ${typeLabel} dari GIPHY. Coba lagi sebentar.`,
      }, { quoted: msg });
    } else {
      logger?.info({ chat: remoteJid, postId: result.postId, title: result.title }, "✅ GIPHY sticker sent");
    }
  } catch (err) {
    logger?.error({ err }, "GIPHY sticker error");
    await sock.sendMessage(remoteJid, {
      text: "❌ Gagal mencari di GIPHY. Coba lagi.",
    }, { quoted: msg });
  }
}

async function handleSendFromBank(sock, msg, remoteJid, logger) {
  return handleDualSearch("", sock, msg, remoteJid, logger);
}

async function handleSearch(keyword, sock, msg, remoteJid, logger) {
  return handleDualSearch(keyword, sock, msg, remoteJid, logger);
}

async function handleUrlImport(urlStr, sock, msg, remoteJid, logger) {
  await sock.sendMessage(remoteJid, {
    text: "⏳ Mengimpor media dari Reddit...",
  }, { quoted: msg });

  try {
    const result = await importFromUrl(urlStr, sock, remoteJid, { logger });
    if (!result.success) {
      const reasonMessages = {
        invalid_reddit_url: "❌ URL Reddit tidak valid.",
        post_not_found: "❌ Post tidak ditemukan (mungkin dihapus atau private).",
        post_not_eligible: "⚠️ Post tidak memenuhi syarat (NSFW/spoiler/teks).",
        no_supported_media: "Media Reddit ini tidak dapat dijadikan stiker.",
        conversion_failed: "❌ Gagal mengonversi media menjadi stiker.",
        unsupported_external_host: "❌ Host eksternal tidak didukung.",
      };
      await sock.sendMessage(remoteJid, {
        text: reasonMessages[result.reason] || `❌ Gagal: ${result.reason}`,
      }, { quoted: msg });
    } else {
      logger?.info({ chat: remoteJid, postId: result.postId }, "✅ URL import sticker sent");
    }
  } catch (err) {
    logger?.error({ err }, "URL import error");
    await sock.sendMessage(remoteJid, {
      text: "❌ Gagal mengimpor dari Reddit.",
    }, { quoted: msg });
  }
}

async function handleBank(sock, msg, remoteJid, logger) {
  try {
    const stats = await getBankStats();
    const lines = [
      "🎭 *REDDIT STICKER BANK*",
      "",
      `📦 Static ready: *${stats.ready || 0}*`,
      `🎬 Animated ready: *${stats.ready || 0}*`,
      `📤 Sent today: *${stats.sentToday || 0}*`,
      `❌ Failed: *${stats.failed || 0}*`,
      `📊 Total: *${stats.total || 0}*`,
      "",
      `_Scheduled sender: ${isCronSenderEnabled() ? "✅ ON" : "⛔ OFF"}_`,
    ];
    await sock.sendMessage(remoteJid, { text: lines.join("\n") }, { quoted: msg });
  } catch (err) {
    logger?.error({ err }, "Bank stats error");
    await sock.sendMessage(remoteJid, { text: "❌ Gagal membaca Sticker Bank." }, { quoted: msg });
  }
}

async function handleRefresh(sock, msg, remoteJid, logger) {
  await sock.sendMessage(remoteJid, { text: "🔄 Menjalankan generator stiker..." }, { quoted: msg });

  try {
    const result = await generateStickers({ logger });
    await sock.sendMessage(remoteJid, {
      text: `✅ Generator selesai!\n\n📦 Dibuat: *${result.generated}*\n🔄 Dicoba: *${result.attempted}*`,
    }, { quoted: msg });
    logger?.info(result, "Manual refresh complete");
  } catch (err) {
    logger?.error({ err }, "Manual refresh error");
    await sock.sendMessage(remoteJid, { text: "❌ Generator gagal." }, { quoted: msg });
  }
}

async function handleMode(sock, msg, args, remoteJid, logger) {
  const mode = args[0]?.toLowerCase();

  if (mode === "on") {
    toggleCronSender(true);
    await sock.sendMessage(remoteJid, { text: "✅ Reddit scheduled sender: *ON*" }, { quoted: msg });
  } else if (mode === "off") {
    toggleCronSender(false);
    await sock.sendMessage(remoteJid, { text: "⛔ Reddit scheduled sender: *OFF*" }, { quoted: msg });
  } else {
    await sock.sendMessage(remoteJid, {
      text: `🎭 Reddit scheduled sender: *${isCronSenderEnabled() ? "ON" : "OFF"}*\n\nGunakan: *!rmode on* atau *!rmode off*`,
    }, { quoted: msg });
  }
}

async function handleSource(sock, msg, remoteJid, logger) {
  try {
    const sticker = await getStickerSource();
    if (!sticker) {
      await sock.sendMessage(remoteJid, { text: "🎭 Belum ada stiker yang dikirim." }, { quoted: msg });
      return;
    }

    const lines = [
      "🎭 *SUMBER STIKER*",
      "",
      `📌 *${sticker.title || "Tanpa judul"}*`,
      `👤 u/${sticker.author || "?"}`,
      `📂 r/${sticker.subreddit || "?"}`,
      `🔗 ${sticker.sourceUrl || "N/A"}`,
      `⭐ ${sticker.score} (${Math.round((sticker.upvoteRatio || 0) * 100)}%)`,
      `📤 Dikirim: ${sticker.sentCount}x`,
    ];
    await sock.sendMessage(remoteJid, { text: lines.join("\n") }, { quoted: msg });
  } catch (err) {
    logger?.error({ err }, "Source error");
    await sock.sendMessage(remoteJid, { text: "❌ Gagal membaca sumber." }, { quoted: msg });
  }
}

async function handleTest(sock, msg, remoteJid, logger) {
  await sock.sendMessage(remoteJid, { text: "🧪 *Reddit Sticker Test*\n\nMenguji pipeline via You.com..." }, { quoted: msg });

  const results = [];
  const startMs = Date.now();

  try {
    // 1. Test You.com discovery
    const {
      discoverTrendingPosts,
      searchReddit,
    } = require("../services/redditStickerDiscovery");
    const {
      resolveMedia,
      filterAndRankPosts,
      isEligibleRedditPost,
    } = require("../services/redditMediaResolver");
    const { downloadMedia, cleanupTempFile } = require("../services/redditMediaDownloader");
    const {
      convertStaticSticker,
      convertAnimatedSticker,
      isAnimatedMedia,
    } = require("../services/redditMediaConverter");

    // Test discovery connectivity
    let testPost = null;

    try {
      const candidates = await discoverTrendingPosts({ logger });
      results.push(`🔍 Discovery: ${candidates.length} Reddit posts found`);

      if (candidates.length > 0) {
        // Filter and rank
        const ranked = filterAndRankPosts(candidates);
        results.push(`📊 Eligible after filter: ${ranked.length}`);

        // Find one static candidate for conversion test
        for (const p of ranked) {
          const media = resolveMedia(p);
          if (media && !isAnimatedMedia(media.mediaType)) {
            testPost = p;
            testPost._resolvedMedia = media;
            break;
          }
        }

        if (!testPost) {
          // Try any candidate with media
          for (const p of ranked) {
            const media = resolveMedia(p);
            if (media) {
              testPost = p;
              testPost._resolvedMedia = media;
              break;
            }
          }
        }
      } else {
        results.push("⚠️ Discovery returned 0 results — trying single query");
        const fallbackResults = await searchReddit(
          "site:reddit.com/r/memes/comments popular meme",
          { logger }
        );
        results.push(`🔍 Fallback query: ${fallbackResults.length} results`);

        if (fallbackResults.length > 0) {
          const ranked = filterAndRankPosts(fallbackResults);
          for (const p of ranked) {
            const media = resolveMedia(p);
            if (media) {
              testPost = p;
              testPost._resolvedMedia = media;
              break;
            }
          }
        }
      }
    } catch (err) {
      results.push(`❌ Discovery error: ${String(err.message).slice(0, 50)}`);
    }

    if (!testPost) {
      results.push("⚠️ No test post found — discovery may be empty");
      await sock.sendMessage(remoteJid, {
        text: `🧪 *HASIL TEST*\n\n${results.join("\n")}\n\n_Tidak ada kandidat untuk uji konversi._`,
      }, { quoted: msg });
      return;
    }

    // Static conversion test
    const media = testPost._resolvedMedia;
    let dlResult = null;
    try {
      dlResult = await downloadMedia(media.mediaUrl);
      const conv = await convertStaticSticker(dlResult.buffer);

      results.push(
        `✅ *Static:* ${conv.fileSizeBytes} bytes | ${testPost.subreddit || "?"}`
      );

      // Send test sticker (does not count toward sent count)
      await sock.sendMessage(remoteJid, { sticker: addExifToWebp(conv.buffer) });
    } catch (err) {
      results.push(`❌ Static: ${String(err.message).slice(0, 50)}`);
    } finally {
      if (dlResult) cleanupTempFile(dlResult.filePath);
    }

    // Check for animated candidate
    const candidates = await discoverTrendingPosts({ logger }).catch(() => []);
    let animatedFound = false;
    for (const p of filterAndRankPosts(candidates)) {
      const m = resolveMedia(p);
      if (m && isAnimatedMedia(m.mediaType)) {
        animatedFound = true;
        results.push(`🎬 Animated candidate: r/${p.subreddit || "?"} (${m.mediaType})`);
        break;
      }
    }
    if (!animatedFound) {
      results.push("🎬 Animated: tidak ada kandidat (wajar jika tidak ditemukan)");
    }

    const latencyMs = Date.now() - startMs;
    results.push(`⏱️ Latency: ${latencyMs}ms`);

    await sock.sendMessage(remoteJid, {
      text: `🧪 *HASIL TEST*\n\n${results.join("\n")}\n\n_Tidak menandai slot scheduler selesai. Tidak menambah sent count. Tidak menyimpan credential._`,
    }, { quoted: msg });

    logger?.info({ results, latencyMs }, "Reddit test complete (You.com discovery)");
  } catch (err) {
    logger?.error({ err }, "Reddit test error");
    await sock.sendMessage(remoteJid, {
      text: `❌ Test gagal: ${String(err.message).slice(0, 200)}`,
    }, { quoted: msg });
  }
}
