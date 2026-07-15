// FX scheduler — single lifecycle module with two independent jobs.
//
// Job 1: USD/IDR rate collection + delivery — hourly at :05 from 07:05 to 21:05 WIB.
// Job 2: Market context refresh — every 3 hours from 07:15 to 19:15 WIB.
//
// One failure does not stop the other job.
// Persistent idempotency via fx_execution_slots table.

const { getSock } = require("../core/socket");
const { createWindowedScheduler } = require("./windowedScheduler");
const { shouldSuppressCron } = require("../services/birthdayTakeoverService");
const provider = require("../services/fxRateProvider");
const rateService = require("../services/fxRateService");
const marketContextService = require("../services/fxMarketContextService");
const repository = require("../repositories/fxRepository");

// ── Module State ──────────────────────────────────────────

let running = false;
const RATE_SCHEDULES = Array.from({ length: 15 }, (_, index) => {
  const hour = index + 7;
  const label = String(hour).padStart(2, "0");
  return { id: `rate-${label}`, time: `${label}:05` };
});
const CONTEXT_SCHEDULES = [7, 10, 13, 16, 19].map((hour) => {
  const label = String(hour).padStart(2, "0");
  return { id: `context-${label}`, time: `${label}:15` };
});

let rateScheduler = null;
let contextScheduler = null;
let logger = null;
let targetJid = "";

// ── Configuration Helpers ─────────────────────────────────

function getJakartaHourlySlot(scheduledSlot) {
  if (scheduledSlot?.date && scheduledSlot?.time) {
    if (scheduledSlot.testMode) {
      return `${scheduledSlot.date}:${scheduledSlot.time.replace(":", "-")}`;
    }
    return `${scheduledSlot.date}:${scheduledSlot.time.slice(0, 2)}`;
  }
  const now = new Date();
  const wib = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  const year = wib.getFullYear();
  const month = String(wib.getMonth() + 1).padStart(2, "0");
  const day = String(wib.getDate()).padStart(2, "0");
  const hour = String(wib.getHours()).padStart(2, "0");
  return `${year}-${month}-${day}:${hour}`;
}

function getJakartaContextSlot(scheduledSlot) {
  if (scheduledSlot?.date && scheduledSlot?.time) {
    const hour = parseInt(scheduledSlot.time.slice(0, 2), 10);
    if (scheduledSlot.testMode) {
      return {
        threeHourSlot: `${scheduledSlot.date}:${scheduledSlot.time.replace(":", "-")}`,
        hour,
      };
    }
    return { threeHourSlot: `${scheduledSlot.date}:${String(hour).padStart(2, "0")}`, hour };
  }
  const now = new Date();
  const wib = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  const year = wib.getFullYear();
  const month = String(wib.getMonth() + 1).padStart(2, "0");
  const day = String(wib.getDate()).padStart(2, "0");
  const hour = Math.floor(wib.getHours() / 3) * 3;
  return {
    threeHourSlot: `${year}-${month}-${day}:${String(hour).padStart(2, "0")}`,
    hour,
  };
}

function getLeaseConfig() {
  return {
    collectMs: parseInt(process.env.FX_LEASE_COLLECT_MS || "300000", 10),
    deliveryMs: parseInt(process.env.FX_LEASE_DELIVERY_MS || "300000", 10),
    contextMs: parseInt(process.env.FX_LEASE_CONTEXT_MS || "900000", 10),
  };
}

// ── Sanitization ──────────────────────────────────────────

function sanitizeError(error) {
  if (!error) return { errorCode: "FX_UNKNOWN", errorMessage: "Unknown error" };

  if (error.errorCode) {
    return {
      errorCode: error.errorCode,
      errorMessage: String(error.errorMessage || "").slice(0, 500),
    };
  }

  let message = String(error.message || error).slice(0, 500);
  message = message
    .replace(/app_id=[^&\s]+/gi, "app_id=[REDACTED]")
    .replace(/api[_-]?key=[^&\s]+/gi, "api_key=[REDACTED]");

  return { errorCode: "FX_ERROR", errorMessage: message };
}

// ── Lifecycle ─────────────────────────────────────────────

function start({ logger: log, targetJid: jid } = {}) {
  if (running) {
    log?.warn("[FX Scheduler] Already running — skipping");
    return;
  }

  if (process.env.FX_USD_IDR_ENABLED === "false") {
    log?.info("[FX Scheduler] FX_USD_IDR_ENABLED=false — not starting");
    return;
  }

  if (!repository.isPersistent()) {
    log?.error("[FX Scheduler] Persistent storage unavailable — cannot start");
    return;
  }

  logger = log;
  targetJid = jid || process.env.FX_USD_IDR_TARGET_JID || process.env.GROUP_JID || "";
  running = true;

  rateScheduler = createWindowedScheduler({
    name: "FX Rate Scheduler",
    slots: RATE_SCHEDULES,
    task: (slot, meta) => runHourlyRateUpdate({ reason: meta.reason, scheduledSlot: slot }),
    logger,
  });
  rateScheduler.start();
  logger?.info("[FX Scheduler] Rate job scheduled hourly from 07:05 through 21:05 WIB");

  if (process.env.FX_MARKET_CONTEXT_ENABLED !== "false") {
    contextScheduler = createWindowedScheduler({
      name: "FX Context Scheduler",
      slots: CONTEXT_SCHEDULES,
      task: (slot, meta) => runMarketContextRefresh({ reason: meta.reason, scheduledSlot: slot }),
      logger,
    });
    contextScheduler.start();
    logger?.info("[FX Scheduler] Context job scheduled at 07:15, 10:15, 13:15, 16:15, and 19:15 WIB");
  }

  if (!targetJid) {
    logger?.warn("[FX Scheduler] No target JID — delivery disabled");
  }

  logger?.info("[FX Scheduler] Started");
}

function stop() {
  running = false;
  rateScheduler?.stop();
  contextScheduler?.stop();
  rateScheduler = null;
  contextScheduler = null;
  logger?.info("[FX Scheduler] Stopped");
}

async function resume() {
  const results = await Promise.all([
    rateScheduler?.resume() || false,
    contextScheduler?.resume() || false,
  ]);
  return results.some(Boolean);
}

function isRunning() {
  return running;
}

// ── Job 1: Hourly Rate Update ─────────────────────────────

async function runHourlyRateUpdate({ reason, scheduledSlot } = {}) {
  const isManual = reason === "manual";

  // Only check suppression for automatic runs
  if (!isManual && !running) return;

  const slot = getJakartaHourlySlot(scheduledSlot);
  const collectKey = `fx-collect:USD-IDR:${slot}`;
  const deliveryKey = `fx-delivery:USD-IDR:${slot}`;
  const leases = getLeaseConfig();

  logger?.info({ slot, reason: reason || "scheduled" }, "[FX Scheduler] Hourly rate update");

  // ── Collection ──
  const collectState = await repository.getExecutionSlot(collectKey);
  let snapshot;

  if (collectState?.status !== "completed") {
    const acquired = await repository.acquireExecutionSlot({
      slotKey: collectKey,
      slotType: "rate-collect",
      leaseDurationMs: leases.collectMs,
    });

    if (acquired) {
      try {
        const rateData = await provider.fetchLatest(logger);
        provider.validateRateResponse(rateData);

        const snapshotResult = await repository.insertRateSnapshot({
          provider: "open_exchange_rates",
          base: rateData.base,
          quote: "IDR",
          rate: rateData.rates.IDR,
          providerTimestamp: rateData.timestamp,
          granularity: "hourly",
          sourceDate: null,
        });

        if (snapshotResult) {
          snapshot = snapshotResult;
        }

        await repository.completeExecutionSlot(collectKey);
        logger?.info({ slot, rate: rateData.rates.IDR }, "[FX Scheduler] Rate collected");
      } catch (error) {
        await repository.failExecutionSlot(collectKey, sanitizeError(error));
        logger?.error({ err: sanitizeError(error) }, "[FX Scheduler] Rate collection failed");
        return; // No snapshot → cannot deliver
      }
    }
  }

  // If collection was already completed (previous run), load stored snapshot
  if (!snapshot) {
    snapshot = await repository.getSnapshotForHourlySlot(slot);
  }

  if (!snapshot) {
    logger?.warn({ slot }, "[FX Scheduler] No snapshot available for delivery");
    return;
  }

  // ── Delivery (automatic runs only) ──
  if (isManual) {
    // Manual refresh: collect only, don't trigger group delivery
    return snapshot;
  }

  return handleHourlyDelivery({ slot, deliveryKey, snapshot });
}

async function handleHourlyDelivery({ slot, deliveryKey, snapshot }) {
  // Check if delivery already completed or suppressed
  const deliveryState = await repository.getExecutionSlot(deliveryKey);
  if (deliveryState?.status === "completed" || deliveryState?.status === "suppressed") {
    logger?.info({ slot }, "[FX Scheduler] Delivery already completed or suppressed");
    return true;
  }

  if (targetJid && !getSock()) {
    logger?.warn({ slot }, "[FX Scheduler] WhatsApp unavailable — pending until reconnect");
    return false;
  }

  const leases = getLeaseConfig();
  const acquired = await repository.acquireExecutionSlot({
    slotKey: deliveryKey,
    slotType: "rate-delivery",
    leaseDurationMs: leases.deliveryMs,
  });

  if (!acquired) {
    logger?.info({ slot }, "[FX Scheduler] Delivery slot already taken");
    return true;
  }

  try {
    // Check Birthday Takeover suppression
    if (targetJid && await shouldSuppressCron(targetJid, "fx-market")) {
      await repository.suppressExecutionSlot(deliveryKey, "birthday-takeover");
      logger?.info("[FX Scheduler] Birthday takeover — delivery suppressed");
      return true;
    }

    // Check auto-send toggle
    if (process.env.FX_USD_IDR_AUTO_SEND_ENABLED === "false") {
      await repository.suppressExecutionSlot(deliveryKey, "auto-send-disabled");
      logger?.info("[FX Scheduler] Auto-send disabled — delivery suppressed");
      return true;
    }

    // Build statistics
    const now = snapshot.providerTimestamp || Math.floor(Date.now() / 1000);
    const allRates = await repository.getRatesForWindow({
      start: now - 365 * 24 * 3600,
      end: now,
    });

    // Add current snapshot if not in results
    const hasCurrent = allRates.some(
      (r) => r.providerTimestamp === snapshot.providerTimestamp
    );
    if (!hasCurrent) {
      allRates.push(snapshot);
    }

    const coverage = await repository.getHistoricalCoverage(365);
    const statistics = rateService.calculateAllStatistics(allRates, snapshot, coverage);
    const trend = rateService.classifyTrend(statistics);

    // Load market context
    const maxAgeHours = parseInt(process.env.FX_MARKET_CONTEXT_MAX_AGE_HOURS || "12", 10);
    const context = await repository.getLatestValidContext(maxAgeHours);

    // Format report
    const messageMode = process.env.FX_HOURLY_MESSAGE_MODE || "full";
    let report;
    if (messageMode === "compact") {
      report = rateService.formatCompactReport({
        currentRate: snapshot.rate,
        statistics,
        trend,
        providerTimestamp: snapshot.providerTimestamp,
      });
    } else {
      report = rateService.formatReport({
        currentRate: snapshot.rate,
        statistics,
        trend,
        marketContext: context,
        providerTimestamp: snapshot.providerTimestamp,
        contextUpdatedAt: context?.generatedAt || null,
        historicalCoverage: coverage,
      });
    }

    // Send via WhatsApp
    if (targetJid) {
      const sock = getSock();
      if (!sock) {
        throw new Error("WhatsApp socket not available");
      }
      await sock.sendMessage(targetJid, { text: report });
      logger?.info({ slot }, "[FX Scheduler] Report delivered");
    }

    await repository.completeExecutionSlot(deliveryKey);
    return true;
  } catch (error) {
    await repository.failExecutionSlot(deliveryKey, sanitizeError(error));
    logger?.error({ err: sanitizeError(error) }, "[FX Scheduler] Delivery failed");
    return false;
  }
}

// ── Job 2: Market Context Refresh ─────────────────────────

async function runMarketContextRefresh({ reason, scheduledSlot } = {}) {
  if (process.env.FX_MARKET_CONTEXT_ENABLED === "false") return;

  const { threeHourSlot } = getJakartaContextSlot(scheduledSlot);
  const contextKey = `fx-context:USD-IDR:${threeHourSlot}`;
  const leases = getLeaseConfig();

  logger?.info({ slot: threeHourSlot, reason: reason || "scheduled" }, "[FX Scheduler] Context refresh");

  const state = await repository.getExecutionSlot(contextKey);
  if (state?.status === "completed" || state?.status === "partial") {
    logger?.info({ slot: threeHourSlot }, "[FX Scheduler] Context slot already processed");
    return;
  }

  const acquired = await repository.acquireExecutionSlot({
    slotKey: contextKey,
    slotType: "market-context",
    leaseDurationMs: leases.contextMs,
  });

  if (!acquired) {
    logger?.info({ slot: threeHourSlot }, "[FX Scheduler] Context slot already taken");
    return;
  }

  try {
    const result = await marketContextService.refreshContext({ logger });

    if (result.status === "ready" || result.status === "partial") {
      // Save context to repository
      await repository.saveMarketContext({
        contextId: result.contextId,
        generatedAt: result.generatedAt,
        validUntil: result.validUntil,
        articles: result.articles,
        narrative: result.narrative,
        status: result.status,
      });
      await repository.completeExecutionSlot(contextKey);
      logger?.info(
        { slot: threeHourSlot, articles: result.articles.length, status: result.status },
        "[FX Scheduler] Context refreshed and saved"
      );
    } else {
      // Failed — don't overwrite previous valid context
      await repository.failExecutionSlot(contextKey, {
        errorCode: "CONTEXT_FAILED",
        errorMessage: "No new context available",
      });
      logger?.warn({ slot: threeHourSlot }, "[FX Scheduler] Context refresh failed");
    }
  } catch (error) {
    await repository.failExecutionSlot(contextKey, sanitizeError(error));
    logger?.error({ err: sanitizeError(error) }, "[FX Scheduler] Context refresh error");
  }
}

// ── Manual Operations ─────────────────────────────────────

async function manualRefresh({ logger: log, replyCallback }) {
  const result = await runHourlyRateUpdate({ reason: "manual" });

  if (result) {
    // Build a quick report for the admin
    const allRates = await repository.getRatesForWindow({
      start: result.providerTimestamp - 24 * 3600,
      end: result.providerTimestamp,
    });
    allRates.push(result);

    const coverage = await repository.getHistoricalCoverage(365);
    const statistics = rateService.calculateAllStatistics(allRates, result, coverage);

    if (replyCallback) {
      const report = rateService.formatReport({
        currentRate: result.rate,
        statistics,
        trend: rateService.classifyTrend(statistics),
        marketContext: null,
        providerTimestamp: result.providerTimestamp,
        contextUpdatedAt: null,
        historicalCoverage: coverage,
      });
      await replyCallback(report);
    }
  }

  return result;
}

// ── Exports ───────────────────────────────────────────────

module.exports = {
  RATE_SCHEDULES,
  CONTEXT_SCHEDULES,
  getJakartaHourlySlot,
  getJakartaContextSlot,
  start,
  stop,
  resume,
  isRunning,
  runHourlyRateUpdate,
  runMarketContextRefresh,
  manualRefresh,
};
