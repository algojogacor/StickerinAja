// Football match repository — persistent storage via Turso (libsql).
// Stores match schedules, monitoring state, and notification records.
// Falls back to in-memory if Turso is unavailable.

const { createClient } = require('@libsql/client');

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
            CREATE TABLE IF NOT EXISTS football_matches (
                event_id TEXT NOT NULL,
                league_code TEXT NOT NULL,
                match_date TEXT NOT NULL,
                kickoff_at TEXT,
                home_team TEXT,
                away_team TEXT,
                home_score TEXT DEFAULT '-',
                away_score TEXT DEFAULT '-',
                status_state TEXT DEFAULT 'pre',
                status_detail TEXT,
                monitor_from TEXT,
                last_known_score TEXT,
                full_time_notified INTEGER DEFAULT 0,
                postponed_notified INTEGER DEFAULT 0,
                venue TEXT,
                competition_name TEXT,
                raw_json TEXT,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (event_id, league_code)
            )
        `);

        await client.execute(`
            CREATE TABLE IF NOT EXISTS football_notifications (
                event_id TEXT NOT NULL PRIMARY KEY,
                type TEXT NOT NULL,
                sent_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `);

        ready = true;
        logger?.info('✅ Football repository connected to Turso');
    } catch (err) {
        logger?.warn({ err }, 'Football repository: Turso init failed — using memory fallback');
    }
}

// ── Match CRUD ───────────────────────────────────────────

async function upsertMatch(match) {
    if (!ready || !client) {
        upsertMatchMemory(match);
        return;
    }
    try {
        await client.execute({
            sql: `INSERT INTO football_matches
                  (event_id, league_code, match_date, kickoff_at, home_team, away_team,
                   home_score, away_score, status_state, status_detail,
                   monitor_from, last_known_score, full_time_notified, postponed_notified,
                   venue, competition_name, raw_json, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP)
                  ON CONFLICT(event_id, league_code) DO UPDATE SET
                    home_score = excluded.home_score,
                    away_score = excluded.away_score,
                    status_state = excluded.status_state,
                    status_detail = excluded.status_detail,
                    last_known_score = excluded.last_known_score,
                    full_time_notified = excluded.full_time_notified,
                    postponed_notified = excluded.postponed_notified,
                    venue = COALESCE(excluded.venue, football_matches.venue),
                    raw_json = COALESCE(excluded.raw_json, football_matches.raw_json),
                    updated_at = CURRENT_TIMESTAMP`,
            args: [
                match.eventId, match.leagueCode, match.matchDate,
                match.kickoffAt || null, match.homeTeam || '', match.awayTeam || '',
                match.homeScore || '-', match.awayScore || '-',
                match.statusState || 'pre', match.statusDetail || '',
                match.monitorFrom || null, match.lastKnownScore || null,
                match.fullTimeNotified ? 1 : 0, match.postponedNotified ? 1 : 0,
                match.venue || '', match.competitionName || '', match.rawJson || ''
            ]
        });
    } catch (err) {
        upsertMatchMemory(match);
    }
}

async function getMatchesByDate(dateStr) {
    if (!ready || !client) return getMatchesByDateMemory(dateStr);
    try {
        const result = await client.execute({
            sql: `SELECT * FROM football_matches WHERE match_date = ? ORDER BY kickoff_at`,
            args: [dateStr]
        });
        return result.rows.map(rowToMatch);
    } catch { return getMatchesByDateMemory(dateStr); }
}

async function getMonitoredMatches() {
    if (!ready || !client) return getMonitoredMemory();
    try {
        const result = await client.execute({
            sql: `SELECT * FROM football_matches
                  WHERE full_time_notified = 0 AND postponed_notified = 0
                  AND status_state IN ('pre','in')`,
            args: []
        });
        return result.rows.map(rowToMatch);
    } catch { return getMonitoredMemory(); }
}

async function markFullTimeNotified(eventId) {
    markFullTimeNotifiedMemory(eventId);
    if (!ready || !client) return;
    try {
        await client.execute({
            sql: `UPDATE football_matches SET full_time_notified = 1, updated_at = CURRENT_TIMESTAMP WHERE event_id = ?`,
            args: [eventId]
        });
        await client.execute({
            sql: `INSERT OR REPLACE INTO football_notifications (event_id, type, sent_at) VALUES (?, 'fulltime', CURRENT_TIMESTAMP)`,
            args: [eventId]
        });
    } catch {}
}

async function markPostponedNotified(eventId) {
    markPostponedNotifiedMemory(eventId);
    if (!ready || !client) return;
    try {
        await client.execute({
            sql: `UPDATE football_matches SET postponed_notified = 1, updated_at = CURRENT_TIMESTAMP WHERE event_id = ?`,
            args: [eventId]
        });
        await client.execute({
            sql: `INSERT OR REPLACE INTO football_notifications (event_id, type, sent_at) VALUES (?, 'postponed', CURRENT_TIMESTAMP)`,
            args: [eventId]
        });
    } catch {}
}

async function wasNotificationSent(eventId, type) {
    if (notificationMemory.has(eventId + '|' + type)) return true;
    if (!ready || !client) return false;
    try {
        const result = await client.execute({
            sql: `SELECT 1 FROM football_notifications WHERE event_id = ? AND type = ?`,
            args: [eventId, type]
        });
        return result.rows.length > 0;
    } catch { return false; }
}

async function pruneOldMatches(beforeDate) {
    if (!ready || !client) return;
    try {
        await client.execute({
            sql: `DELETE FROM football_matches WHERE match_date < ?`,
            args: [beforeDate]
        });
    } catch {}
}

// ── Memory fallback ──────────────────────────────────────

const matchMemory = new Map(); // key: eventId|leagueCode
const notificationMemory = new Set();

function rowToMatch(row) {
    return {
        eventId: row.event_id,
        leagueCode: row.league_code,
        matchDate: row.match_date,
        kickoffAt: row.kickoff_at,
        homeTeam: row.home_team,
        awayTeam: row.away_team,
        homeScore: row.home_score,
        awayScore: row.away_score,
        statusState: row.status_state,
        statusDetail: row.status_detail,
        monitorFrom: row.monitor_from,
        lastKnownScore: row.last_known_score,
        fullTimeNotified: !!row.full_time_notified,
        postponedNotified: !!row.postponed_notified,
        venue: row.venue,
        competitionName: row.competition_name,
        rawJson: row.raw_json
    };
}

function upsertMatchMemory(match) {
    matchMemory.set(`${match.eventId}|${match.leagueCode}`, { ...match });
}

function getMatchesByDateMemory(dateStr) {
    const results = [];
    for (const m of matchMemory.values()) {
        if (m.matchDate === dateStr) results.push(m);
    }
    results.sort((a, b) => (a.kickoffAt || '').localeCompare(b.kickoffAt || ''));
    return results;
}

function getMonitoredMemory() {
    const results = [];
    for (const m of matchMemory.values()) {
        if (!m.fullTimeNotified && !m.postponedNotified && (m.statusState === 'pre' || m.statusState === 'in')) {
            results.push(m);
        }
    }
    return results;
}

function markFullTimeNotifiedMemory(eventId) {
    notificationMemory.add(eventId + '|fulltime');
}

function markPostponedNotifiedMemory(eventId) {
    notificationMemory.add(eventId + '|postponed');
}

module.exports = {
    init,
    upsertMatch,
    getMatchesByDate,
    getMonitoredMatches,
    markFullTimeNotified,
    markPostponedNotified,
    wasNotificationSent,
    pruneOldMatches,
};
