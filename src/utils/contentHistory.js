// Content History — deduplication and send-tracking utility.
// Used by newsService.js and fxMarketContextService.js to prevent
// duplicate content delivery after bot reconnects.

const crypto = require("crypto");

// ── Configuration ─────────────────────────────────────────

const MAX_ENTRIES = 5000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Storage ───────────────────────────────────────────────

// Map<namespace, Map<hash, { timestamp, ttlTimer }>>
const _store = new Map();
let _totalEntries = 0;

function _ensureNamespace(namespace) {
  if (!_store.has(namespace)) {
    _store.set(namespace, new Map());
  }
  return _store.get(namespace);
}

// ── Eviction ──────────────────────────────────────────────

function _evictIfNeeded() {
  if (_totalEntries <= MAX_ENTRIES) return;

  // Find oldest entry across all namespaces (FIFO)
  let oldestNs = null;
  let oldestHash = null;
  let oldestTs = Infinity;

  for (const [ns, map] of _store) {
    for (const [hash, entry] of map) {
      if (entry.timestamp < oldestTs) {
        oldestTs = entry.timestamp;
        oldestNs = ns;
        oldestHash = hash;
      }
    }
  }

  if (oldestNs && oldestHash) {
    const map = _store.get(oldestNs);
    if (map) {
      const entry = map.get(oldestHash);
      if (entry?.ttlTimer) clearTimeout(entry.ttlTimer);
      map.delete(oldestHash);
      _totalEntries--;
      if (map.size === 0) _store.delete(oldestNs);
    }
  }
}

// ── Public API ────────────────────────────────────────────

/**
 * Compute a deterministic SHA-256 content hash.
 * Returns the first 32 hex characters.
 * Accepts strings or Buffers.
 */
function hashContent(content) {
  if (Buffer.isBuffer(content)) {
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 32);
  }
  const str = typeof content === "string" ? content : JSON.stringify(content);
  return crypto.createHash("sha256").update(str, "utf8").digest("hex").slice(0, 32);
}

/**
 * Check whether content has already been sent in the given namespace.
 * Returns boolean. Works both sync and with await.
 */
function hasSent(namespace, hash) {
  const map = _store.get(namespace);
  if (!map) return false;

  const entry = map.get(hash);
  if (!entry) return false;

  // Check TTL expiry
  if (entry.ttlMs && (Date.now() - entry.timestamp) > entry.ttlMs) {
    if (entry.ttlTimer) clearTimeout(entry.ttlTimer);
    map.delete(hash);
    _totalEntries--;
    return false;
  }

  return true;
}

/**
 * Mark content as sent in the given namespace.
 * Optional `ttlMs` for automatic expiry (default: 24 hours).
 * Returns void. Works both sync and with await.
 */
function markSent(namespace, hash, ttlMs) {
  const ttl = ttlMs ?? DEFAULT_TTL_MS;
  const map = _ensureNamespace(namespace);

  // Clean up old entry if re-marking
  const existing = map.get(hash);
  if (existing?.ttlTimer) clearTimeout(existing.ttlTimer);

  const entry = { timestamp: Date.now(), ttlMs: ttl, ttlTimer: null };

  // Set TTL cleanup timer
  if (ttl > 0 && ttl < Infinity) {
    entry.ttlTimer = setTimeout(() => {
      const m = _store.get(namespace);
      if (m) {
        m.delete(hash);
        _totalEntries--;
        if (m.size === 0) _store.delete(namespace);
      }
    }, ttl);
    entry.ttlTimer.unref?.();
  }

  // Only increment if new entry (not overwriting existing)
  if (!map.has(hash)) {
    _totalEntries++;
  }
  map.set(hash, entry);
  _evictIfNeeded();
}

/**
 * Clear all entries in a namespace.
 * Useful for testing or manual reset.
 */
function clearNamespace(namespace) {
  const map = _store.get(namespace);
  if (map) {
    for (const entry of map.values()) {
      if (entry.ttlTimer) clearTimeout(entry.ttlTimer);
    }
    _totalEntries -= map.size;
    _store.delete(namespace);
  }
}

/**
 * Get entry count for monitoring.
 */
function getEntryCount() {
  return _totalEntries;
}

module.exports = {
  hashContent,
  hasSent,
  markSent,
  clearNamespace,
  getEntryCount,
};
