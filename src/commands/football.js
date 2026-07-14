// Football commands — !jadwal and !skor
// Auto-loaded by handler's command scanner.

const { findLeague, getAllLeagues } = require('../config/espnLeagues');
const { fetchLeagueScoreboard, fetchAllLeagues, parseDateArg, getTodayStr } = require('../services/espnFootballService');
const { getMatchesByDate } = require('../repositories/footballMatchRepository');
const {
    formatLeagueSchedule, formatLeagueScores, formatTeamSearch,
    formatMorningBroadcast, splitLongMessage,
} = require('../formatters/footballMessageFormatter');

// ── Helpers ──────────────────────────────────────────────

function getLeagueCodes(leagueName) {
    if (!leagueName) return getAllLeagues().map(l => l.code);
    const league = findLeague(leagueName);
    if (league) return [league.code];

    // Unknown → try all
    return null;
}

function filterByTeam(matches, query) {
    if (!query) return matches;
    const q = query.toLowerCase();
    return matches.filter(m => {
        const home = (m.homeTeam || '').toLowerCase();
        const away = (m.awayTeam || '').toLowerCase();
        return home.includes(q) || away.includes(q);
    });
}

// ── Command implementation ───────────────────────────────

async function jadwalCommand(ctx) {
    const { sock, msg, args, remoteJid, logger, PREFIX } = ctx;
    const input = args.join(' ').trim();

    // Parse what the user wants
    let dateStr = getTodayStr();
    let targetLeague = null;
    let teamQuery = null;
    let isAllLeagues = true;

    if (input) {
        // Try as league name
        const league = findLeague(input);
        if (league) {
            targetLeague = league;
            isAllLeagues = false;
        }
        // Try as date (dd-mm-yyyy or "besok")
        else if (/^\d{2}-\d{2}-\d{4}$/.test(input) || input === 'besok' || input === 'tomorrow' || input === 'kemarin' || input === 'yesterday') {
            dateStr = parseDateArg(input);
        }
        // Otherwise assume team name
        else {
            teamQuery = input;
        }
    }

    const leagueCodes = isAllLeagues
        ? getLeagueCodes(null)
        : [targetLeague.code];

    // Check cache/db first for schedules (sync runs at 00:00 & 10:00)
    let allMatches = [];
    for (const code of leagueCodes) {
        const matches = await getMatchesByDate(dateStr).then(ms => ms.filter(m => m.leagueCode === code));
        if (matches.length > 0) {
            allMatches.push(...matches);
        }
    }

    // If nothing in db, fetch live from ESPN
    if (allMatches.length === 0) {
        await sock.sendMessage(remoteJid, { text: '⏳ Mengambil jadwal dari ESPN...' }, { quoted: msg });

        const results = await fetchAllLeagues(leagueCodes, dateStr, logger);
        for (const [code, matches] of Object.entries(results)) {
            if (matches) allMatches.push(...matches);
        }
    }

    if (allMatches.length === 0) {
        const dateLabel = dateStr === getTodayStr() ? 'hari ini' : `tanggal ${dateStr.slice(6,8)}-${dateStr.slice(4,6)}-${dateStr.slice(0,4)}`;
        return sock.sendMessage(remoteJid, {
            text: `⚽ Tidak ada pertandingan ${targetLeague ? targetLeague.name : ''} untuk ${dateLabel}.`
        }, { quoted: msg });
    }

    // Filter: team search
    if (teamQuery) {
        const teamMatches = filterByTeam(allMatches, teamQuery);
        if (teamMatches.length === 0) {
            return sock.sendMessage(remoteJid, {
                text: `🔍 Tim "${teamQuery}" tidak ditemukan dalam jadwal.`
            }, { quoted: msg });
        }
        // Only show scheduled/pre matches
        const scheduled = teamMatches.filter(m => m.statusState === 'pre');
        const msgText = formatTeamSearch(teamQuery, scheduled.length > 0 ? scheduled : teamMatches);
        const chunks = splitLongMessage(msgText);
        for (const chunk of chunks) {
            await sock.sendMessage(remoteJid, { text: chunk }, { quoted: msg });
        }
        return;
    }

    // Filter: only pre + in (upcoming and live)
    const filtered = allMatches.filter(m => m.statusState === 'pre' || m.statusState === 'in');

    if (filtered.length === 0) {
        return sock.sendMessage(remoteJid, {
            text: `⚽ Tidak ada pertandingan yang akan datang untuk ${targetLeague ? targetLeague.name : 'liga utama'} hari ini.`
        }, { quoted: msg });
    }

    // Group by competition
    const byLeague = {};
    for (const m of filtered) {
        const name = m.competitionName || targetLeague?.name || m.leagueCode;
        if (!byLeague[name]) byLeague[name] = [];
        byLeague[name].push(m);
    }

    const lines = [];
    for (const [name, matches] of Object.entries(byLeague)) {
        lines.push(formatLeagueSchedule(name, matches));
        lines.push('');
    }

    const msgText = lines.join('\n');
    const chunks = splitLongMessage(msgText);
    for (const chunk of chunks) {
        await sock.sendMessage(remoteJid, { text: chunk }, { quoted: msg });
    }
    logger.info({ chat: remoteJid }, `→ jadwal ${input || 'all'}`);
}

async function skorCommand(ctx) {
    const { sock, msg, args, remoteJid, logger } = ctx;
    const input = args.join(' ').trim();
    const todayStr = getTodayStr();

    let leagueCodes = getLeagueCodes(null);
    let specificLeague = null;
    let teamQuery = null;

    if (input) {
        const league = findLeague(input);
        if (league) {
            leagueCodes = [league.code];
            specificLeague = league;
        } else {
            teamQuery = input;
        }
    }

    await sock.sendMessage(remoteJid, { text: '⏳ Mengambil skor...' }, { quoted: msg });

    // Fetch fresh from ESPN (live data shouldn't be stale)
    const results = await fetchAllLeagues(leagueCodes, todayStr, logger);
    let allMatches = [];
    for (const [, matches] of Object.entries(results)) {
        if (matches) allMatches.push(...matches);
    }

    if (allMatches.length === 0) {
        return sock.sendMessage(remoteJid, {
            text: '⚽ Tidak ada pertandingan hari ini.'
        }, { quoted: msg });
    }

    // Team search
    if (teamQuery) {
        const teamMatches = filterByTeam(allMatches, teamQuery);
        if (teamMatches.length === 0) {
            return sock.sendMessage(remoteJid, {
                text: `🔍 Tim "${teamQuery}" tidak ditemukan.`
            }, { quoted: msg });
        }
        const msgText = formatTeamSearch(teamQuery, teamMatches);
        const chunks = splitLongMessage(msgText);
        for (const chunk of chunks) await sock.sendMessage(remoteJid, { text: chunk }, { quoted: msg });
        return;
    }

    // Filter: live or finished today
    const filtered = allMatches.filter(m => m.statusState === 'in' || m.statusState === 'post');

    if (filtered.length === 0) {
        return sock.sendMessage(remoteJid, {
            text: `⚽ Belum ada skor untuk ${specificLeague ? specificLeague.name : 'liga utama'} hari ini. Pertandingan mungkin belum dimulai — coba *!jadwal* untuk lihat jadwal.`
        }, { quoted: msg });
    }

    // Group by competition
    const byLeague = {};
    for (const m of filtered) {
        const name = m.competitionName || specificLeague?.name || m.leagueCode;
        if (!byLeague[name]) byLeague[name] = [];
        byLeague[name].push(m);
    }

    const lines = [];
    for (const [name, matches] of Object.entries(byLeague)) {
        lines.push(formatLeagueScores(name, matches));
        lines.push('');
    }

    const msgText = lines.join('\n');
    const chunks = splitLongMessage(msgText);
    for (const chunk of chunks) await sock.sendMessage(remoteJid, { text: chunk }, { quoted: msg });
    logger.info({ chat: remoteJid }, `→ skor ${input || 'all'}`);
}

// ── Command export ───────────────────────────────────────

module.exports = {
    names: ['jadwal', 'schedule', 'skor', 'score', 'livescore', 'liveskor'],
    async execute(ctx) {
        if (ctx.cmdName === 'jadwal' || ctx.cmdName === 'schedule') {
            return jadwalCommand(ctx);
        }
        if (ctx.cmdName === 'skor' || ctx.cmdName === 'score' || ctx.cmdName === 'livescore' || ctx.cmdName === 'liveskor') {
            return skorCommand(ctx);
        }
    }
};
