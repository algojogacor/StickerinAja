// ESPN Football Service — fetches match data from ESPN public API.
// Handles timeout, retry, caching, defensive parsing.

const {
    ESPN_BASE, FETCH_TIMEOUT_MS, MAX_RETRIES, RETRY_BASE_MS,
    CACHE_TTL_LIVE, CACHE_TTL_SCHEDULED,
    MONITOR_START_AFTER_MINUTES, MAX_MONITOR_DURATION_MINUTES,
} = require('../config/espnLeagues');

// ── In-memory cache ──────────────────────────────────────
const cache = new Map(); // key: `${leagueCode}|${date}` → { data, ts, ttl }

function getCacheKey(code, date) { return `${code}|${date}`; }

function getFromCache(code, date) {
    const key = getCacheKey(code, date);
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > entry.ttl) {
        cache.delete(key);
        return null;
    }
    return entry.data;
}

function setToCache(code, date, data, hasLiveMatch = false) {
    const key = getCacheKey(code, date);
    cache.set(key, {
        data,
        ts: Date.now(),
        ttl: hasLiveMatch ? CACHE_TTL_LIVE : CACHE_TTL_SCHEDULED
    });
}

// ── Fetch helpers ─────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        return res;
    } finally {
        clearTimeout(timer);
    }
}

/** Fetch with retry + exponential backoff. */
async function fetchWithRetry(url, logger) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await fetchWithTimeout(url);
            if (res.ok) return res;
            logger?.warn({ status: res.status, attempt }, `ESPN API returned ${res.status}`);
            if (res.status === 404 || res.status === 400) return null; // don't retry
            if (attempt < MAX_RETRIES) await delay(RETRY_BASE_MS * attempt);
        } catch (err) {
            logger?.warn({ err: err.message, attempt }, 'ESPN fetch failed');
            if (attempt < MAX_RETRIES) await delay(RETRY_BASE_MS * attempt);
        }
    }
    return null;
}

// ── Date helpers ──────────────────────────────────────────

function getTodayStr() {
    const d = new Date();
    // Use WIB date
    const wib = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    return `${wib.getFullYear()}${String(wib.getMonth() + 1).padStart(2, '0')}${String(wib.getDate()).padStart(2, '0')}`;
}

function dateStrToReadable(dateStr) {
    if (!dateStr || dateStr.length !== 8) return dateStr;
    return `${dateStr.slice(6, 8)}-${dateStr.slice(4, 6)}-${dateStr.slice(0, 4)}`;
}

function parseDateArg(arg) {
    if (!arg) return getTodayStr();
    // dd-mm-yyyy → yyyymmdd
    const m = arg.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (m) return `${m[3]}${m[2]}${m[1]}`;
    // tomorrow
    if (arg === 'besok' || arg === 'tomorrow') {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        const wib = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
        return `${wib.getFullYear()}${String(wib.getMonth() + 1).padStart(2, '0')}${String(wib.getDate()).padStart(2, '0')}`;
    }
    // yesterday
    if (arg === 'kemarin' || arg === 'yesterday') {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        const wib = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
        return `${wib.getFullYear()}${String(wib.getMonth() + 1).padStart(2, '0')}${String(wib.getDate()).padStart(2, '0')}`;
    }
    return getTodayStr();
}

// ── ESPN API ─────────────────────────────────────────────

/**
 * Fetch scoreboard for one league on one date.
 * Returns parsed match array or null.
 */
async function fetchLeagueScoreboard(leagueCode, dateStr, logger) {
    const url = `${ESPN_BASE}/${leagueCode}/scoreboard?dates=${dateStr}`;

    // Check cache
    const cached = getFromCache(leagueCode, dateStr);
    if (cached) {
        logger?.debug(`ESPN: cache hit for ${leagueCode}/${dateStr}`);
        return cached;
    }

    const res = await fetchWithRetry(url, logger);
    if (!res) return null;

    try {
        const data = await res.json();
        const events = data?.events || [];
        const matches = events.map(e => parseEvent(e, leagueCode)).filter(Boolean);

        // Set cache
        const hasLive = matches.some(m => m.statusState === 'in');
        setToCache(leagueCode, dateStr, matches, hasLive);

        logger?.info({ league: leagueCode, count: matches.length }, `ESPN: ${leagueCode} fetched ${matches.length} matches`);
        return matches;
    } catch (err) {
        logger?.error({ err, league: leagueCode }, 'ESPN: parse error');
        return null;
    }
}

/**
 * Fetch scoreboards for multiple leagues.
 * Returns { leagueCode: [...matches] }.
 * On per-league failure, that league's value is null (not fatal).
 */
async function fetchAllLeagues(leagueCodes, dateStr, logger) {
    const results = {};
    // Fetch sequentially to be gentle on ESPN
    for (const code of leagueCodes) {
        try {
            results[code] = await fetchLeagueScoreboard(code, dateStr, logger);
        } catch (err) {
            logger?.warn({ err, league: code }, `ESPN: failed to fetch ${code}`);
            results[code] = null;
        }
    }
    return results;
}

// ── Event parsing ────────────────────────────────────────

function parseEvent(event, leagueCode) {
    if (!event?.id) return null;

    const competition = event.competitions?.[0];
    const status = competition?.status ?? event.status;
    const statusType = status?.type ?? {};

    const state = statusType.state || 'unknown';
    const completed = statusType.completed === true;
    const statusName = statusType.name || '';
    const statusDetail =
        statusType.shortDetail ??
        statusType.detail ??
        statusType.description ??
        '';

    // Competitors by homeAway
    const competitors = competition?.competitors ?? [];
    const home = competitors.find(c => c.homeAway === 'home');
    const away = competitors.find(c => c.homeAway === 'away');

    const homeName = home?.team?.displayName ?? home?.team?.shortDisplayName ?? 'Home';
    const awayName = away?.team?.displayName ?? away?.team?.shortDisplayName ?? 'Away';
    const homeScore = home?.score ?? '-';
    const awayScore = away?.score ?? '-';

    // Penalty/shooutout
    let penaltyScore = null;
    const homePen = competition?.shootout?.home?.score ?? home?.shootoutScore;
    const awayPen = competition?.shootout?.away?.score ?? away?.shootoutScore;
    if (homePen !== undefined && awayPen !== undefined) {
        penaltyScore = `${homeName} ${homePen}–${awayPen} ${awayName}`;
    }

    // Venue
    const venue = competition?.venue?.fullName ?? '';

    // Kickoff time
    const kickoffAt = statusType?.utcTime ?? event.date ?? null;

    // Monitor start time: kickoff + 100 min in WIB
    let monitorFrom = null;
    if (kickoffAt && state === 'pre') {
        try {
            const kickoff = new Date(kickoffAt).getTime();
            monitorFrom = new Date(kickoff + MONITOR_START_AFTER_MINUTES * 60 * 1000).toISOString();
        } catch {}
    }

    // Competition name
    const competitionName = competition?.name ?? event.name ?? event.shortName ?? '';

    // Derived states
    const isLive = state === 'in' && completed === false;
    const isFullTime = state === 'post' && completed === true;
    const isScheduled = state === 'pre' && completed === false;

    // Cancellation/postponement
    const upperStatus = (statusName + statusDetail).toUpperCase();
    const isPostponed = /POSTPONED|CANCEL|CANCELLED|SUSPENDED|ABANDONED/i.test(upperStatus);

    return {
        eventId: event.id,
        leagueCode,
        matchDate: event.date ? event.date.slice(0, 8) : getTodayStr(),
        kickoffAt,
        homeTeam: homeName,
        awayTeam: awayName,
        homeScore: String(homeScore),
        awayScore: String(awayScore),
        penaltyScore,
        statusState: state,
        statusDetail,
        statusName,
        isLive,
        isFullTime,
        isScheduled,
        isPostponed,
        monitorFrom,
        competitionName,
        venue,
        rawJson: JSON.stringify({ event: { id: event.id }, competition }),
    };
}

// ── Public API ───────────────────────────────────────────

module.exports = {
    fetchLeagueScoreboard,
    fetchAllLeagues,
    getTodayStr,
    dateStrToReadable,
    parseDateArg,
    cache, // expose for cache management
};
