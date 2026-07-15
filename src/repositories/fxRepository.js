// FX Repository — Turso persistence for USD/IDR market intelligence.
// Manages: rate snapshots, execution slots, market context, API usage, backfill.
// Persistent idempotency via atomic slot acquisition (ON CONFLICT DO NOTHING).

const { getTursoClient } = require("../core/tursoClient");
const crypto = require("crypto");

// ── State ─────────────────────────────────────────────────

let client = null;
let ready = false;
let storageMode = "unavailable"; // 'turso' | 'unavailable'

// ── Initialization ────────────────────────────────────────

async function init(logger) {
  client = getTursoClient();

  if (!client) {
    storageMode = "unavailable";
    logger?.warn("[FX Repo] No Turso client — persistent storage unavailable");
    return;
  }

  try {
    // Rate snapshots table
    await client.execute(`
      CREATE TABLE IF NOT EXISTS fx_rate_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        base_currency TEXT NOT NULL,
        quote_currency TEXT NOT NULL,
        rate REAL NOT NULL,
        provider_timestamp INTEGER NOT NULL,
        fetched_at TEXT NOT NULL,
        granularity TEXT NOT NULL,
        source_date TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(provider, base_currency, quote_currency, provider_timestamp, granularity)
      )
    `);

    await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_fx_rate_window
      ON fx_rate_snapshots(provider, base_currency, quote_currency, granularity, provider_timestamp)
    `);

    await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_fx_rate_date
      ON fx_rate_snapshots(source_date)
    `);

    // Execution slots table (persistent idempotency)
    await client.execute(`
      CREATE TABLE IF NOT EXISTS fx_execution_slots (
        slot_key TEXT PRIMARY KEY,
        slot_type TEXT NOT NULL,
        status TEXT NOT NULL,
        attempted_at TEXT,
        completed_at TEXT,
        lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_fx_slots_status
      ON fx_execution_slots(status)
    `);

    await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_fx_slots_type
      ON fx_execution_slots(slot_type)
    `);

    // Market context cache
    await client.execute(`
      CREATE TABLE IF NOT EXISTS fx_market_context (
        context_id TEXT PRIMARY KEY,
        generated_at TEXT NOT NULL,
        valid_until TEXT,
        articles_json TEXT NOT NULL,
        narrative TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_fx_context_status
      ON fx_market_context(status)
    `);

    // API usage cache
    await client.execute(`
      CREATE TABLE IF NOT EXISTS fx_api_usage (
        provider TEXT PRIMARY KEY,
        month_key TEXT NOT NULL,
        requests_used INTEGER,
        requests_remaining INTEGER,
        requests_quota INTEGER,
        checked_at TEXT NOT NULL
      )
    `);

    ready = true;
    storageMode = "turso";
    logger?.info("[FX Repo] Connected to Turso — all tables ready");
  } catch (err) {
    storageMode = "unavailable";
    logger?.error({ err }, "[FX Repo] Turso initialization failed");
  }
}

function isPersistent() {
  return storageMode === "turso" && ready;
}

function getStorageMode() {
  return storageMode;
}

// ── Helpers ───────────────────────────────────────────────

function nowISO() {
  return new Date().toISOString();
}

function _exec(sql, args) {
  if (!client || !ready) return null;
  return client.execute({ sql, args });
}

// ── Rate Snapshots ────────────────────────────────────────

async function insertRateSnapshot({ provider, base, quote, rate, providerTimestamp, granularity, sourceDate }) {
  if (!isPersistent()) return null;

  const fetchedAt = nowISO();

  try {
    const result = await _exec(
      `INSERT INTO fx_rate_snapshots
       (provider, base_currency, quote_currency, rate, provider_timestamp, fetched_at, granularity, source_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, base_currency, quote_currency, provider_timestamp, granularity) DO NOTHING`,
      [provider, base, quote, rate, providerTimestamp, fetchedAt, granularity, sourceDate || null]
    );

    if (result.rowsAffected === 0) {
      // Duplicate — already stored
      return null;
    }

    return {
      id: Number(result.lastInsertRowid),
      provider,
      baseCurrency: base,
      quoteCurrency: quote,
      rate,
      providerTimestamp,
      fetchedAt,
      granularity,
      sourceDate: sourceDate || null,
    };
  } catch (err) {
    throw err;
  }
}

async function getLatestRate() {
  if (!isPersistent()) return null;

  try {
    const result = await _exec(
      `SELECT rate, provider_timestamp, fetched_at
       FROM fx_rate_snapshots
       WHERE granularity = 'hourly'
       ORDER BY provider_timestamp DESC
       LIMIT 1`,
      []
    );

    if (result && result.rows.length > 0) {
      const row = result.rows[0];
      return {
        rate: row.rate,
        providerTimestamp: row.provider_timestamp,
        fetchedAt: row.fetched_at,
      };
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function getRatesForWindow({ start, end, granularity, provider, base, quote }) {
  if (!isPersistent()) return [];

  const prov = provider || "open_exchange_rates";
  const b = base || "USD";
  const q = quote || "IDR";

  try {
    let sql = `SELECT rate, provider_timestamp, fetched_at, granularity, source_date
               FROM fx_rate_snapshots
               WHERE provider = ? AND base_currency = ? AND quote_currency = ?
               AND provider_timestamp >= ? AND provider_timestamp <= ?`;

    const args = [prov, b, q, start, end];

    if (granularity) {
      sql += ` AND granularity = ?`;
      args.push(granularity);
    }

    sql += ` ORDER BY provider_timestamp ASC`;

    const result = await _exec(sql, args);

    if (!result) return [];

    return result.rows.map((row) => ({
      rate: row.rate,
      providerTimestamp: row.provider_timestamp,
      fetchedAt: row.fetched_at,
      granularity: row.granularity,
      sourceDate: row.source_date,
    }));
  } catch (err) {
    return [];
  }
}

async function getSnapshotForHourlySlot(slot) {
  if (!isPersistent()) return null;

  // slot is like "2026-07-14:15" — map to a rough UTC timestamp range for that hour
  try {
    const [datePart, hourPart] = slot.split(":");
    const hour = parseInt(hourPart, 10);

    // Convert Jakarta hour to approximate UTC timestamp range
    // Jakarta is UTC+7, so: utcHour = jakartaHour - 7
    const utcHour = (hour - 7 + 24) % 24;
    const startDate = new Date(`${datePart}T${String(utcHour).padStart(2, "0")}:00:00.000Z`);
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);

    const startTs = Math.floor(startDate.getTime() / 1000);
    const endTs = Math.floor(endDate.getTime() / 1000);

    const result = await _exec(
      `SELECT rate, provider_timestamp, fetched_at, granularity, source_date
       FROM fx_rate_snapshots
       WHERE granularity = 'hourly'
       AND provider = 'open_exchange_rates'
       AND base_currency = 'USD'
       AND quote_currency = 'IDR'
       AND provider_timestamp >= ? AND provider_timestamp < ?
       ORDER BY provider_timestamp DESC
       LIMIT 1`,
      [startTs, endTs]
    );

    if (result && result.rows.length > 0) {
      const row = result.rows[0];
      return {
        rate: row.rate,
        providerTimestamp: row.provider_timestamp,
        fetchedAt: row.fetched_at,
      };
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function getHistoricalCoverage(days) {
  if (!isPersistent()) return { availableDates: new Set(), missingDates: new Set(), total: days };

  const now = new Date();
  const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  try {
    const result = await _exec(
      `SELECT DISTINCT source_date
       FROM fx_rate_snapshots
       WHERE granularity = 'daily_historical'
       AND provider = 'open_exchange_rates'
       AND base_currency = 'USD'
       AND quote_currency = 'IDR'
       AND source_date IS NOT NULL
       AND source_date >= ?
       ORDER BY source_date ASC`,
      [startDate.toISOString().slice(0, 10)]
    );

    const availableDates = new Set();
    if (result) {
      for (const row of result.rows) {
        availableDates.add(row.source_date);
      }
    }

    const missingDates = new Set();
    for (let d = new Date(startDate); d <= now; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      if (!availableDates.has(dateStr)) {
        missingDates.add(dateStr);
      }
    }

    return { availableDates, missingDates, total: days };
  } catch (err) {
    return { availableDates: new Set(), missingDates: new Set(), total: days };
  }
}

async function getMissingHistoricalDates({ startDate, endDate, provider, base, quote }) {
  const prov = provider || "open_exchange_rates";
  const b = base || "USD";
  const q = quote || "IDR";

  try {
    const result = await _exec(
      `SELECT DISTINCT source_date
       FROM fx_rate_snapshots
       WHERE granularity = 'daily_historical'
       AND provider = ? AND base_currency = ? AND quote_currency = ?
       AND source_date IS NOT NULL
       AND source_date >= ? AND source_date <= ?`,
      [prov, b, q, startDate, endDate]
    );

    const existing = new Set();
    if (result) {
      for (const row of result.rows) {
        existing.add(row.source_date);
      }
    }

    const missing = [];
    const start = new Date(startDate + "T00:00:00Z");
    const end = new Date(endDate + "T00:00:00Z");
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      if (!existing.has(dateStr)) {
        missing.push(dateStr);
      }
    }

    return missing;
  } catch (err) {
    return [];
  }
}

// ── Execution Slots (Persistent Idempotency) ───────────────

/**
 * Atomically acquire an execution slot.
 * Uses INSERT ... ON CONFLICT DO NOTHING for atomicity.
 * Also handles lease recovery: if a processing slot's lease has expired,
 * reclaim it by updating the status.
 *
 * @returns {boolean} true if slot was acquired, false if already taken
 */
function canReacquireExecutionSlot(status) {
  return status === "failed";
}

async function acquireExecutionSlot({ slotKey, slotType, leaseDurationMs }) {
  if (!isPersistent()) return false;

  const now = nowISO();
  const leaseExpires = new Date(Date.now() + leaseDurationMs).toISOString();

  try {
    // First, try to reclaim expired processing slots
    await _exec(
      `UPDATE fx_execution_slots
       SET status = 'failed',
           error_code = 'LEASE_EXPIRED',
           error_message = 'Previous execution lease expired — reclaimed',
           updated_at = ?
       WHERE slot_key = ? AND status = 'processing' AND lease_expires_at < ?`,
      [now, slotKey, now]
    );

    // Now try atomic insert
    const result = await _exec(
      `INSERT INTO fx_execution_slots
       (slot_key, slot_type, status, attempted_at, lease_expires_at, attempt_count, created_at, updated_at)
       VALUES (?, ?, 'processing', ?, ?, 1, ?, ?)
       ON CONFLICT(slot_key) DO NOTHING`,
      [slotKey, slotType, now, leaseExpires, now, now]
    );

    // If rows affected = 0, slot already exists
    if (!result || result.rowsAffected === 0) {
      // Check if existing slot is in a final state (completed/partial/failed/suppressed)
      const existing = await getExecutionSlot(slotKey);
      if (existing && canReacquireExecutionSlot(existing.status)) {
        const retryResult = await _exec(
          `UPDATE fx_execution_slots
           SET status = 'processing',
               attempted_at = ?,
               lease_expires_at = ?,
               attempt_count = attempt_count + 1,
               error_code = NULL,
               error_message = NULL,
               updated_at = ?
           WHERE slot_key = ? AND status = 'failed'`,
          [now, leaseExpires, now, slotKey]
        );
        return retryResult && retryResult.rowsAffected > 0;
      }
      if (existing && !["completed", "partial", "failed", "suppressed"].includes(existing.status)) {
        // Slot is processing — check if lease expired
        if (existing.leaseExpiresAt && new Date(existing.leaseExpiresAt) < new Date()) {
          // Lease expired, try to reclaim by updating
          const updateResult = await _exec(
            `UPDATE fx_execution_slots
             SET status = 'processing',
                 attempted_at = ?,
                 lease_expires_at = ?,
                 attempt_count = attempt_count + 1,
                 error_code = NULL,
                 error_message = NULL,
                 updated_at = ?
             WHERE slot_key = ? AND status = 'processing' AND lease_expires_at < ?`,
            [now, leaseExpires, now, slotKey, now]
          );
          return updateResult && updateResult.rowsAffected > 0;
        }
        return false; // Still processing by another worker
      }
      return false; // Already in a final state
    }

    return true;
  } catch (err) {
    return false;
  }
}

async function getExecutionSlot(slotKey) {
  if (!isPersistent()) return null;

  try {
    const result = await _exec(
      `SELECT slot_key, slot_type, status, attempted_at, completed_at,
              lease_expires_at, attempt_count, error_code, error_message,
              created_at, updated_at
       FROM fx_execution_slots
       WHERE slot_key = ?`,
      [slotKey]
    );

    if (result && result.rows.length > 0) {
      const row = result.rows[0];
      return {
        slotKey: row.slot_key,
        slotType: row.slot_type,
        status: row.status,
        attemptedAt: row.attempted_at,
        completedAt: row.completed_at,
        leaseExpiresAt: row.lease_expires_at,
        attemptCount: row.attempt_count,
        errorCode: row.error_code,
        errorMessage: row.error_message,
      };
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function completeExecutionSlot(slotKey) {
  if (!isPersistent()) return;

  const now = nowISO();
  try {
    await _exec(
      `UPDATE fx_execution_slots
       SET status = 'completed', completed_at = ?, updated_at = ?
       WHERE slot_key = ?`,
      [now, now, slotKey]
    );
  } catch (err) {
    // Silently fail — slot will be retried next run
  }
}

async function failExecutionSlot(slotKey, { errorCode, errorMessage }) {
  if (!isPersistent()) return;

  const now = nowISO();
  try {
    await _exec(
      `UPDATE fx_execution_slots
       SET status = 'failed',
           error_code = ?,
           error_message = ?,
           updated_at = ?
       WHERE slot_key = ?`,
      [errorCode || "FX_UNKNOWN", (errorMessage || "").slice(0, 500), now, slotKey]
    );
  } catch (err) {
    // Silently fail
  }
}

async function suppressExecutionSlot(slotKey, reason) {
  if (!isPersistent()) return;

  const now = nowISO();
  try {
    await _exec(
      `UPDATE fx_execution_slots
       SET status = 'suppressed',
           error_code = 'SUPPRESSED',
           error_message = ?,
           completed_at = ?,
           updated_at = ?
       WHERE slot_key = ?`,
      [(reason || "suppressed").slice(0, 200), now, now, slotKey]
    );
  } catch (err) {
    // Silently fail
  }
}

// ── Market Context ────────────────────────────────────────

async function saveMarketContext({ contextId, generatedAt, validUntil, articles, narrative, status }) {
  if (!isPersistent()) return null;

  try {
    await _exec(
      `INSERT OR REPLACE INTO fx_market_context
       (context_id, generated_at, valid_until, articles_json, narrative, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contextId || `ctx-${Date.now()}`,
        generatedAt || nowISO(),
        validUntil || null,
        JSON.stringify(articles || []),
        narrative || "",
        status || "ready",
      ]
    );
    return { contextId, generatedAt, status };
  } catch (err) {
    return null;
  }
}

async function getLatestValidContext(maxAgeHours) {
  if (!isPersistent()) return null;

  const cutoff = new Date(Date.now() - (maxAgeHours || 12) * 60 * 60 * 1000).toISOString();

  try {
    const result = await _exec(
      `SELECT context_id, generated_at, valid_until, articles_json, narrative, status
       FROM fx_market_context
       WHERE generated_at >= ?
       ORDER BY generated_at DESC
       LIMIT 1`,
      [cutoff]
    );

    if (result && result.rows.length > 0) {
      const row = result.rows[0];
      let articles = [];
      try {
        articles = JSON.parse(row.articles_json);
      } catch (e) {
        articles = [];
      }

      return {
        contextId: row.context_id,
        generatedAt: row.generated_at,
        validUntil: row.valid_until,
        articles,
        narrative: row.narrative,
        status: row.status,
      };
    }
    return null;
  } catch (err) {
    return null;
  }
}

// ── API Usage ─────────────────────────────────────────────

async function saveApiUsage({ provider, monthKey, requestsUsed, requestsRemaining, requestsQuota }) {
  if (!isPersistent()) return;

  const checkedAt = nowISO();
  try {
    await _exec(
      `INSERT OR REPLACE INTO fx_api_usage
       (provider, month_key, requests_used, requests_remaining, requests_quota, checked_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [provider, monthKey, requestsUsed, requestsRemaining, requestsQuota, checkedAt]
    );
  } catch (err) {
    // Silently fail
  }
}

async function getApiUsage(provider) {
  if (!isPersistent()) return null;

  try {
    const result = await _exec(
      `SELECT provider, month_key, requests_used, requests_remaining, requests_quota, checked_at
       FROM fx_api_usage
       WHERE provider = ?
       ORDER BY checked_at DESC
       LIMIT 1`,
      [provider]
    );

    if (result && result.rows.length > 0) {
      const row = result.rows[0];
      return {
        provider: row.provider,
        monthKey: row.month_key,
        requestsUsed: row.requests_used,
        requestsRemaining: row.requests_remaining,
        requestsQuota: row.requests_quota,
        checkedAt: row.checked_at,
      };
    }
    return null;
  } catch (err) {
    return null;
  }
}

// ── Backfill Progress ─────────────────────────────────────

async function saveBackfillProgress({ date, status }) {
  // Uses execution slots table with type 'historical-backfill'
  return acquireExecutionSlot({
    slotKey: `fx-backfill:USD-IDR:${date}`,
    slotType: "historical-backfill",
    leaseDurationMs: 30 * 60 * 1000,
  });
}

// ── Exports ───────────────────────────────────────────────

module.exports = {
  // Lifecycle
  init,
  isPersistent,
  getStorageMode,

  // Rate snapshots
  insertRateSnapshot,
  getLatestRate,
  getRatesForWindow,
  getSnapshotForHourlySlot,
  getHistoricalCoverage,
  getMissingHistoricalDates,

  // Execution slots
  canReacquireExecutionSlot,
  acquireExecutionSlot,
  getExecutionSlot,
  completeExecutionSlot,
  failExecutionSlot,
  suppressExecutionSlot,

  // Market context
  saveMarketContext,
  getLatestValidContext,

  // API usage
  saveApiUsage,
  getApiUsage,

  // Backfill
  saveBackfillProgress,
};
