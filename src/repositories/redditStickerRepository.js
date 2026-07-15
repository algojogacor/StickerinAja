// Reddit Sticker Bank repository — persistent storage via Turso (libsql).
// Stores generated sticker metadata, status tracking, and dedup records.
// Falls back to in-memory if Turso is unavailable.

const { createClient } = require("@libsql/client");
const crypto = require("crypto");

// ── Turso setup ──────────────────────────────────────────

function createTursoClient() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) return null;
  return createClient({ url, authToken });
}

let client = null;
let ready = false;

async function init(logger) {
  client = createTursoClient();
  if (!client) return;

  try {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS reddit_stickers (
        id TEXT NOT NULL PRIMARY KEY,
        reddit_post_id TEXT NOT NULL,
        original_post_id TEXT,
        subreddit TEXT,
        author TEXT,
        title TEXT,
        permalink TEXT,
        source_url TEXT,
        media_url TEXT,
        media_type TEXT,
        sticker_type TEXT,
        local_path TEXT,
        file_size_bytes INTEGER,
        duration_seconds REAL,
        score INTEGER DEFAULT 0,
        upvote_ratio REAL,
        created_utc INTEGER,
        fetched_at TEXT,
        generated_at TEXT,
        sent_count INTEGER DEFAULT 0,
        last_sent_at TEXT,
        status TEXT DEFAULT 'discovered',
        failure_reason TEXT,
        content_hash TEXT
      )
    `);

    // Indexes for common queries
    await client.execute(
      `CREATE INDEX IF NOT EXISTS idx_rs_status ON reddit_stickers(status)`
    );
    await client.execute(
      `CREATE INDEX IF NOT EXISTS idx_rs_post_id ON reddit_stickers(reddit_post_id)`
    );
    await client.execute(
      `CREATE INDEX IF NOT EXISTS idx_rs_hash ON reddit_stickers(content_hash)`
    );

    ready = true;
    logger?.info("✅ Reddit Sticker Bank connected to Turso");
  } catch (err) {
    logger?.warn(
      { err },
      "Reddit Sticker Bank: Turso init failed — using memory fallback"
    );
  }
}

// ── Memory fallback ──────────────────────────────────────

const stickerMemory = new Map();
const hashIndex = new Map(); // contentHash → id
const postIdIndex = new Map(); // redditPostId → id

function rowToSticker(row) {
  return {
    id: row.id,
    redditPostId: row.reddit_post_id,
    originalPostId: row.original_post_id,
    subreddit: row.subreddit,
    author: row.author,
    title: row.title,
    permalink: row.permalink,
    sourceUrl: row.source_url,
    mediaUrl: row.media_url,
    mediaType: row.media_type,
    stickerType: row.sticker_type,
    localPath: row.local_path,
    fileSizeBytes: row.file_size_bytes,
    durationSeconds: row.duration_seconds,
    score: row.score,
    upvoteRatio: row.upvote_ratio,
    createdUtc: row.created_utc,
    fetchedAt: row.fetched_at,
    generatedAt: row.generated_at,
    sentCount: row.sent_count,
    lastSentAt: row.last_sent_at,
    status: row.status,
    failureReason: row.failure_reason,
    contentHash: row.content_hash,
  };
}

// ── CRUD ─────────────────────────────────────────────────

async function insertSticker(sticker) {
  if (!ready || !client) {
    insertStickerMemory(sticker);
    return;
  }
  try {
    await client.execute({
      sql: `INSERT INTO reddit_stickers
            (id, reddit_post_id, original_post_id, subreddit, author, title,
             permalink, source_url, media_url, media_type, sticker_type,
             local_path, file_size_bytes, duration_seconds,
             score, upvote_ratio, created_utc,
             fetched_at, generated_at, sent_count, last_sent_at,
            status, failure_reason, content_hash)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
              reddit_post_id = excluded.reddit_post_id,
              original_post_id = excluded.original_post_id,
              subreddit = excluded.subreddit,
              author = excluded.author,
              title = excluded.title,
              permalink = excluded.permalink,
              source_url = excluded.source_url,
              media_url = excluded.media_url,
              media_type = excluded.media_type,
              sticker_type = excluded.sticker_type,
              local_path = excluded.local_path,
              file_size_bytes = excluded.file_size_bytes,
              duration_seconds = excluded.duration_seconds,
              score = excluded.score,
              upvote_ratio = excluded.upvote_ratio,
              created_utc = excluded.created_utc,
              fetched_at = excluded.fetched_at,
              generated_at = excluded.generated_at,
              sent_count = excluded.sent_count,
              last_sent_at = excluded.last_sent_at,
              status = excluded.status,
              failure_reason = excluded.failure_reason,
              content_hash = excluded.content_hash`,
      args: [
        sticker.id,
        sticker.redditPostId,
        sticker.originalPostId || sticker.redditPostId,
        sticker.subreddit || "",
        sticker.author || "",
        sticker.title || "",
        sticker.permalink || "",
        sticker.sourceUrl || "",
        sticker.mediaUrl || "",
        sticker.mediaType || "",
        sticker.stickerType || "",
        sticker.localPath || "",
        sticker.fileSizeBytes || 0,
        sticker.durationSeconds || null,
        sticker.score || 0,
        sticker.upvoteRatio || null,
        sticker.createdUtc || 0,
        sticker.fetchedAt || "",
        sticker.generatedAt || "",
        sticker.sentCount || 0,
        sticker.lastSentAt || null,
        sticker.status || "discovered",
        sticker.failureReason || null,
        sticker.contentHash || "",
      ],
    });
  } catch (err) {
    insertStickerMemory(sticker);
  }
}

async function updateStickerStatus(id, status, failureReason = null) {
  if (!ready || !client) {
    updateStickerStatusMemory(id, status, failureReason);
    return;
  }
  try {
    await client.execute({
      sql: `UPDATE reddit_stickers SET status = ?, failure_reason = ?, generated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [status, failureReason, id],
    });
  } catch {
    updateStickerStatusMemory(id, status, failureReason);
  }
}

async function markStickerSent(id) {
  if (!ready || !client) {
    markStickerSentMemory(id);
    return;
  }
  try {
    await client.execute({
      sql: `UPDATE reddit_stickers SET sent_count = sent_count + 1, last_sent_at = CURRENT_TIMESTAMP, status = 'sent' WHERE id = ?`,
      args: [id],
    });
  } catch {
    markStickerSentMemory(id);
  }
}

async function getReadyStickers(limit = 10) {
  if (!ready || !client) return getReadyStickersMemory(limit);
  try {
    const result = await client.execute({
      sql: `SELECT * FROM reddit_stickers WHERE status = 'ready' ORDER BY last_sent_at ASC NULLS FIRST, generated_at DESC LIMIT ?`,
      args: [limit],
    });
    return result.rows.map(rowToSticker);
  } catch {
    return getReadyStickersMemory(limit);
  }
}

async function getLeastRecentlySent(limit = 1) {
  if (!ready || !client) return getLeastRecentlySentMemory(limit);
  try {
    const result = await client.execute({
      sql: `SELECT * FROM reddit_stickers WHERE status IN ('ready','sent') ORDER BY last_sent_at ASC NULLS FIRST LIMIT ?`,
      args: [limit],
    });
    return result.rows.map(rowToSticker);
  } catch {
    return getLeastRecentlySentMemory(limit);
  }
}

async function getStickerById(id) {
  if (!ready || !client) return stickerMemory.get(id) || null;
  try {
    const result = await client.execute({
      sql: `SELECT * FROM reddit_stickers WHERE id = ?`,
      args: [id],
    });
    return result.rows.length > 0 ? rowToSticker(result.rows[0]) : null;
  } catch {
    return stickerMemory.get(id) || null;
  }
}

async function getStats() {
  if (!ready || !client) return getStatsMemory();
  try {
    const result = await client.execute({
      sql: `SELECT status, COUNT(*) as count FROM reddit_stickers GROUP BY status`,
      args: [],
    });
    const stats = {
      ready: 0,
      sent: 0,
      failed: 0,
      discovered: 0,
      converting: 0,
      downloading: 0,
      rejected: 0,
      total: 0,
    };
    for (const row of result.rows) {
      stats[row.status] = row.count;
      stats.total += row.count;
    }
    // Sent today
    const todayResult = await client.execute({
      sql: `SELECT COUNT(*) as count FROM reddit_stickers WHERE last_sent_at >= DATE('now')`,
      args: [],
    });
    stats.sentToday = todayResult.rows[0]?.count || 0;
    return stats;
  } catch {
    return getStatsMemory();
  }
}

// ── Dedup ────────────────────────────────────────────────

async function isDuplicate({ redditPostId, originalPostId, contentHash }) {
  if (!ready || !client) {
    return isDuplicateMemory({ redditPostId, originalPostId, contentHash });
  }
  try {
    // Check by post ID
    if (redditPostId) {
      const byPost = await client.execute({
        sql: `SELECT 1 FROM reddit_stickers
              WHERE status IN ('ready', 'sent')
                AND (reddit_post_id = ? OR original_post_id = ?)
              LIMIT 1`,
        args: [redditPostId, originalPostId || redditPostId],
      });
      if (byPost.rows.length > 0) return true;
    }
    // Check by content hash
    if (contentHash) {
      const byHash = await client.execute({
        sql: `SELECT 1 FROM reddit_stickers
              WHERE status IN ('ready', 'sent') AND content_hash = ?
              LIMIT 1`,
        args: [contentHash],
      });
      if (byHash.rows.length > 0) return true;
    }
    return false;
  } catch {
    return isDuplicateMemory({ redditPostId, originalPostId, contentHash });
  }
}

// ── Memory fallback implementations ──────────────────────

function insertStickerMemory(sticker) {
  stickerMemory.set(sticker.id, { ...sticker });
  if (sticker.contentHash) {
    hashIndex.set(sticker.contentHash, sticker.id);
  }
  if (sticker.redditPostId) {
    postIdIndex.set(sticker.redditPostId, sticker.id);
  }
}

function updateStickerStatusMemory(id, status, failureReason) {
  const s = stickerMemory.get(id);
  if (s) {
    s.status = status;
    s.failureReason = failureReason || null;
    s.generatedAt = new Date().toISOString();
  }
}

function markStickerSentMemory(id) {
  const s = stickerMemory.get(id);
  if (s) {
    s.sentCount = (s.sentCount || 0) + 1;
    s.lastSentAt = new Date().toISOString();
    s.status = "sent";
  }
}

function getReadyStickersMemory(limit) {
  return Array.from(stickerMemory.values())
    .filter((s) => s.status === "ready")
    .sort(
      (a, b) =>
        (a.lastSentAt || "").localeCompare(b.lastSentAt || "") ||
        (b.generatedAt || "").localeCompare(a.generatedAt || "")
    )
    .slice(0, limit);
}

function getLeastRecentlySentMemory(limit) {
  return Array.from(stickerMemory.values())
    .filter((s) => s.status === "ready" || s.status === "sent")
    .sort((a, b) =>
      (a.lastSentAt || "").localeCompare(b.lastSentAt || "")
    )
    .slice(0, limit);
}

function getStatsMemory() {
  const stats = {
    ready: 0,
    sent: 0,
    failed: 0,
    discovered: 0,
    converting: 0,
    downloading: 0,
    rejected: 0,
    total: 0,
    sentToday: 0,
  };
  const today = new Date().toISOString().slice(0, 10);
  for (const s of stickerMemory.values()) {
    stats[s.status] = (stats[s.status] || 0) + 1;
    stats.total++;
    if (s.lastSentAt && s.lastSentAt.startsWith(today)) {
      stats.sentToday++;
    }
  }
  return stats;
}

function isDuplicateMemory({ redditPostId, originalPostId, contentHash }) {
  const isFinal = (id) => {
    const sticker = stickerMemory.get(id);
    return sticker?.status === "ready" || sticker?.status === "sent";
  };

  if (redditPostId && postIdIndex.has(redditPostId) && isFinal(postIdIndex.get(redditPostId))) {
    return true;
  }
  if (originalPostId && postIdIndex.has(originalPostId) && isFinal(postIdIndex.get(originalPostId))) {
    return true;
  }
  if (contentHash && hashIndex.has(contentHash) && isFinal(hashIndex.get(contentHash))) {
    return true;
  }
  return false;
}

function computeHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 32);
}

module.exports = {
  init,
  insertSticker,
  updateStickerStatus,
  markStickerSent,
  getReadyStickers,
  getLeastRecentlySent,
  getStickerById,
  getStats,
  isDuplicate,
  computeHash,
};
