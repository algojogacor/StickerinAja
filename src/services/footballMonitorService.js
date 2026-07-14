// Football Monitor Service — polls ESPN for live/ending matches,
// detects full-time, and sends notifications.

const { getSock } = require('../core/socket');
const { fetchLeagueScoreboard } = require('./espnFootballService');
const {
    upsertMatch, getMonitoredMatches, markFullTimeNotified,
    markPostponedNotified, wasNotificationSent,
} = require('../repositories/footballMatchRepository');
const {
    formatFullTimeNotification, formatPostponedNotification, splitLongMessage,
} = require('../formatters/footballMessageFormatter');
const { MAX_MONITOR_DURATION_MINUTES } = require('../config/espnLeagues');

const POLL_INTERVAL_MS = 60_000;
const LONG_POLL_INTERVAL_MS = 10 * 60_000;

// ── Internal state ───────────────────────────────────────
let logger = null;
let groupJid = '';
let pollTimer = null;
let isRunning = false;
const activePolls = new Map();   // leagueCode → lastPolled timestamp
const lockMap = new Map();        // leagueCode → Promise (prevents double polling)

function setConfig(opts) { logger = opts.logger; groupJid = opts.groupJid; }

function start() {
    if (isRunning) return;
    isRunning = true;
    logger?.info('⚽ Football monitor started');
    scheduleNextPoll();
}

function stop() {
    isRunning = false;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    lockMap.clear();
    logger?.info('⚽ Football monitor stopped');
}

// ── Dynamic polling controller ───────────────────────────

function scheduleNextPoll() {
    if (!isRunning) return;
    if (pollTimer) clearTimeout(pollTimer);

    pollTimer = setTimeout(async () => {
        await pollAllMonitored();
        scheduleNextPoll();
    }, POLL_INTERVAL_MS);
    if (pollTimer.unref) pollTimer.unref();
}

/**
 * Find leagues that need polling:
 * 1. Matches with kickoff + 100min passed, not yet full-time
 * 2. Matches within 4 hours of kickoff
 */
async function getLeaguesNeedingPoll() {
    const all = await getMonitoredMatches();
    if (!all.length) return [];

    const now = Date.now();
    const leagueSet = new Map(); // leagueCode → { count, needsPoll }

    for (const match of all) {
        if (match.statusState !== 'pre' && match.statusState !== 'in') continue;
        if (!match.kickoffAt) continue;

        const kickoffMs = new Date(match.kickoffAt).getTime();
        if (isNaN(kickoffMs)) continue;

        const elapsed = (now - kickoffMs) / 60_000;

        // Match hasn't started yet — skip
        if (elapsed < 0) continue;

        // Match within monitoring window
        if (elapsed >= 100) {
            if (!leagueSet.has(match.leagueCode)) {
                leagueSet.set(match.leagueCode, { needsPoll: 0, longPoll: false });
            }
            const entry = leagueSet.get(match.leagueCode);

            if (elapsed > MAX_MONITOR_DURATION_MINUTES) {
                entry.longPoll = true;
            } else {
                entry.needsPoll++;
            }
        }
    }

    return Array.from(leagueSet.entries()).map(([code, info]) => ({
        leagueCode: code,
        count: info.needsPoll,
        useLongPoll: info.longPoll && info.needsPoll === 0,
    }));
}

/**
 * Poll all monitored leagues that need checking.
 */
async function pollAllMonitored() {
    const leagues = await getLeaguesNeedingPoll();
    if (leagues.length === 0) return;

    logger?.info({ leagues: leagues.map(l => l.leagueCode) }, '⚽ Polling leagues...');

    for (const { leagueCode, useLongPoll } of leagues) {
        // Skip if recently polled (for long-poll mode)
        if (useLongPoll) {
            const lastPoll = activePolls.get(leagueCode);
            if (lastPoll && Date.now() - lastPoll < LONG_POLL_INTERVAL_MS) continue;
        }

        // Request lock — prevent double polling same league
        if (lockMap.has(leagueCode)) continue;
        const lockPromise = pollLeague(leagueCode).finally(() => lockMap.delete(leagueCode));
        lockMap.set(leagueCode, lockPromise);
    }
}

/**
 * Poll one league and process each match.
 */
async function pollLeague(leagueCode) {
    const sock = getSock();
    if (!sock || !groupJid) return;

    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const matches = await fetchLeagueScoreboard(leagueCode, todayStr, logger);
    if (!matches) return;

    activePolls.set(leagueCode, Date.now());

    for (const match of matches) {
        // Skip if already notified
        if (match.isPostponed) {
            const alreadyNotified = await wasNotificationSent(match.eventId, 'postponed');
            if (!alreadyNotified) {
                await markPostponedNotified(match.eventId);
                const msg = formatPostponedNotification(match, match.statusDetail || 'Pertandingan ditunda');
                try { await sock.sendMessage(groupJid, { text: msg }); } catch {}
            }
            continue;
        }

        if (match.isFullTime) {
            const alreadyNotified = await wasNotificationSent(match.eventId, 'fulltime');
            if (!alreadyNotified) {
                // Update match in repo
                await upsertMatch({
                    eventId: match.eventId, leagueCode: match.leagueCode,
                    matchDate: match.matchDate, kickoffAt: match.kickoffAt,
                    homeTeam: match.homeTeam, awayTeam: match.awayTeam,
                    homeScore: match.homeScore, awayScore: match.awayScore,
                    penaltyScore: match.penaltyScore,
                    statusState: 'post', statusDetail: match.statusDetail,
                    venue: match.venue, competitionName: match.competitionName,
                    fullTimeNotified: false, postponedNotified: false,
                });

                const msg = formatFullTimeNotification(match);
                try { await sock.sendMessage(groupJid, { text: msg }); } catch {}
                await markFullTimeNotified(match.eventId);
                logger?.info({ eventId: match.eventId }, '✅ FT notification sent');
            }
            continue;
        }

        // Update match state in repo
        await upsertMatch({
            eventId: match.eventId, leagueCode: match.leagueCode,
            matchDate: match.matchDate, kickoffAt: match.kickoffAt,
            homeTeam: match.homeTeam, awayTeam: match.awayTeam,
            homeScore: match.homeScore, awayScore: match.awayScore,
            penaltyScore: match.penaltyScore,
            statusState: match.statusState, statusDetail: match.statusDetail,
            lastKnownScore: `${match.homeScore}-${match.awayScore}`,
            venue: match.venue, competitionName: match.competitionName,
            fullTimeNotified: false, postponedNotified: false,
        });
    }
}

module.exports = {
    setConfig, start, stop, pollAllMonitored, getLeaguesNeedingPoll,
};
