// Quiz leaderboard — persisted to Turso (libsql) so scores survive redeploys.
// Lightweight: one table per group, in-memory cache, batch writes.

const { createClient } = require('@libsql/client');

// ── Turso setup ──────────────────────────────────────────

function createTursoClient() {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url) return null;
    return createClient({ url, authToken });
}

const TABLE = 'quiz_scores';
const POINTS_CORRECT = 10;
const CACHE_TTL_MS = 60_000; // cache leaderboard 1 min

// ── In-memory cache ──────────────────────────────────────
// { groupJid: { data: [...], cachedAt: ms } }

const cache = new Map();
let client = null;
let ready = false;

// ── Init ─────────────────────────────────────────────────

async function init(logger) {
    client = createTursoClient();
    if (!client) {
        logger?.warn('Quiz leaderboard: no Turso URL — scores will be memory-only');
        return;
    }

    try {
        await client.execute(`
            CREATE TABLE IF NOT EXISTS ${TABLE} (
                group_jid TEXT NOT NULL,
                user_id TEXT NOT NULL,
                name TEXT NOT NULL DEFAULT '',
                score INTEGER NOT NULL DEFAULT 0,
                streak INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (group_jid, user_id)
            )
        `);
        ready = true;
        logger?.info('✅ Quiz leaderboard connected to Turso');
    } catch (err) {
        logger?.warn({ err }, 'Quiz leaderboard: Turso init failed — scores will be memory-only');
    }
}

// ── Public API ───────────────────────────────────────────

/**
 * Record a quiz answer.
 */
async function recordAnswer(groupJid, userId, name, isCorrect) {
    if (!ready || !client) {
        return recordMemory(groupJid, userId, name, isCorrect);
    }

    try {
        // Upsert: insert or increment
        await client.execute({
            sql: `
                INSERT INTO ${TABLE} (group_jid, user_id, name, score, streak, updated_at)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(group_jid, user_id)
                DO UPDATE SET
                    name = COALESCE(NULLIF(excluded.name, ''), ${TABLE}.name),
                    score = ${TABLE}.score + ?,
                    streak = CASE WHEN ? THEN ${TABLE}.streak + 1 ELSE 0 END,
                    updated_at = CURRENT_TIMESTAMP
            `,
            args: [groupJid, userId, name || '', 1, isCorrect ? POINTS_CORRECT : 0, isCorrect]
        });

        // Fetch updated stats
        const result = await client.execute({
            sql: `SELECT score, streak FROM ${TABLE} WHERE group_jid = ? AND user_id = ? LIMIT 1`,
            args: [groupJid, userId]
        });

        const row = result.rows[0];
        const score = row?.score || 0;
        const streak = row?.streak || 0;

        // Invalidate cache for this group
        cache.delete(groupJid);

        return { score, streak };
    } catch (err) {
        // Fall back to memory on DB error
        return recordMemory(groupJid, userId, name, isCorrect);
    }
}

/**
 * Get leaderboard for a group.
 * Caches for 1 minute to reduce DB calls.
 */
async function getLeaderboard(groupJid, limit = 10) {
    // Check cache
    const cached = cache.get(groupJid);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
        return cached.data.slice(0, limit);
    }

    if (!ready || !client) {
        return getLeaderboardMemory(groupJid, limit);
    }

    try {
        const result = await client.execute({
            sql: `SELECT user_id, name, score, streak FROM ${TABLE}
                  WHERE group_jid = ? AND score > 0
                  ORDER BY score DESC LIMIT ?`,
            args: [groupJid, String(limit)]
        });

        const board = result.rows.map((row, i) => ({
            rank: i + 1,
            name: row.name || row.user_id?.slice(0, 12) || '???',
            score: row.score,
            streak: row.streak || 0
        }));

        cache.set(groupJid, { data: board, cachedAt: Date.now() });
        return board;
    } catch (err) {
        return getLeaderboardMemory(groupJid, limit);
    }
}

/**
 * Reset scores for a group.
 */
async function resetScores(groupJid) {
    if (ready && client) {
        try {
            await client.execute({
                sql: `DELETE FROM ${TABLE} WHERE group_jid = ?`,
                args: [groupJid]
            });
        } catch {}
    }
    // Also clear memory
    memoryStore.delete(groupJid);
    cache.delete(groupJid);
}

/**
 * Get one user's stats.
 */
async function getUserScore(groupJid, userId) {
    if (!ready || !client) {
        const group = memoryStore.get(groupJid);
        return group?.get(userId) || null;
    }

    try {
        const result = await client.execute({
            sql: `SELECT name, score, streak FROM ${TABLE} WHERE group_jid = ? AND user_id = ? LIMIT 1`,
            args: [groupJid, userId]
        });
        return result.rows[0] || null;
    } catch {
        return null;
    }
}

// ── Memory fallback ──────────────────────────────────────

const memoryStore = new Map();

function recordMemory(groupJid, userId, name, isCorrect) {
    if (!memoryStore.has(groupJid)) memoryStore.set(groupJid, new Map());
    const group = memoryStore.get(groupJid);

    if (!group.has(userId)) {
        group.set(userId, { name, score: 0, streak: 0 });
    }
    const user = group.get(userId);
    user.name = name || user.name;

    if (isCorrect) {
        user.score += POINTS_CORRECT;
        user.streak += 1;
    } else {
        user.streak = 0;
    }

    return { score: user.score, streak: user.streak };
}

function getLeaderboardMemory(groupJid, limit = 10) {
    const group = memoryStore.get(groupJid);
    if (!group) return [];

    return Array.from(group.entries())
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, limit)
        .map(([id, data], i) => ({
            rank: i + 1,
            name: data.name || id.slice(0, 12),
            score: data.score,
            streak: data.streak || 0
        }));
}

module.exports = {
    init,
    recordAnswer,
    getLeaderboard,
    resetScores,
    getUserScore
};
