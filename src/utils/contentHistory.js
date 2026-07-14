// Content history tracker — prevents duplicate jokes, facts, and news.
// Uses in-memory LRU-style Set with optional JSON file persistence.
// Keys are content hashes (first 64 chars of normalized text).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HISTORY_DIR = path.join(__dirname, '../../data');
const HISTORY_FILE = path.join(HISTORY_DIR, 'content_history.json');
const MAX_HISTORY = 2000; // keep last N unique items
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // prune every hour

let history = new Set();
let dirty = false;

// ── Persistence ──────────────────────────────────────────

function ensureDir() {
    if (!fs.existsSync(HISTORY_DIR)) {
        fs.mkdirSync(HISTORY_DIR, { recursive: true });
    }
}

function loadHistory() {
    ensureDir();
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) {
                history = new Set(arr.slice(-MAX_HISTORY));
                return;
            }
        }
    } catch (err) {
        // corrupted file — start fresh
    }
    history = new Set();
}

function saveHistory() {
    if (!dirty) return;
    ensureDir();
    try {
        const arr = Array.from(history).slice(-MAX_HISTORY);
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(arr), 'utf8');
        dirty = false;
    } catch {
        // silently ignore write errors (disk full, permissions etc.)
    }
}

// ── Content hashing ──────────────────────────────────────

/**
 * Generate a short hash from content text.
 * Normalizes whitespace + lowercases before hashing so minor formatting
 * differences don't bypass the dedup.
 */
function hashContent(text) {
    if (!text || typeof text !== 'string') return null;
    const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
    return crypto.createHash('md5').update(normalized).digest('hex');
}

// ── Public API ───────────────────────────────────────────

/**
 * Check whether content (or its hash) has been sent before.
 * @param {string} textOrHash - Content text or precomputed hash
 * @returns {boolean}
 */
function hasSent(textOrHash) {
    if (!textOrHash) return false;
    // accept both raw text and pre-computed hash
    const id = textOrHash.length === 32 ? textOrHash : hashContent(textOrHash);
    if (!id) return false;
    return history.has(id);
}

/**
 * Mark content as sent. Accepts text or hash.
 * @param {string} textOrHash
 */
function markSent(textOrHash) {
    if (!textOrHash) return;
    const id = textOrHash.length === 32 ? textOrHash : hashContent(textOrHash);
    if (!id) return;
    if (history.has(id)) return;

    history.add(id);
    dirty = true;

    // Trim oldest entries if over limit
    if (history.size > MAX_HISTORY) {
        const toDelete = history.size - MAX_HISTORY;
        let deleted = 0;
        for (const entry of history) {
            if (deleted >= toDelete) break;
            history.delete(entry);
            deleted++;
        }
    }
}

/**
 * Get current history size.
 * @returns {number}
 */
function getHistorySize() {
    return history.size;
}

/**
 * Clear all history (useful for testing/reset).
 */
function clearHistory() {
    history.clear();
    dirty = true;
    saveHistory();
}

// ── Lifecycle ────────────────────────────────────────────

loadHistory();

// Auto-save periodically
const saveTimer = setInterval(saveHistory, PRUNE_INTERVAL_MS);
if (saveTimer.unref) saveTimer.unref(); // don't keep process alive

// Save on clean exit
process.on('exit', saveHistory);
process.on('SIGINT', () => { saveHistory(); process.exit(); });
process.on('SIGTERM', () => { saveHistory(); process.exit(); });

module.exports = {
    hasSent,
    markSent,
    hashContent,
    getHistorySize,
    clearHistory,
    saveHistory
};
