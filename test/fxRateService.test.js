// FX Rate Service tests — pure deterministic statistics, trends, formatting.
// No mocking needed — all functions are pure.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  calculatePeriodStatistics,
  calculateAllStatistics,
  classifyTrend,
  formatReport,
  formatCompactReport,
  formatIdr,
  formatPercent,
  formatAbsoluteChange,
} = require("../src/services/fxRateService");

// ── Helpers ───────────────────────────────────────────────

function makeRates(pairs) {
  // pairs: Array<[unixTimestamp, rate]>
  return pairs.map(([ts, rate]) => ({ providerTimestamp: ts, rate }));
}

describe("FX Rate Service — IDR Formatting", () => {
  it("formats whole number as currency", () => {
    const result = formatIdr(18125);
    assert.ok(result.includes("Rp"));
    assert.ok(result.includes("18.125"));
  });

  it("formats with decimals", () => {
    const result = formatIdr(18125.45);
    assert.ok(result.includes("18.125,45"));
  });

  it("handles null", () => {
    assert.equal(formatIdr(null), "N/A");
  });

  it("handles NaN", () => {
    assert.equal(formatIdr(NaN), "N/A");
  });
});

describe("FX Rate Service — Percentage Formatting", () => {
  it("formats positive percentage", () => {
    assert.ok(formatPercent(0.47).startsWith("+"));
    assert.ok(formatPercent(0.47).endsWith("%"));
  });

  it("formats negative percentage", () => {
    assert.ok(formatPercent(-0.28).startsWith("-"));
  });

  it("handles null", () => {
    assert.equal(formatPercent(null), "N/A");
  });
});

describe("FX Rate Service — Period Statistics", () => {
  const now = 1720950000; // Some fixed timestamp
  const currentRate = 18200;

  it("calculates 1D statistics with full data", () => {
    // Include a reference rate at the window start boundary
    const windowStart = now - 24 * 3600;
    const rates = [
      { providerTimestamp: windowStart, rate: 18000 }, // reference at boundary
      ...makeRates(
        Array.from({ length: 24 }, (_, i) => [
          now - (23 - i) * 3600,
          18000 + i * 10,
        ])
      ),
    ];
    // Current rate
    rates.push({ providerTimestamp: now, rate: currentRate });

    const result = calculatePeriodStatistics(rates, {
      period: "1D",
      windowStart: now - 24 * 3600,
      windowEnd: now,
      granularity: "hourly",
      expectedPoints: 24,
      coverageThreshold: 90,
      currentRate,
    });

    assert.equal(result.period, "1D");
    assert.ok(result.complete);
    assert.ok(result.high > result.low);
    assert.equal(result.availablePoints, 26); // 1 ref + 24 hourly + 1 current
    assert.ok(result.coveragePercentage >= 95);
  });

  it("handles empty rates", () => {
    const result = calculatePeriodStatistics([], {
      period: "1M",
      windowStart: now - 30 * 24 * 3600,
      windowEnd: now,
      granularity: "daily",
      expectedPoints: 30,
      coverageThreshold: 90,
      currentRate: 18000,
    });

    assert.equal(result.complete, false);
    assert.equal(result.availablePoints, 0);
    assert.equal(result.high, null);
    assert.equal(result.low, null);
  });

  it("handles equal high and low (single data point)", () => {
    const rates = [{ providerTimestamp: now, rate: 18000 }];
    const result = calculatePeriodStatistics(rates, {
      period: "1D",
      windowStart: now - 24 * 3600,
      windowEnd: now,
      granularity: "hourly",
      expectedPoints: 24,
      coverageThreshold: 90,
      currentRate: 18000,
    });

    assert.equal(result.high, 18000);
    assert.equal(result.low, 18000);
    assert.equal(result.rangePosition, 50); // Equal high/low → middle
  });

  it("calculates range position correctly", () => {
    const rates = makeRates([
      [now - 3600, 17900], // low
      [now - 1800, 18000],
      [now, 18100],        // high = current
    ]);

    const result = calculatePeriodStatistics(rates, {
      period: "1D",
      windowStart: now - 24 * 3600,
      windowEnd: now,
      granularity: "hourly",
      expectedPoints: 24,
      coverageThreshold: 90,
      currentRate: 18100,
    });

    // Position: (18100 - 17900) / (18100 - 17900) * 100 = 100
    assert.ok(result.rangePosition > 95);
  });

  it("correctly identifies USD strengthening (IDR weakening)", () => {
    // USD/IDR rises → USD strengthens, IDR weakens
    const result = calculatePeriodStatistics(
      makeRates([
        [now - 24 * 3600, 18000],
        [now, 18100],
      ]),
      {
        period: "1D",
        windowStart: now - 24 * 3600,
        windowEnd: now,
        granularity: "hourly",
        expectedPoints: 24,
        coverageThreshold: 90,
        currentRate: 18100,
      }
    );

    // Reference at start: ~18000, current: 18100
    // Percentage change should be positive
    assert.ok(result.percentageChange > 0);
    assert.ok(result.absoluteChange > 0);
  });

  it("correctly identifies USD weakening (IDR strengthening)", () => {
    // USD/IDR falls → USD weakens, IDR strengthens
    const result = calculatePeriodStatistics(
      makeRates([
        [now - 24 * 3600, 18100],
        [now, 18000],
      ]),
      {
        period: "1D",
        windowStart: now - 24 * 3600,
        windowEnd: now,
        granularity: "hourly",
        expectedPoints: 24,
        coverageThreshold: 90,
        currentRate: 18000,
      }
    );

    assert.ok(result.percentageChange < 0);
    assert.ok(result.absoluteChange < 0);
  });
});

describe("FX Rate Service — Trend Classification", () => {
  it("classifies strengthening trend", () => {
    const stats = {
      periods: {
        "1D": { percentageChange: 1.5 },
        "7D": { percentageChange: 3.0 },
        "1Y": { rangePosition: 75 },
      },
    };
    const trend = classifyTrend(stats);
    assert.equal(trend.direction, "usd_strengthening");
  });

  it("classifies weakening trend", () => {
    const stats = {
      periods: {
        "1D": { percentageChange: -2.0 },
        "7D": { percentageChange: -1.5 },
        "1Y": { rangePosition: 25 },
      },
    };
    const trend = classifyTrend(stats);
    assert.equal(trend.direction, "usd_weakening");
  });

  it("classifies stable trend", () => {
    const stats = {
      periods: {
        "1D": { percentageChange: 0.02 },
        "7D": { percentageChange: 0.05 },
      },
    };
    const trend = classifyTrend(stats);
    assert.equal(trend.direction, "stable");
  });

  it("classifies mixed trend", () => {
    const stats = {
      periods: {
        "1D": { percentageChange: 1.5 },
        "7D": { percentageChange: -0.5 },
      },
    };
    const trend = classifyTrend(stats);
    assert.equal(trend.direction, "mixed");
  });

  it("handles insufficient data", () => {
    const stats = { periods: {} };
    const trend = classifyTrend(stats);
    assert.ok(trend.narrative.includes("Data belum cukup") || trend.direction === "stable");
  });
});

describe("FX Rate Service — Report Formatting", () => {
  it("formats full report without errors", () => {
    const report = formatReport({
      currentRate: 18200,
      statistics: {
        currentRate: 18200,
        periods: {
          "1H": { percentageChange: 0.05, absoluteChange: 10, complete: true },
          "1D": { percentageChange: 0.47, absoluteChange: 84.2, high: 18210, low: 18100, rangePosition: 72, rangePercentage: 0.61, availablePoints: 24, expectedPoints: 24, complete: true },
          "7D": { percentageChange: -0.28, absoluteChange: -51.8, high: 18300, low: 18050, rangePosition: 63, rangePercentage: 1.38, availablePoints: 160, expectedPoints: 168, complete: true },
          "1M": { percentageChange: 1.23, absoluteChange: 220.1, high: 18350, low: 17900, rangePosition: 70, rangePercentage: 2.51, availablePoints: 28, expectedPoints: 30, complete: true },
          "1Y": { percentageChange: 4.20, absoluteChange: 730.4, high: 18500, low: 16820, rangePosition: 78, rangePercentage: 9.99, availablePoints: 340, expectedPoints: 365, complete: false },
        },
      },
      trend: {
        direction: "mixed",
        narrative: "Arah jangka pendek dan mingguan masih bercampur.",
        highlights: [],
      },
      marketContext: null,
      providerTimestamp: 1720950000,
      contextUpdatedAt: null,
      historicalCoverage: { availableDates: new Set(["2026-01-01"]), total: 365 },
    });

    // Verify key sections
    assert.ok(report.includes("USD/IDR MARKET UPDATE"));
    assert.ok(report.includes("Kurs saat ini"));
    assert.ok(report.includes("Perubahan"));
    assert.ok(report.includes("Rentang tercatat"));
    assert.ok(report.includes("Posisi dalam rentang"));
    assert.ok(report.includes("Ringkasan"));
    assert.ok(report.includes("Open Exchange Rates"));
    // Data coverage note for incomplete 1Y
    assert.ok(report.includes("parsial") || report.includes("Data kurs"));
  });

  it("formats compact report without errors", () => {
    const report = formatCompactReport({
      currentRate: 18200,
      statistics: {
        periods: {
          "1H": { percentageChange: 0.05 },
          "1D": { percentageChange: 0.47, high: 18210, low: 18100 },
          "7D": { percentageChange: -0.28, high: 18300, low: 18050 },
          "1M": { percentageChange: 1.23, high: 18350, low: 17900 },
          "1Y": { percentageChange: 4.20, high: 18500, low: 16820 },
        },
      },
      trend: { narrative: "USD menguat terhadap rupiah dalam 24 jam." },
      providerTimestamp: 1720950000,
    });

    assert.ok(report.includes("USD/IDR"));
    assert.ok(report.includes("Sekarang"));
    assert.ok(report.includes("Open Exchange Rates"));
  });

  it("handles null current rate gracefully", () => {
    const report = formatReport({
      currentRate: null,
      statistics: { periods: {} },
      trend: null,
      marketContext: null,
      providerTimestamp: null,
      contextUpdatedAt: null,
      historicalCoverage: null,
    });

    assert.ok(report.includes("belum tersedia"));
  });
});
