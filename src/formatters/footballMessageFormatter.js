// Football message formatter — WhatsApp-ready messages for schedules, scores, and FT.

const { ESPN_LEAGUES } = require('../config/espnLeagues');

function formatWIBTime(isoString) {
    if (!isoString) return '??:??';
    try {
        return new Date(isoString).toLocaleString('id-ID', {
            timeZone: 'Asia/Jakarta',
            hour: '2-digit', minute: '2-digit'
        });
    } catch {
        return '??:??';
    }
}

function formatWIBDate(isoString) {
    if (!isoString) return '';
    try {
        return new Date(isoString).toLocaleDateString('id-ID', {
            timeZone: 'Asia/Jakarta',
            weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
        });
    } catch { return ''; }
}

/** Format one match line for schedule display. */
function formatScheduleLine(match) {
    const time = formatWIBTime(match.kickoffAt);
    const home = match.homeTeam || '???';
    const away = match.awayTeam || '???';

    let line = `⏰ ${time}  *${home}* vs *${away}*`;
    if (match.venue) line += `\n   📍 ${match.venue}`;
    return line;
}

/** Format one match line for live/finished scores. */
function formatScoreLine(match) {
    const home = match.homeTeam || '???';
    const away = match.awayTeam || '???';
    const hs = match.homeScore ?? '-';
    const as_ = match.awayScore ?? '-';
    const state = match.statusState;

    if (state === 'post') {
        // Check for penalties
        const pen = match.penaltyScore
            ? `\n   🎯 Penalti: ${match.penaltyScore}`
            : '';
        return `🏁 *${home}* ${hs}–${as_} *${away}*${pen}`;
    }

    if (state === 'in') {
        const detail = match.statusDetail || 'LIVE';
        return `🟢 *${home}* ${hs}–${as_} *${away}*\n   ⏱ ${detail}`;
    }

    return `⚪ *${home}* ${hs}–${as_} *${away}*`;
}

/** Build a full schedule message for one league. */
function formatLeagueSchedule(leagueName, matches) {
    const dateStr = formatWIBDate(matches[0]?.kickoffAt);
    const lines = [
        `🏆 *${leagueName}*`,
        dateStr ? `📅 ${dateStr}` : '',
        '',
    ].filter(Boolean);

    for (const m of matches) {
        lines.push(formatScheduleLine(m));
        lines.push('');
    }

    return lines.join('\n');
}

/** Build a full scores message for one league. */
function formatLeagueScores(leagueName, matches) {
    const lines = [
        `🏆 *${leagueName}*`,
        '',
    ];

    for (const m of matches) {
        lines.push(formatScoreLine(m));
        lines.push('');
    }

    return lines.join('\n');
}

/** Format full-time notification. */
function formatFullTimeNotification(match) {
    const home = match.homeTeam || '???';
    const away = match.awayTeam || '???';
    const hs = match.homeScore ?? '-';
    const as_ = match.awayScore ?? '-';
    const comp = match.competitionName || '';

    const lines = [
        '🏁 *FULL-TIME*',
        '',
    ];

    if (comp) lines.push(`🏆 ${comp}`);

    let scoreLine = `${home} ${hs}–${as_} ${away}`;
    if (match.penaltyScore) {
        scoreLine += `\nPenalti: ${match.penaltyScore}`;
    }
    lines.push(scoreLine);

    if (match.statusDetail) lines.push(`⚽ ${match.statusDetail}`);
    if (match.venue) lines.push(`📍 ${match.venue}`);

    return lines.join('\n');
}

/** Format postponed/cancelled notification. */
function formatPostponedNotification(match, statusText) {
    const home = match.homeTeam || '???';
    const away = match.awayTeam || '???';

    return [
        '⚠️ *STATUS PERTANDINGAN*',
        '',
        `${home} vs ${away}`,
        `${statusText}.`,
        '',
        '_Bot akan memperbarui jadwal jika ESPN menyediakan waktu baru._'
    ].join('\n');
}

/** Break a long message into WhatsApp-safe chunks (max ~4000 chars). */
function splitLongMessage(text, maxLen = 3800) {
    if (text.length <= maxLen) return [text];

    const chunks = [];
    const lines = text.split('\n');
    let current = '';

    for (const line of lines) {
        if (current.length + line.length + 1 > maxLen) {
            chunks.push(current.trim());
            current = line;
        } else {
            current += (current ? '\n' : '') + line;
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
}

/** Build the morning schedule broadcast for all leagues. */
function formatMorningBroadcast(allMatchesByLeague) {
    const dateStr = new Date().toLocaleDateString('id-ID', {
        timeZone: 'Asia/Jakarta',
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });

    const lines = [
        `⚽ *JADWAL SEPAK BOLA HARI INI* ⚽`,
        `📅 ${dateStr}`,
        ''
    ];

    let hasMatches = false;

    for (const [leagueName, matches] of Object.entries(allMatchesByLeague)) {
        if (!matches || matches.length === 0) continue;
        hasMatches = true;
        lines.push(`🏆 *${leagueName}*`);
        lines.push('');
        for (const m of matches) {
            lines.push(formatScheduleLine(m));
        }
        lines.push('');
    }

    if (!hasMatches) {
        lines.push('Tidak ada pertandingan dari liga utama hari ini.');
    }

    lines.push(`_${new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' })} WIB_`);

    return lines.join('\n');
}

/** Build a team search result message. */
function formatTeamSearch(teamQuery, allMatches) {
    if (!allMatches || allMatches.length === 0) {
        return `🔍 *"${teamQuery}"*\n\nTidak ditemukan pertandingan untuk tim tersebut.`;
    }

    const byLeague = {};
    for (const m of allMatches) {
        const league = m.competitionName || m.leagueCode;
        if (!byLeague[league]) byLeague[league] = [];
        byLeague[league].push(m);
    }

    const lines = [`🔍 *Hasil pencarian: "${teamQuery}"*`, ''];

    for (const [league, matches] of Object.entries(byLeague)) {
        lines.push(`🏆 *${league}*`);
        lines.push('');
        for (const m of matches) {
            const time = formatWIBTime(m.kickoffAt);
            if (m.statusState === 'post' || m.statusState === 'in') {
                lines.push(formatScoreLine(m) + `  (${time} WIB)`);
            } else {
                lines.push(formatScheduleLine(m));
            }
        }
        lines.push('');
    }

    return lines.join('\n');
}

module.exports = {
    formatWIBTime,
    formatWIBDate,
    formatScheduleLine,
    formatScoreLine,
    formatLeagueSchedule,
    formatLeagueScores,
    formatFullTimeNotification,
    formatPostponedNotification,
    formatMorningBroadcast,
    formatTeamSearch,
    splitLongMessage,
};
