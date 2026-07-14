// FX Rate Service — deterministic statistics, trend classification, report formatting.
// PURE functions: no network calls, no database calls, no side effects.

const crypto = require("crypto");

// ── Configuration ─────────────────────────────────────────

function getConfig() {
  return {
    window1DHours: parseInt(process.env.FX_WINDOW_1D_HOURS || "24", 10),
    window7DDays: parseInt(process.env.FX_WINDOW_7D_DAYS || "7", 10),
    window1MDays: parseInt(process.env.FX_WINDOW_1M_DAYS || "30", 10),
    window1YDays: parseInt(process.env.FX_WINDOW_1Y_DAYS || "365", 10),
    coverageThreshold1D: parseInt(process.env.FX_COVERAGE_THRESHOLD_1D || "90", 10),
    coverageThreshold7D: parseInt(process.env.FX_COVERAGE_THRESHOLD_7D || "85", 10),
    coverageThreshold1M: parseInt(process.env.FX_COVERAGE_THRESHOLD_1M || "90", 10),
    coverageThreshold1Y: parseInt(process.env.FX_COVERAGE_THRESHOLD_1Y || "90", 10),
    sigMove1H: parseFloat(process.env.FX_SIGNIFICANT_MOVE_1H_PERCENT || "0.15"),
    sigMove1D: parseFloat(process.env.FX_SIGNIFICANT_MOVE_1D_PERCENT || "0.75"),
    nearHigh: parseInt(process.env.FX_NEAR_RANGE_HIGH_PERCENT || "80", 10),
    nearLow: parseInt(process.env.FX_NEAR_RANGE_LOW_PERCENT || "20", 10),
  };
}

// ── Helpers ───────────────────────────────────────────────

/**
 * Format a rate as Indonesian Rupiah currency string.
 * Example: 18125.45 → "Rp18.125,45"
 */
function formatIdr(rate) {
  if (rate == null || !Number.isFinite(rate)) return "N/A";
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(rate);
}

/**
 * Format a rate without the "Rp" prefix for compact display.
 * Example: 18125.45 → "18.125,45"
 */
function formatIdrCompact(rate) {
  if (rate == null || !Number.isFinite(rate)) return "N/A";
  // Use number format without currency, then strip the IDR parts
  return rate.toLocaleString("id-ID", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Format a percentage change.
 */
function formatPercent(value) {
  if (value == null || !Number.isFinite(value)) return "N/A";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

/**
 * Format an absolute change in IDR.
 */
function formatAbsoluteChange(value) {
  if (value == null || !Number.isFinite(value)) return "N/A";
  const sign = value > 0 ? "+" : "";
  const abs = Math.abs(value);
  return `${sign}Rp${abs.toLocaleString("id-ID", { maximumFractionDigits: 2 })}`;
}

/**
 * Format a UTC timestamp to WIB display string.
 */
function formatWibTime(unixTimestamp) {
  if (!unixTimestamp) return "N/A";
  const date = new Date(unixTimestamp * 1000);
  return date.toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }) + " WIB";
}

/**
 * Format just the time part.
 */
function formatWibTimeShort(unixTimestamp) {
  if (!unixTimestamp) return "N/A";
  const date = new Date(unixTimestamp * 1000);
  return date.toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }) + " WIB";
}

/**
 * Get today's Jakarta date string.
 */
function getJakartaDate() {
  return new Date().toLocaleDateString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * Get current Jakarta time string.
 */
function getJakartaTime() {
  return new Date().toLocaleTimeString("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// ── Statistics Calculation ────────────────────────────────

/**
 * Find the snapshot nearest to but not after the target boundary timestamp.
 */
function findReferenceRate(rates, targetTimestamp, toleranceSeconds) {
  const tolerance = toleranceSeconds || 3600; // default 1 hour tolerance
  let best = null;
  let bestDiff = Infinity;

  for (const r of rates) {
    const diff = targetTimestamp - r.providerTimestamp;
    if (diff >= 0 && diff <= tolerance && diff < bestDiff) {
      best = r;
      bestDiff = diff;
    }
  }

  return best;
}

/**
 * Calculate statistics for a single period window.
 *
 * @param {Array} rates - Array of { rate, providerTimestamp }
 * @param {Object} options
 * @param {string} options.period - '1H' | '1D' | '7D' | '1M' | '1Y'
 * @param {number} options.windowStart - Unix timestamp of window start
 * @param {number} options.windowEnd - Unix timestamp of window end
 * @param {string} options.granularity - 'hourly' | 'daily' | 'mixed'
 * @param {number} options.expectedPoints
 * @param {number} options.coverageThreshold
 * @param {number} options.currentRate
 * @returns {Object} Statistics result
 */
function calculatePeriodStatistics(rates, options) {
  const {
    period,
    windowStart,
    windowEnd,
    granularity = "hourly",
    expectedPoints = 24,
    coverageThreshold = 90,
    currentRate,
  } = options;

  if (!rates || rates.length === 0) {
    return {
      period,
      windowType: "rolling",
      windowStart,
      windowEnd,
      granularity,
      dataSource: "none",
      currentRate: currentRate || null,
      referenceRate: null,
      absoluteChange: null,
      percentageChange: null,
      high: null,
      low: null,
      rangePosition: null,
      rangePercentage: null,
      availablePoints: 0,
      expectedPoints,
      coveragePercentage: 0,
      complete: false,
    };
  }

  // Filter rates within window
  const windowRates = rates.filter(
    (r) => r.providerTimestamp >= windowStart && r.providerTimestamp <= windowEnd
  );

  const availablePoints = windowRates.length;
  const coveragePercentage = expectedPoints > 0
    ? Math.min(100, (availablePoints / expectedPoints) * 100)
    : 0;

  // Reference: snapshot nearest to windowStart
  const referenceRate = findReferenceRate(rates, windowStart, windowEnd - windowStart);

  // High and low within window
  const rateValues = windowRates.map((r) => r.rate);
  let high = null;
  let low = null;

  if (rateValues.length > 0) {
    high = Math.max(...rateValues);
    low = Math.min(...rateValues);
  }

  // Also consider the current rate for high/low if it's outside window range
  const curr = currentRate || (rates.length > 0 ? rates[rates.length - 1].rate : null);

  // Changes
  let absoluteChange = null;
  let percentageChange = null;
  if (curr != null && referenceRate) {
    absoluteChange = curr - referenceRate.rate;
    percentageChange = referenceRate.rate > 0
      ? ((curr - referenceRate.rate) / referenceRate.rate) * 100
      : null;
  }

  // Range position
  let rangePosition = null;
  if (high != null && low != null && curr != null) {
    if (high === low) {
      rangePosition = 50;
    } else {
      rangePosition = Math.max(0, Math.min(100, ((curr - low) / (high - low)) * 100));
    }
  }

  // Range percentage (volatility proxy)
  let rangePercentage = null;
  if (high != null && low != null && low > 0) {
    rangePercentage = ((high - low) / low) * 100;
  }

  // Data source label
  let dataSource = granularity;
  if (granularity === "mixed") {
    dataSource = "mixed-recorded-data";
  } else if (granularity === "hourly") {
    dataSource = "hourly-snapshots";
  } else if (granularity === "daily") {
    dataSource = "historical-daily";
  }

  // Completeness check
  const complete =
    coveragePercentage >= coverageThreshold &&
    referenceRate !== null &&
    high !== null &&
    low !== null;

  return {
    period,
    windowType: "rolling",
    windowStart,
    windowEnd,
    granularity,
    dataSource,
    currentRate: curr,
    referenceRate: referenceRate ? referenceRate.rate : null,
    absoluteChange,
    percentageChange,
    high,
    low,
    rangePosition,
    rangePercentage,
    availablePoints,
    expectedPoints,
    coveragePercentage,
    complete,
  };
}

/**
 * Calculate all period statistics for a set of rate snapshots.
 *
 * @param {Array} allRates - All available rate snapshots
 * @param {Object} currentRate - { rate, providerTimestamp }
 * @param {Object} historicalCoverage - { availableDates: Set, missingDates: Set, total: number }
 * @returns {Object} { currentRate, periods: { '1H': ..., '1D': ..., '7D': ..., '1M': ..., '1Y': ... } }
 */
function calculateAllStatistics(allRates, currentRate, historicalCoverage) {
  const config = getConfig();
  const now = currentRate?.providerTimestamp || Math.floor(Date.now() / 1000);
  const curr = currentRate?.rate || null;

  const periods = {};

  // ── 1H ──
  {
    const windowStart = now - 3600;
    periods["1H"] = calculatePeriodStatistics(allRates, {
      period: "1H",
      windowStart,
      windowEnd: now,
      granularity: "hourly",
      expectedPoints: 1,
      coverageThreshold: config.coverageThreshold1D, // use 1D threshold as minimum
      currentRate: curr,
    });
  }

  // ── 1D ──
  {
    const windowStart = now - config.window1DHours * 3600;
    periods["1D"] = calculatePeriodStatistics(allRates, {
      period: "1D",
      windowStart,
      windowEnd: now,
      granularity: "hourly",
      expectedPoints: config.window1DHours,
      coverageThreshold: config.coverageThreshold1D,
      currentRate: curr,
    });
  }

  // ── 7D ──
  {
    const windowStart = now - config.window7DDays * 24 * 3600;
    const expectedHourly = config.window7DDays * 24;
    periods["7D"] = calculatePeriodStatistics(allRates, {
      period: "7D",
      windowStart,
      windowEnd: now,
      granularity: "hourly",
      expectedPoints: expectedHourly,
      coverageThreshold: config.coverageThreshold7D,
      currentRate: curr,
    });
    // If hourly coverage is insufficient, note it
    if (!periods["7D"].complete) {
      periods["7D"].dataSource = availablePointsToDataSource(
        periods["7D"].availablePoints,
        expectedHourly,
        "mixed-recorded-data"
      );
    }
  }

  // ── 1M ──
  {
    const windowStart = now - config.window1MDays * 24 * 3600;
    periods["1M"] = calculatePeriodStatistics(allRates, {
      period: "1M",
      windowStart,
      windowEnd: now,
      granularity: "daily",
      expectedPoints: config.window1MDays,
      coverageThreshold: config.coverageThreshold1M,
      currentRate: curr,
    });
  }

  // ── 1Y ──
  {
    const windowStart = now - config.window1YDays * 24 * 3600;
    const coverageDays = historicalCoverage
      ? historicalCoverage.availableDates?.size || 0
      : 0;
    const totalDays = historicalCoverage?.total || config.window1YDays;

    periods["1Y"] = calculatePeriodStatistics(allRates, {
      period: "1Y",
      windowStart,
      windowEnd: now,
      granularity: "daily",
      expectedPoints: totalDays,
      coverageThreshold: config.coverageThreshold1Y,
      currentRate: curr,
    });
    // Override available points with actual coverage data
    if (historicalCoverage) {
      periods["1Y"].availablePoints = coverageDays;
      periods["1Y"].coveragePercentage = totalDays > 0
        ? (coverageDays / totalDays) * 100
        : 0;
    }
  }

  return {
    currentRate: curr,
    providerTimestamp: currentRate?.providerTimestamp || null,
    periods,
    historicalCoverage,
  };
}

function availablePointsToDataSource(available, expected, fallback) {
  const ratio = expected > 0 ? available / expected : 0;
  if (ratio >= 0.9) return "hourly-snapshots";
  if (ratio >= 0.3) return "mixed-recorded-data";
  return fallback || "historical-daily";
}

// ── Trend Classification ──────────────────────────────────

/**
 * Classify USD/IDR trend based on multi-period statistics.
 * Deterministic rules — no AI involved.
 *
 * @param {Object} statistics - Output from calculateAllStatistics
 * @returns {Object} { direction, narrative, highlights }
 */
function classifyTrend(statistics) {
  const config = getConfig();
  const periods = statistics?.periods || {};
  const change1D = periods["1D"]?.percentageChange;
  const change7D = periods["7D"]?.percentageChange;
  const change1M = periods["1M"]?.percentageChange;
  const change1Y = periods["1Y"]?.percentageChange;
  const pos1D = periods["1D"]?.rangePosition;
  const pos1Y = periods["1Y"]?.rangePosition;

  const highlights = [];
  let direction = "stable";
  let narrative = "";

  // Check for significant hourly moves
  if (periods["1H"]?.percentageChange != null &&
      Math.abs(periods["1H"].percentageChange) >= config.sigMove1H) {
    const dir = periods["1H"].percentageChange > 0 ? "naik" : "turun";
    highlights.push(
      `Pergerakan signifikan: USD/IDR ${dir} ${Math.abs(periods["1H"].percentageChange).toFixed(2)}% dalam satu jam.`
    );
  }

  // Check for significant daily moves
  if (change1D != null && Math.abs(change1D) >= config.sigMove1D) {
    const dir = change1D > 0 ? "naik" : "turun";
    highlights.push(
      `USD/IDR ${dir} ${Math.abs(change1D).toFixed(2)}% dalam 24 jam.`
    );
  }

  // Check range extremes
  if (pos1Y != null) {
    if (pos1Y >= config.nearHigh) {
      highlights.push("Kurs berada di dekat area tertinggi tercatat dalam satu tahun.");
    } else if (pos1Y <= config.nearLow) {
      highlights.push("Kurs berada di dekat area terendah tercatat dalam satu tahun.");
    }
  }

  if (pos1D != null) {
    if (pos1D >= config.nearHigh) {
      highlights.push("Kurs mendekati harga tertinggi dalam 24 jam terakhir.");
    }
  }

  // Determine overall direction
  if (change1D != null && change7D != null) {
    if (change1D > 0.1 && change7D > 0.1) {
      direction = "usd_strengthening";
      narrative = "USD menguat dan rupiah melemah dalam jangka pendek.";
    } else if (change1D < -0.1 && change7D < -0.1) {
      direction = "usd_weakening";
      narrative = "Rupiah menguat dan USD melemah dalam jangka pendek.";
    } else if (Math.abs(change1D) < 0.05 && Math.abs(change7D) < 0.1) {
      direction = "stable";
      narrative = "Pergerakan kurs relatif stabil.";
    } else {
      direction = "mixed";
      narrative = "Arah jangka pendek dan mingguan masih bercampur.";
    }
  } else if (change1D != null) {
    if (change1D > 0.1) {
      direction = "usd_strengthening";
      narrative = "USD menguat terhadap rupiah dalam 24 jam.";
    } else if (change1D < -0.1) {
      direction = "usd_weakening";
      narrative = "Rupiah menguat terhadap USD dalam 24 jam.";
    } else {
      direction = "stable";
      narrative = "Pergerakan harian relatif stabil.";
    }
  } else {
    narrative = "Data belum cukup untuk klasifikasi tren.";
  }

  // Add context about position within 1Y range
  if (pos1Y != null && direction !== "stable") {
    if (pos1Y >= 60) {
      narrative += " Kurs berada di bagian atas rentang satu tahun.";
    } else if (pos1Y <= 40) {
      narrative += " Kurs berada di bagian bawah rentang satu tahun.";
    } else {
      narrative += " Kurs berada di tengah rentang satu tahun.";
    }
  }

  return { direction, narrative, highlights };
}

// ── Report Formatting (PURE) ──────────────────────────────

/**
 * Format the full hourly market update report.
 * PURE function — no side effects, no I/O.
 *
 * @param {Object} params
 * @returns {string} Formatted WhatsApp message
 */
function formatReport({
  currentRate,
  statistics,
  trend,
  marketContext,
  providerTimestamp,
  contextUpdatedAt,
  historicalCoverage,
}) {
  const config = getConfig();
  const jakartaDate = getJakartaDate();
  const jakartaTime = getJakartaTime();
  const periods = statistics?.periods || {};
  const curr = currentRate || statistics?.currentRate;

  const lines = [];

  // Header
  lines.push("*USD/IDR MARKET UPDATE*");
  lines.push(`${jakartaDate} • ${jakartaTime} WIB`);
  lines.push("");

  // Current rate
  if (curr != null) {
    lines.push("*Kurs saat ini*");
    lines.push(`1 USD = ${formatIdr(curr)}`);
    lines.push("");
  } else {
    lines.push("⚠️ Data kurs belum tersedia.");
    lines.push("");
    return lines.join("\n");
  }

  // Changes
  lines.push("*Perubahan*");
  for (const period of ["1H", "1D", "7D", "1M", "1Y"]) {
    const p = periods[period];
    if (!p) continue;

    const pct = formatPercent(p.percentageChange);
    const abs = formatAbsoluteChange(p.absoluteChange);

    let coverageLabel = "";
    if (!p.complete && p.availablePoints > 0) {
      coverageLabel = " ⚠️";
    }

    lines.push(`${period.padEnd(3)}  ${abs.padEnd(14)} ${pct}${coverageLabel}`);
  }
  lines.push("");

  // Recorded ranges
  lines.push("*Rentang tercatat*");
  for (const period of ["1D", "7D", "1M", "1Y"]) {
    const p = periods[period];
    if (!p) continue;

    if (p.high != null && p.low != null) {
      lines.push(`${period.padEnd(3)}  ${formatIdrCompact(p.low)} — ${formatIdrCompact(p.high)}`);
    } else {
      lines.push(`${period.padEnd(3)}  Data belum cukup`);
    }
  }
  lines.push("");

  // Position
  lines.push("*Posisi dalam rentang*");
  for (const period of ["1D", "7D", "1M", "1Y"]) {
    const p = periods[period];
    if (!p || p.rangePosition == null) continue;

    let posLabel;
    const pos = p.rangePosition;
    if (pos <= 20) posLabel = "dekat area terendah";
    else if (pos <= 40) posLabel = "bagian bawah";
    else if (pos <= 60) posLabel = "tengah rentang";
    else if (pos <= 80) posLabel = "bagian atas";
    else posLabel = "dekat area tertinggi";

    lines.push(`• ${period}: ${pos.toFixed(0)}% — ${posLabel}`);
  }
  lines.push("");

  // Summary
  if (trend?.narrative) {
    lines.push("*Ringkasan*");
    lines.push(trend.narrative);
    lines.push("");
  }

  // Significant movement highlights
  if (trend?.highlights?.length > 0) {
    lines.push("*Pergerakan signifikan*");
    for (const h of trend.highlights) {
      lines.push(h);
    }
    lines.push("");
  }

  // Volatility
  lines.push("*Volatilitas rentang*");
  for (const period of ["1D", "7D"]) {
    const p = periods[period];
    if (!p) continue;
    if (p.rangePercentage != null) {
      lines.push(`${period}: ${p.rangePercentage.toFixed(2)}%`);
    }
  }
  lines.push("");

  // Market context
  if (marketContext && marketContext.articles && marketContext.articles.length > 0 &&
      process.env.FX_SHOW_NEWS_CONTEXT !== "false") {
    lines.push("*Konteks yang mungkin relevan*");
    for (const article of marketContext.articles.slice(0, 3)) {
      const title = article.headline || article.title || article.displayTitle || "";
      const pub = article.publisher || article.source || "";
      if (title) {
        lines.push(`• ${title}${pub ? ` — ${pub}` : ""}`);
      }
    }
    lines.push("");
  } else if (!marketContext || marketContext.status === "failed" || !marketContext.articles?.length) {
    lines.push("_Konteks berita terbaru belum tersedia._");
    lines.push("");
  }

  // Data coverage note
  if (process.env.FX_SHOW_DATA_COVERAGE !== "false" && historicalCoverage) {
    const cov = historicalCoverage;
    if (cov.availableDates && cov.missingDates && cov.total) {
      const avail = cov.availableDates.size;
      if (avail < cov.total) {
        lines.push(
          `_Cakupan data 1Y: ${avail}/${cov.total} hari tersedia (parsial)._`
        );
        lines.push("");
      }
    }
  }

  // Source and timestamps
  lines.push(`Data kurs diperbarui: ${formatWibTimeShort(providerTimestamp)}`);
  if (contextUpdatedAt) {
    lines.push(
      `Konteks berita diperbarui: ${new Date(contextUpdatedAt).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hour12: false })} WIB`
    );
  }

  lines.push("");
  lines.push("_Sumber kurs: Open Exchange Rates_");
  lines.push("_Catatan: kurs indikatif, bukan kurs transaksi bank atau JISDOR._");

  return lines.join("\n");
}

/**
 * Format a compact version of the hourly report.
 */
function formatCompactReport({
  currentRate,
  statistics,
  trend,
  providerTimestamp,
}) {
  const jakartaTime = getJakartaTime();
  const periods = statistics?.periods || {};
  const curr = currentRate || statistics?.currentRate;

  const lines = [];

  lines.push(`*USD/IDR* • ${jakartaTime} WIB`);
  if (curr != null) {
    lines.push(`Sekarang: ${formatIdr(curr)}`);
  }
  lines.push("");

  // Compact changes
  const changeParts = [];
  for (const period of ["1H", "1D", "7D", "1M", "1Y"]) {
    const p = periods[period];
    if (p?.percentageChange != null) {
      changeParts.push(`${period} ${formatPercent(p.percentageChange)}`);
    }
  }
  lines.push(changeParts.join(" | "));
  lines.push("");

  // Compact ranges
  lines.push("*High/Low:*");
  for (const period of ["1D", "7D", "1M", "1Y"]) {
    const p = periods[period];
    if (p?.high != null && p?.low != null) {
      lines.push(`${period} ${formatIdrCompact(p.low)}–${formatIdrCompact(p.high)}`);
    }
  }
  lines.push("");

  // Narrative
  if (trend?.narrative) {
    lines.push(trend.narrative);
    lines.push("");
  }

  lines.push(`_Sumber: Open Exchange Rates_`);

  return lines.join("\n");
}

// ── Exports ───────────────────────────────────────────────

module.exports = {
  // Statistics
  calculatePeriodStatistics,
  calculateAllStatistics,
  findReferenceRate,

  // Trend
  classifyTrend,

  // Formatting
  formatReport,
  formatCompactReport,
  formatIdr,
  formatIdrCompact,
  formatPercent,
  formatAbsoluteChange,
  formatWibTime,
  formatWibTimeShort,
  getJakartaDate,
  getJakartaTime,
};
