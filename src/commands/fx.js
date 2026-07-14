// FX Commands — USD/IDR market intelligence.
// Auto-loaded by src/handler.js (no manual registration needed).

const rateService = require("../services/fxRateService");
const repository = require("../repositories/fxRepository");
const provider = require("../services/fxRateProvider");
const fxCron = require("../scheduler/fxCron");

// ── Admin Detection ───────────────────────────────────────

function isPrivileged(remoteJid, msg) {
  const OWNER_JID = process.env.OWNER_JID || "";

  // If OWNER_JID is not configured, allow all users (permissive fallback)
  if (!OWNER_JID) return true;

  const isOwner =
    OWNER_JID &&
    (remoteJid === OWNER_JID || msg.key.participant === OWNER_JID);
  const isGroup = remoteJid.endsWith("@g.us");
  const isAdmin = isGroup && msg.key.fromMe;
  return isOwner || isAdmin;
}

// ── Command State ─────────────────────────────────────────

const manualRefreshCooldown = new Map(); // remoteJid → lastRefreshMs
const MANUAL_REFRESH_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function checkCooldown(remoteJid) {
  const last = manualRefreshCooldown.get(remoteJid);
  if (last && (Date.now() - last) < MANUAL_REFRESH_COOLDOWN_MS) {
    const remaining = Math.ceil((MANUAL_REFRESH_COOLDOWN_MS - (Date.now() - last)) / 1000);
    return remaining; // seconds remaining
  }
  return 0;
}

function setCooldown(remoteJid) {
  manualRefreshCooldown.set(remoteJid, Date.now());
}

// ── Canonical Command Map ─────────────────────────────────

const CANONICAL_MAP = {
  usd: "usd", kurs: "usd",
  usdrefresh: "usdrefresh",
  usdbackfill: "usdbackfill",
  usdtest: "usdtest",
  usdmode: "usdmode",
  usdquota: "usdquota",
};

// ── Exports ───────────────────────────────────────────────

module.exports = {
  names: Object.keys(CANONICAL_MAP),

  async execute({ sock, msg, args, cmdName, remoteJid, logger, PREFIX }) {
    const canonical = CANONICAL_MAP[cmdName] || cmdName;
    const subCommand = args[0]?.toLowerCase();

    // ── usd / kurs ─────────────────────────────────────
    if (canonical === "usd") {
      if (subCommand === "compact") {
        await handleCompactReport(sock, msg, remoteJid, logger);
      } else if (["1h", "1d", "7d", "1m", "1y"].includes(subCommand)) {
        await handlePeriodDetail(sock, msg, subCommand, remoteJid, logger);
      } else if (subCommand === "range") {
        await handleRangeDetail(sock, msg, remoteJid, logger);
      } else if (subCommand === "context") {
        await handleContextView(sock, msg, remoteJid, logger);
      } else if (subCommand === "source") {
        await handleSourceInfo(sock, msg, remoteJid, logger);
      } else {
        await handleFullReport(sock, msg, remoteJid, logger);
      }
      return;
    }

    // ── usdrefresh ─────────────────────────────────────
    if (canonical === "usdrefresh") {
      if (!isPrivileged(remoteJid, msg)) {
        await sock.sendMessage(remoteJid, {
          text: "⚠️ Command ini hanya untuk admin/owner.",
        }, { quoted: msg });
        return;
      }
      await handleManualRefresh(sock, msg, remoteJid, logger);
      return;
    }

    // ── usdbackfill ────────────────────────────────────
    if (canonical === "usdbackfill") {
      if (!isPrivileged(remoteJid, msg)) {
        await sock.sendMessage(remoteJid, {
          text: "⚠️ Command ini hanya untuk admin/owner.",
        }, { quoted: msg });
        return;
      }
      await handleBackfill(sock, msg, remoteJid, logger);
      return;
    }

    // ── usdtest ────────────────────────────────────────
    if (canonical === "usdtest") {
      if (!isPrivileged(remoteJid, msg)) {
        await sock.sendMessage(remoteJid, {
          text: "⚠️ Command ini hanya untuk admin/owner.",
        }, { quoted: msg });
        return;
      }
      await handleTest(sock, msg, remoteJid, logger);
      return;
    }

    // ── usdmode ────────────────────────────────────────
    if (canonical === "usdmode") {
      if (!isPrivileged(remoteJid, msg)) {
        await sock.sendMessage(remoteJid, {
          text: "⚠️ Command ini hanya untuk admin/owner.",
        }, { quoted: msg });
        return;
      }
      await handleMode(sock, msg, args, remoteJid, logger);
      return;
    }

    // ── usdquota ───────────────────────────────────────
    if (canonical === "usdquota") {
      if (!isPrivileged(remoteJid, msg)) {
        await sock.sendMessage(remoteJid, {
          text: "⚠️ Command ini hanya untuk admin/owner.",
        }, { quoted: msg });
        return;
      }
      await handleQuota(sock, msg, remoteJid, logger);
      return;
    }
  },
};

// ── Command Handlers ──────────────────────────────────────

async function handleFullReport(sock, msg, remoteJid, logger) {
  // Read from cache — never call provider API
  if (!repository.isPersistent()) {
    await sock.sendMessage(remoteJid, {
      text: "⚠️ *USD/IDR Market Intelligence*\n\nDatabase tidak tersedia. Fitur ini membutuhkan koneksi Turso.",
    }, { quoted: msg });
    return;
  }

  const latest = await repository.getLatestRate();
  if (!latest) {
    await sock.sendMessage(remoteJid, {
      text: "📊 *USD/IDR*\n\nData kurs belum tersedia. Tunggu update otomatis berikutnya atau gunakan `!usdrefresh` (admin).",
    }, { quoted: msg });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const allRates = await repository.getRatesForWindow({
    start: now - 365 * 24 * 3600,
    end: now,
  });
  allRates.push(latest);

  const coverage = await repository.getHistoricalCoverage(365);
  const statistics = rateService.calculateAllStatistics(allRates, latest, coverage);
  const trend = rateService.classifyTrend(statistics);

  const maxAgeHours = parseInt(process.env.FX_MARKET_CONTEXT_MAX_AGE_HOURS || "12", 10);
  const context = await repository.getLatestValidContext(maxAgeHours);

  const report = rateService.formatReport({
    currentRate: latest.rate,
    statistics,
    trend,
    marketContext: context,
    providerTimestamp: latest.providerTimestamp,
    contextUpdatedAt: context?.generatedAt || null,
    historicalCoverage: coverage,
  });

  await sock.sendMessage(remoteJid, { text: report }, { quoted: msg });
}

async function handleCompactReport(sock, msg, remoteJid, logger) {
  if (!repository.isPersistent()) {
    await sock.sendMessage(remoteJid, { text: "⚠️ Database tidak tersedia." }, { quoted: msg });
    return;
  }

  const latest = await repository.getLatestRate();
  if (!latest) {
    await sock.sendMessage(remoteJid, { text: "📊 Data kurs belum tersedia." }, { quoted: msg });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const allRates = await repository.getRatesForWindow({
    start: now - 365 * 24 * 3600,
    end: now,
  });
  allRates.push(latest);

  const coverage = await repository.getHistoricalCoverage(365);
  const statistics = rateService.calculateAllStatistics(allRates, latest, coverage);

  const report = rateService.formatCompactReport({
    currentRate: latest.rate,
    statistics,
    trend: rateService.classifyTrend(statistics),
    providerTimestamp: latest.providerTimestamp,
  });

  await sock.sendMessage(remoteJid, { text: report }, { quoted: msg });
}

async function handlePeriodDetail(sock, msg, period, remoteJid, logger) {
  if (!repository.isPersistent()) {
    await sock.sendMessage(remoteJid, { text: "⚠️ Database tidak tersedia." }, { quoted: msg });
    return;
  }

  const latest = await repository.getLatestRate();
  if (!latest) {
    await sock.sendMessage(remoteJid, { text: "📊 Data kurs belum tersedia." }, { quoted: msg });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const allRates = await repository.getRatesForWindow({
    start: now - 365 * 24 * 3600,
    end: now,
  });
  allRates.push(latest);

  const coverage = await repository.getHistoricalCoverage(365);
  const statistics = rateService.calculateAllStatistics(allRates, latest, coverage);

  const periodMap = { "1h": "1H", "1d": "1D", "7d": "7D", "1m": "1M", "1y": "1Y" };
  const pKey = periodMap[period];
  const p = statistics.periods?.[pKey];

  if (!p) {
    await sock.sendMessage(remoteJid, { text: "📊 Periode tidak valid." }, { quoted: msg });
    return;
  }

  const lines = [
    `*USD/IDR — Detail ${pKey}*`,
    "",
    `Kurs saat ini: ${rateService.formatIdr(p.currentRate)}`,
    `Referensi: ${p.referenceRate ? rateService.formatIdr(p.referenceRate) : "N/A"}`,
    `Perubahan: ${rateService.formatAbsoluteChange(p.absoluteChange)} (${rateService.formatPercent(p.percentageChange)})`,
    "",
    `Tertinggi tercatat: ${p.high ? rateService.formatIdr(p.high) : "N/A"}`,
    `Terendah tercatat: ${p.low ? rateService.formatIdr(p.low) : "N/A"}`,
    `Posisi dalam rentang: ${p.rangePosition != null ? p.rangePosition.toFixed(0) + "%" : "N/A"}`,
    `Volatilitas rentang: ${p.rangePercentage != null ? p.rangePercentage.toFixed(2) + "%" : "N/A"}`,
    "",
    `Tipe data: ${p.dataSource}`,
    `Cakupan: ${p.availablePoints}/${p.expectedPoints} (${p.coveragePercentage.toFixed(0)}%)`,
    p.complete ? "Status: ✅ Lengkap" : "Status: ⚠️ Parsial",
  ];

  await sock.sendMessage(remoteJid, { text: lines.join("\n") }, { quoted: msg });
}

async function handleRangeDetail(sock, msg, remoteJid, logger) {
  if (!repository.isPersistent()) {
    await sock.sendMessage(remoteJid, { text: "⚠️ Database tidak tersedia." }, { quoted: msg });
    return;
  }

  const latest = await repository.getLatestRate();
  if (!latest) {
    await sock.sendMessage(remoteJid, { text: "📊 Data kurs belum tersedia." }, { quoted: msg });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const allRates = await repository.getRatesForWindow({
    start: now - 365 * 24 * 3600,
    end: now,
  });
  allRates.push(latest);

  const coverage = await repository.getHistoricalCoverage(365);
  const statistics = rateService.calculateAllStatistics(allRates, latest, coverage);

  const lines = ["*USD/IDR — Rentang Tercatat*", ""];

  for (const period of ["1D", "7D", "1M", "1Y"]) {
    const p = statistics.periods?.[period];
    if (!p) continue;

    lines.push(`*${period}*`);
    lines.push(`High: ${p.high ? rateService.formatIdr(p.high) : "N/A"}`);
    lines.push(`Low:  ${p.low ? rateService.formatIdr(p.low) : "N/A"}`);
    lines.push(`Posisi saat ini: ${p.rangePosition != null ? p.rangePosition.toFixed(0) + "%" : "N/A"}`);
    lines.push(`Volatilitas rentang: ${p.rangePercentage != null ? p.rangePercentage.toFixed(2) + "%" : "N/A"}`);
    lines.push(`Cakupan: ${p.availablePoints}/${p.expectedPoints}`);
    lines.push("");
  }

  lines.push(`_Sumber: Open Exchange Rates_`);

  await sock.sendMessage(remoteJid, { text: lines.join("\n") }, { quoted: msg });
}

async function handleContextView(sock, msg, remoteJid, logger) {
  if (!repository.isPersistent()) {
    await sock.sendMessage(remoteJid, { text: "⚠️ Database tidak tersedia." }, { quoted: msg });
    return;
  }

  const maxAgeHours = parseInt(process.env.FX_MARKET_CONTEXT_MAX_AGE_HOURS || "12", 10);
  const context = await repository.getLatestValidContext(maxAgeHours);

  if (!context || !context.articles || context.articles.length === 0) {
    await sock.sendMessage(remoteJid, {
      text: "📰 *Konteks Berita Ekonomi*\n\nKonteks berita terbaru belum tersedia.",
    }, { quoted: msg });
    return;
  }

  const lines = ["📰 *Konteks Berita Ekonomi*", ""];

  for (const article of context.articles) {
    const title = article.headline || article.title || article.displayTitle || "Tanpa judul";
    const pub = article.publisher || article.source || "";
    const url = article.url || "";

    lines.push(`• *${title}*`);
    if (pub) lines.push(`  📰 ${pub}`);
    if (article.summary) lines.push(`  ${article.summary.slice(0, 200)}`);
    if (url) lines.push(`  🔗 ${url}`);
    lines.push("");
  }

  if (context.narrative) {
    lines.push(context.narrative);
    lines.push("");
  }

  const updatedAt = context.generatedAt
    ? new Date(context.generatedAt).toLocaleTimeString("id-ID", {
        timeZone: "Asia/Jakarta",
        hour: "2-digit",
        minute: "2-digit",
      }) + " WIB"
    : "N/A";

  lines.push(`_Diperbarui: ${updatedAt}_`);
  lines.push(`_Status: ${context.status}_`);

  await sock.sendMessage(remoteJid, { text: lines.join("\n") }, { quoted: msg });
}

async function handleSourceInfo(sock, msg, remoteJid, logger) {
  if (!repository.isPersistent()) {
    await sock.sendMessage(remoteJid, { text: "⚠️ Database tidak tersedia." }, { quoted: msg });
    return;
  }

  const latest = await repository.getLatestRate();
  const coverage = await repository.getHistoricalCoverage(365);

  const lines = [
    "*USD/IDR — Sumber Data*",
    "",
    `Provider: Open Exchange Rates`,
    `Pasangan: USD/IDR`,
    `Update terakhir: ${latest ? rateService.formatWibTime(latest.providerTimestamp) : "Belum ada"}`,
    `Waktu fetch: ${latest?.fetchedAt ? new Date(latest.fetchedAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) + " WIB" : "N/A"}`,
    "",
    `Cakupan historis: ${coverage.availableDates?.size || 0}/${coverage.total || 365} hari`,
    "",
    "_Catatan: kurs indikatif, bukan kurs transaksi bank atau JISDOR._",
    "_Data disediakan oleh Open Exchange Rates (openexchangerates.org)_",
  ];

  await sock.sendMessage(remoteJid, { text: lines.join("\n") }, { quoted: msg });
}

async function handleManualRefresh(sock, msg, remoteJid, logger) {
  // Cooldown check
  const remaining = checkCooldown(remoteJid);
  if (remaining > 0) {
    await sock.sendMessage(remoteJid, {
      text: `⏳ Refresh manual masih dalam cooldown. Silakan tunggu ${remaining} detik.`,
    }, { quoted: msg });
    return;
  }

  await sock.sendMessage(remoteJid, {
    text: "🔄 Mengambil data USD/IDR terbaru...",
  }, { quoted: msg });

  setCooldown(remoteJid);

  try {
    const result = await fxCron.manualRefresh({
      logger,
      replyCallback: async (report) => {
        await sock.sendMessage(remoteJid, { text: report });
      },
    });

    if (!result) {
      await sock.sendMessage(remoteJid, {
        text: "⚠️ Gagal mengambil data USD/IDR. Periksa log untuk detail.",
      }, { quoted: msg });
    }

    logger?.info({ chat: remoteJid }, "Manual FX refresh complete");
  } catch (err) {
    logger?.error({ err }, "Manual FX refresh error");
    await sock.sendMessage(remoteJid, {
      text: `❌ Gagal: ${err.message?.slice(0, 200) || "Unknown error"}`,
    }, { quoted: msg });
  }
}

async function handleBackfill(sock, msg, remoteJid, logger) {
  await sock.sendMessage(remoteJid, {
    text: "⏳ *Historical Backfill*\n\nMemeriksa data historis yang belum tersedia...",
  }, { quoted: msg });

  try {
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const missing = await repository.getMissingHistoricalDates({
      startDate,
      endDate,
      provider: "open_exchange_rates",
      base: "USD",
      quote: "IDR",
    });

    if (missing.length === 0) {
      await sock.sendMessage(remoteJid, {
        text: "✅ Data historis sudah lengkap. Tidak ada tanggal yang perlu diambil.",
      }, { quoted: msg });
      return;
    }

    // Check quota before backfilling
    const usageData = await provider.fetchUsage(logger);
    let quotaInfo = "";
    if (usageData) {
      quotaInfo = `\nQuota tersisa: ${usageData.usage.requestsRemaining}/${usageData.usage.requestsQuota}`;
    }

    const maxPerRun = parseInt(process.env.FX_HISTORY_BACKFILL_MAX_PER_RUN || "50", 10);
    const quotaReserve = parseInt(process.env.FX_HISTORY_QUOTA_RESERVE || "25", 10);

    let available = Math.min(missing.length, maxPerRun);
    if (usageData) {
      const daysRemaining = usageData.usage.daysRemaining || 30;
      const expectedHourly = daysRemaining * 24;
      available = Math.min(available,
        Math.max(0, usageData.usage.requestsRemaining - expectedHourly - quotaReserve)
      );
    }

    const toFetch = missing.slice(-available); // Start from most recent

    await sock.sendMessage(remoteJid, {
      text: `⏳ *Historical Backfill*\n\nData hilang: ${missing.length} hari\nAkan diambil: ${toFetch.length} hari${quotaInfo}\n\nMemulai...`,
    }, { quoted: msg });

    let fetched = 0;
    let failed = 0;

    for (const date of toFetch) {
      try {
        const histData = await provider.fetchHistorical(date, logger);
        if (histData && histData.rates?.IDR) {
          await repository.insertRateSnapshot({
            provider: "open_exchange_rates",
            base: histData.base || "USD",
            quote: "IDR",
            rate: histData.rates.IDR,
            providerTimestamp: histData.timestamp,
            granularity: "daily_historical",
            sourceDate: date,
          });
          fetched++;
        }
      } catch (err) {
        failed++;
        logger?.warn({ date, err: err.message }, "[FX Backfill] Date failed");
      }

      // Brief pause between requests
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    await sock.sendMessage(remoteJid, {
      text: `✅ *Historical Backfill Selesai*\n\nDiambil: ${fetched} hari\nGagal: ${failed} hari\nSisa: ${missing.length - fetched} hari`,
    }, { quoted: msg });
  } catch (err) {
    logger?.error({ err }, "Backfill error");
    await sock.sendMessage(remoteJid, {
      text: `❌ Backfill gagal: ${err.message?.slice(0, 200) || "Unknown error"}`,
    }, { quoted: msg });
  }
}

async function handleTest(sock, msg, remoteJid, logger) {
  await sock.sendMessage(remoteJid, {
    text: "🧪 *FX Market Intelligence Test*\n\nMenguji koneksi Open Exchange Rates...",
  }, { quoted: msg });

  const results = [];
  const startMs = Date.now();

  // 1. Test provider connectivity
  try {
    const appIdSet = !!process.env.OPEN_EXCHANGE_RATES_APP_ID;
    results.push(`App ID: ${appIdSet ? "✅ Tersedia" : "❌ Tidak diatur"}`);

    if (appIdSet) {
      const rateData = await provider.fetchLatest(logger);
      results.push(`✅ Provider OK: 1 USD = ${rateService.formatIdr(rateData.rates.IDR)}`);
      results.push(`Timestamp: ${rateService.formatWibTime(rateData.timestamp)}`);
    }

    // 2. Test usage endpoint
    const usage = await provider.fetchUsage(logger);
    if (usage) {
      results.push(`✅ Usage OK: ${usage.usage.requestsRemaining}/${usage.usage.requestsQuota} remaining`);
    } else {
      results.push("⚠️ Usage endpoint tidak tersedia");
    }
  } catch (err) {
    results.push(`❌ Provider error: ${err.errorMessage || err.message?.slice(0, 80)}`);
  }

  // 3. Test repository
  results.push(`Database: ${repository.isPersistent() ? "✅ Turso" : "❌ Tidak tersedia"}`);

  if (repository.isPersistent()) {
    const latest = await repository.getLatestRate();
    results.push(`Latest snapshot: ${latest ? "✅ Ada" : "⚠️ Belum ada data"}`);

    const coverage = await repository.getHistoricalCoverage(365);
    results.push(`Historical: ${coverage.availableDates?.size || 0}/${coverage.total || 365} hari`);
  }

  // 4. Test market context
  const context = await repository.getLatestValidContext(12);
  results.push(`Market context: ${context ? `✅ ${context.status} (${context.articles?.length || 0} artikel)` : "⚠️ Belum tersedia"}`);

  // 5. Scheduler status
  results.push(`Scheduler: ${fxCron.isRunning() ? "✅ Running" : "⛔ Stopped"}`);

  const latencyMs = Date.now() - startMs;
  results.push(`⏱️ Latency: ${latencyMs}ms`);

  await sock.sendMessage(remoteJid, {
    text: `🧪 *HASIL FX TEST*\n\n${results.join("\n")}`,
  }, { quoted: msg });

  logger?.info({ results, latencyMs }, "FX test complete");
}

async function handleMode(sock, msg, args, remoteJid, logger) {
  const mode = args[1]?.toLowerCase();

  if (mode === "on") {
    process.env.FX_USD_IDR_AUTO_SEND_ENABLED = "true";
    await sock.sendMessage(remoteJid, { text: "✅ USD/IDR auto-send: *ON*" }, { quoted: msg });
  } else if (mode === "off") {
    process.env.FX_USD_IDR_AUTO_SEND_ENABLED = "false";
    await sock.sendMessage(remoteJid, { text: "⛔ USD/IDR auto-send: *OFF*" }, { quoted: msg });
  } else {
    const status = process.env.FX_USD_IDR_AUTO_SEND_ENABLED !== "false" ? "ON" : "OFF";
    await sock.sendMessage(remoteJid, {
      text: `📊 USD/IDR auto-send: *${status}*\n\nGunakan: *!usdmode on* atau *!usdmode off*`,
    }, { quoted: msg });
  }
}

async function handleQuota(sock, msg, remoteJid, logger) {
  await sock.sendMessage(remoteJid, {
    text: "📊 Mengecek kuota Open Exchange Rates...",
  }, { quoted: msg });

  try {
    const usage = await provider.fetchUsage(logger);

    if (!usage) {
      await sock.sendMessage(remoteJid, {
        text: "⚠️ Tidak dapat mengambil data penggunaan API.",
      }, { quoted: msg });
      return;
    }

    const coverage = await repository.getHistoricalCoverage(365);

    const daysRemaining = usage.usage.daysRemaining || 30;
    const expectedHourly = daysRemaining * 24;

    const lines = [
      "*USD/IDR — Kuota API*",
      "",
      `📊 *Plan:* ${usage.plan.name}`,
      `🔄 Update frequency: ${usage.plan.updateFrequency}`,
      "",
      `📈 Requests used: ${usage.usage.requests}`,
      `📉 Requests remaining: ${usage.usage.requestsRemaining}`,
      `📊 Quota: ${usage.usage.requestsQuota}`,
      `📅 Days remaining: ${daysRemaining}`,
      "",
      `⏰ Estimasi kebutuhan per jam: ${expectedHourly}`,
      `💾 Data historis: ${coverage.availableDates?.size || 0}/${coverage.total || 365} hari`,
    ];

    const quotaReserve = parseInt(process.env.FX_HISTORY_QUOTA_RESERVE || "25", 10);
    const availableForBackfill = Math.max(0,
      usage.usage.requestsRemaining - expectedHourly - quotaReserve
    );
    lines.push(`📦 Kuota aman untuk backfill: ${availableForBackfill}`);

    await sock.sendMessage(remoteJid, { text: lines.join("\n") }, { quoted: msg });
  } catch (err) {
    logger?.error({ err }, "Quota check error");
    await sock.sendMessage(remoteJid, {
      text: `❌ Gagal mengecek kuota: ${err.message?.slice(0, 200)}`,
    }, { quoted: msg });
  }
}
