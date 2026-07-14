// Football Scheduler — sync + broadcast + monitor lifecycle.
// 00:00 WIB — fetch & store all matches for today
// 07:00 WIB — send morning broadcast to group
// 10:00 WIB — refresh schedules (postponements, venue changes)
// Dynamic polling for full-time detection via footballMonitorService

const cron = require('node-cron');
const { getSock } = require('../core/socket');
const { fetchAllLeagues, getTodayStr } = require('../services/espnFootballService');
const { getAllLeagues } = require('../config/espnLeagues');
const { upsertMatch, getMatchesByDate, pruneOldMatches } = require('../repositories/footballMatchRepository');
const { formatMorningBroadcast, splitLongMessage } = require('../formatters/footballMessageFormatter');
const { setConfig, start: startMonitor, stop: stopMonitor } = require('../services/footballMonitorService');

// ── Helpers ──────────────────────────────────────────────

function wibNow() {
    return new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
}

// ── Scheduler Class ──────────────────────────────────────

class FootballScheduler {
    constructor(opts = {}) {
        this.logger = opts.logger;
        this.groupJid = opts.groupJid;
        this.cronJobs = [];
        this.running = false;
    }

    start() {
        if (this.running) {
            this.logger?.warn('Football scheduler already running');
            return;
        }
        this.running = true;

        // Configure monitor service
        setConfig({ logger: this.logger, groupJid: this.groupJid });

        // ── 00:00 WIB — Sync all matches for today ──
        const midnightJob = cron.schedule('0 0 * * *', () => this.syncTodayMatches(), {
            timezone: 'Asia/Jakarta', name: 'football-sync-midnight'
        });
        this.cronJobs.push(midnightJob);
        this.logger?.info('⚽ Football sync scheduled: 00:00 WIB');

        // ── 07:00 WIB — Morning broadcast ──
        const morningJob = cron.schedule('0 7 * * *', () => this.sendMorningBroadcast(), {
            timezone: 'Asia/Jakarta', name: 'football-broadcast'
        });
        this.cronJobs.push(morningJob);
        this.logger?.info('📢 Football broadcast scheduled: 07:00 WIB');

        // ── 10:00 WIB — Refresh schedule ──
        const refreshJob = cron.schedule('0 10 * * *', () => this.refreshSchedules(), {
            timezone: 'Asia/Jakarta', name: 'football-sync-morning'
        });
        this.cronJobs.push(refreshJob);
        this.logger?.info('🔄 Football refresh scheduled: 10:00 WIB');

        // ── Start dynamic monitor ──
        startMonitor();

        // ── Run initial sync at startup (after 30s for stability) ──
        setTimeout(() => {
            if (this.running) this.syncTodayMatches();
        }, 30_000);

        this.logger?.info({ group: this.groupJid }, '✅ Football scheduler started');
    }

    stop() {
        this.running = false;
        for (const job of this.cronJobs) job.stop();
        this.cronJobs = [];
        stopMonitor();
        this.logger?.info('🛑 Football scheduler stopped');
    }

    // ── Sync: fetch all matches, store in repository ──

    async syncTodayMatches() {
        const sock = getSock();
        if (!this.groupJid) return;

        const todayStr = getTodayStr();
        this.logger?.info(`⚽ Syncing matches for ${todayStr}...`);

        const leagueCodes = getAllLeagues().map(l => l.code);
        const results = await fetchAllLeagues(leagueCodes, todayStr, this.logger);

        let total = 0;
        for (const [code, matches] of Object.entries(results)) {
            if (!matches) continue;
            for (const m of matches) {
                await upsertMatch({
                    eventId: m.eventId, leagueCode: m.leagueCode,
                    matchDate: m.matchDate, kickoffAt: m.kickoffAt,
                    homeTeam: m.homeTeam, awayTeam: m.awayTeam,
                    homeScore: m.homeScore, awayScore: m.awayScore,
                    penaltyScore: m.penaltyScore,
                    statusState: m.statusState, statusDetail: m.statusDetail,
                    monitorFrom: m.monitorFrom,
                    lastKnownScore: `${m.homeScore}-${m.awayScore}`,
                    venue: m.venue, competitionName: m.competitionName,
                    rawJson: m.rawJson,
                    fullTimeNotified: false, postponedNotified: false,
                });
                total++;
            }
        }

        // Prune matches older than 3 days
        const pruneDate = new Date();
        pruneDate.setDate(pruneDate.getDate() - 3);
        const pruneStr = pruneDate.toISOString().slice(0, 10).replace(/-/g, '');
        await pruneOldMatches(pruneStr);

        this.logger?.info(`⚽ Sync done: ${total} matches stored for today`);
    }

    // ── Morning broadcast ─────────────────────────────────

    async sendMorningBroadcast() {
        const sock = getSock();
        if (!sock) {
            this.logger?.warn('Football broadcast skipped: socket not connected');
            return;
        }
        if (!this.groupJid) return;

        this.logger?.info('📢 Preparing football morning broadcast...');

        try {
            const todayStr = getTodayStr();
            const matches = await getMatchesByDate(todayStr);

            if (matches.length === 0) {
                // Try fetching fresh
                await this.syncTodayMatches();
                const fresh = await getMatchesByDate(todayStr);
                if (fresh.length === 0) {
                    await sock.sendMessage(this.groupJid, {
                        text: '⚽ Tidak ada pertandingan sepak bola hari ini dari liga utama.'
                    });
                    return;
                }
                matches.push(...fresh);
            }

            // Group by competition name
            const byLeague = {};
            for (const m of matches) {
                const name = m.competitionName || m.leagueCode;
                if (!byLeague[name]) byLeague[name] = [];
                byLeague[name].push(m);
            }

            const msgText = formatMorningBroadcast(byLeague);
            const chunks = splitLongMessage(msgText);
            for (const chunk of chunks) {
                await sock.sendMessage(this.groupJid, { text: chunk });
            }

            this.logger?.info('✅ Football morning broadcast sent');
        } catch (err) {
            this.logger?.error({ err }, 'Football broadcast failed');
        }
    }

    // ── Refresh schedules at 10:00 ────────────────────────

    async refreshSchedules() {
        this.logger?.info('🔄 Refreshing football schedules...');
        await this.syncTodayMatches();

        // Log any postponed/re-scheduled matches
        const todayStr = getTodayStr();
        const matches = await getMatchesByDate(todayStr);
        const postponed = matches.filter(m => m.statusState === 'post' && m.postponedNotified);
        const rescheduled = matches.filter(m => m.statusState === 'pre' && m.kickoffAt);

        if (postponed.length > 0) this.logger?.info({ count: postponed.length }, 'Postponed matches found');
        if (rescheduled.length > 0) this.logger?.info({ count: rescheduled.length }, 'Active matches for today');

        this.logger?.info('✅ Football schedules refreshed');
    }
}

module.exports = { FootballScheduler };
