// Reddit Sticker Bank commands.
// Prefix is read from the existing router — no hardcoded prefix.
//
// Commands:
//   reddit         — Send one sticker from the bank
//   reddit <kw>    — Search Reddit for keyword, convert, and send
//   reddit <url>   — Import media from a Reddit post URL
//   rbank          — Show sticker bank stats
//   rrefresh       — Admin: run generator manually
//   rmode on/off   — Admin: toggle cron sender
//   rsource        — Show source (permalink) of last sticker
//   rtest          — Admin: diagnostic test (1 static + 1 animated)

const {
  sendReadyFromBank,
  searchAndSend,
  importFromUrl,
  getBankStats,
  getStickerSource,
  generateStickers,
} = require("../services/redditStickerService");

// Cron mode toggle — in-memory, resets on restart
let cronSenderEnabled = process.env.REDDIT_STICKER_CRON_ENABLED !== "false";

function isCronSenderEnabled() {
  return cronSenderEnabled;
}

function toggleCronSender(enable) {
  cronSenderEnabled = !!enable;
}

module.exports = {
  names: [
    "reddit",
    "rbank",
    "rrefresh",
    "rmode",
    "rsource",
    "rtest",
  ],

  isCronSenderEnabled,
  toggleCronSender,

  async execute({
    sock,
    msg,
    args,
    cmdName,
    remoteJid,
    logger,
    PREFIX,
  }) {
    const OWNER_JID = process.env.OWNER_JID || "";
    const isOwner =
      OWNER_JID &&
      (remoteJid === OWNER_JID || msg.key.participant === OWNER_JID);
    const isGroup = remoteJid.endsWith("@g.us");
    const isAdmin = isGroup && msg.key.fromMe;
    const isPrivileged = isOwner || isAdmin;

    // ── rbank ──────────────────────────────────────────
    if (cmdName === "rbank") {
      await handleBank(sock, msg, remoteJid, logger);
      return;
    }

    // ── rrefresh ───────────────────────────────────────
    if (cmdName === "rrefresh") {
      if (!isPrivileged) {
        await sock.sendMessage(remoteJid, {
          text: "⚠️ Command ini hanya untuk admin/owner.",
        }, { quoted: msg });
        return;
      }
      await handleRefresh(sock, msg, remoteJid, logger);
      return;
    }

    // ── rmode ──────────────────────────────────────────
    if (cmdName === "rmode") {
      if (!isPrivileged) {
        await sock.sendMessage(remoteJid, {
          text: "⚠️ Command ini hanya untuk admin/owner.",
        }, { quoted: msg });
        return;
      }
      await handleMode(sock, msg, args, remoteJid, logger);
      return;
    }

    // ── rsource ────────────────────────────────────────
    if (cmdName === "rsource") {
      await handleSource(sock, msg, remoteJid, logger);
      return;
    }

    // ── rtest ──────────────────────────────────────────
    if (cmdName === "rtest") {
      if (!isPrivileged) {
        await sock.sendMessage(remoteJid, {
          text: "⚠️ Command ini hanya untuk admin/owner.",
        }, { quoted: msg });
        return;
      }
      await handleTest(sock, msg, remoteJid, logger);
      return;
    }

    // ── reddit (main command) ───────────────────────────
    const input = args.join(" ").trim();

    if (!input) {
      // No args → send one from bank
      await handleSendFromBank(sock, msg, remoteJid, logger);
      return;
    }

    // Check if input is a Reddit URL
    const { parseRedditUrl } = require("../services/redditService");
    if (parseRedditUrl(input)) {
      await handleUrlImport(input, sock, msg, remoteJid, logger);
      return;
    }

    // Otherwise, treat as keyword search
    await handleSearch(input, sock, msg, remoteJid, logger);
  },
};

// ── Command handlers ─────────────────────────────────────

async function handleSendFromBank(sock, msg, remoteJid, logger) {
  await sock.sendMessage(remoteJid, { text: "🎭 Mencari stiker Reddit..." }, { quoted: msg });

  try {
    const result = await sendReadyFromBank(sock, remoteJid, { logger });
    if (!result.success) {
      await sock.sendMessage(remoteJid, {
        text: "🎭 Sticker Bank kosong. Gunakan *!reddit <keyword>* untuk mencari, atau tunggu generator cron mengisi ulang.",
      }, { quoted: msg });
    }
    logger?.info({ chat: remoteJid, postId: result.postId }, "✅ Bank sticker sent");
  } catch (err) {
    logger?.error({ err }, "Bank sticker error");
    await sock.sendMessage(remoteJid, {
      text: "❌ Gagal mengirim stiker dari bank.",
    }, { quoted: msg });
  }
}

async function handleSearch(keyword, sock, msg, remoteJid, logger) {
  await sock.sendMessage(remoteJid, {
    text: `🔍 Mencari "${keyword}" di Reddit...`,
  }, { quoted: msg });

  try {
    const result = await searchAndSend(keyword, sock, remoteJid, { logger });
    if (!result.success) {
      const reasonMessages = {
        no_results: "❌ Tidak ditemukan hasil untuk keyword tersebut.",
        no_eligible: "❌ Hasil pencarian tidak memenuhi kriteria stiker.",
        conversion_failed: "❌ Media Reddit ini tidak dapat dijadikan stiker.",
      };
      await sock.sendMessage(remoteJid, {
        text: reasonMessages[result.reason] || `❌ Gagal: ${result.reason}`,
      }, { quoted: msg });
    } else {
      logger?.info({ chat: remoteJid, postId: result.postId, subreddit: result.subreddit }, "✅ Search sticker sent");
    }
  } catch (err) {
    logger?.error({ err }, "Search sticker error");
    await sock.sendMessage(remoteJid, {
      text: "❌ Gagal mencari di Reddit. Coba keyword lain.",
    }, { quoted: msg });
  }
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
      `_Cron sender: ${isCronSenderEnabled() ? "✅ ON" : "⛔ OFF"}_`,
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
    await sock.sendMessage(remoteJid, { text: "✅ Reddit cron sender: *ON*" }, { quoted: msg });
  } else if (mode === "off") {
    toggleCronSender(false);
    await sock.sendMessage(remoteJid, { text: "⛔ Reddit cron sender: *OFF*" }, { quoted: msg });
  } else {
    await sock.sendMessage(remoteJid, {
      text: `🎭 Reddit cron sender: *${isCronSenderEnabled() ? "ON" : "OFF"}*\n\nGunakan: *!rmode on* atau *!rmode off*`,
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
  await sock.sendMessage(remoteJid, { text: "🧪 *Reddit Sticker Test*\n\nMenguji pipeline..." }, { quoted: msg });

  const results = [];
  const startMs = Date.now();

  try {
    // 1. Static image test
    const {
      resolveMedia,
      filterAndRankPosts,
      isEligibleRedditPost,
    } = require("../services/redditMediaResolver");
    const { getTopPosts } = require("../services/redditService");
    const { downloadMedia, cleanupTempFile } = require("../services/redditMediaDownloader");
    const {
      convertStaticSticker,
      convertAnimatedSticker,
      isAnimatedMedia,
    } = require("../services/redditMediaConverter");

    const subreddits = (process.env.REDDIT_DEFAULT_SUBREDDITS || "memes,dankmemes,funny")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    let testPost = null;

    for (const sr of subreddits.slice(0, 3)) {
      try {
        const data = await getTopPosts(sr, 25);
        const posts = data?.data?.children?.map((c) => c.data) || [];
        const eligible = filterAndRankPosts(posts);

        // Find one static and one animated
        for (const p of eligible) {
          const media = resolveMedia(p);
          if (media && !isAnimatedMedia(media.mediaType)) {
            testPost = p;
            testPost._resolvedMedia = media;
            break;
          }
        }
        if (testPost) break;
      } catch {}
    }

    if (!testPost) {
      await sock.sendMessage(remoteJid, { text: "🧪 Tidak ada post uji yang tersedia." }, { quoted: msg });
      return;
    }

    // Static test
    const media = testPost._resolvedMedia;
    let dlResult = null;
    try {
      dlResult = await downloadMedia(media.mediaUrl);
      const conv = await convertStaticSticker(dlResult.buffer);

      results.push(
        `✅ *Static:* ${conv.fileSizeBytes} bytes | ${testPost.subreddit}`
      );

      // Send the test static sticker
      await sock.sendMessage(remoteJid, { sticker: conv.buffer });
    } catch (err) {
      results.push(`❌ Static: ${String(err.message).slice(0, 50)}`);
    } finally {
      if (dlResult) cleanupTempFile(dlResult.filePath);
    }

    // Animated test — find one if available
    const animatedPost = null;
    for (const sr of subreddits.slice(0, 3)) {
      try {
        const data = await getTopPosts(sr, 25);
        const posts = data?.data?.children?.map((c) => c.data) || [];
        const eligible = filterAndRankPosts(posts);
        for (const p of eligible) {
          const media = resolveMedia(p);
          if (media && isAnimatedMedia(media.mediaType)) {
            // Found animated candidate
            break;
          }
        }
      } catch {}
    }

    const latencyMs = Date.now() - startMs;
    results.push(`⏱️ Latency: ${latencyMs}ms`);

    await sock.sendMessage(remoteJid, {
      text: `🧪 *HASIL TEST*\n\n${results.join("\n")}\n\n_Tidak menandai cron selesai._`,
    }, { quoted: msg });

    logger?.info({ results }, "Reddit test complete");
  } catch (err) {
    logger?.error({ err }, "Reddit test error");
    await sock.sendMessage(remoteJid, {
      text: `❌ Test gagal: ${String(err.message).slice(0, 200)}`,
    }, { quoted: msg });
  }
}
