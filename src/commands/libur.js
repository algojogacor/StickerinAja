/**
 * COMMAND: !libur & !libur <bulan>
 * Informasi Hari Libur Nasional & Cuti Bersama Indonesia.
 * 
 * Endpoint Status saat Development (2026-08-31):
 * - Primary (Kemendesa): AKTIF (HTTP 200) -> https://api.kemendesa.link/libur-nasional/api/holidays/{tahun}.json
 * - Fallback (Vercel): AKTIF (HTTP 200) -> https://api-hari-libur.vercel.app/api?year={tahun}&month={bulan}
 */

const MONTH_NAMES = [
    '', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
];

const DAY_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

// Active provider tracking across session
let activeProvider = 'primary';

// Simple in-memory cache per year
const holidayCache = new Map();

function parseMonth(arg) {
    if (!arg) return null;
    const str = String(arg).toLowerCase().trim();

    const num = parseInt(str, 10);
    if (!isNaN(num) && num >= 1 && num <= 12) return num;

    const map = {
        'jan': 1, 'januari': 1, 'january': 1,
        'feb': 2, 'februari': 2, 'february': 2,
        'mar': 3, 'maret': 3, 'march': 3,
        'apr': 4, 'april': 4,
        'mei': 5, 'may': 5,
        'jun': 6, 'juni': 6, 'june': 6,
        'jul': 7, 'juli': 7, 'july': 7,
        'agu': 8, 'agust': 8, 'agustus': 8, 'aug': 8, 'august': 8,
        'sep': 9, 'sept': 9, 'september': 9,
        'okt': 10, 'oktober': 10, 'oct': 10, 'october': 10,
        'nov': 11, 'november': 11,
        'des': 12, 'desember': 12, 'dec': 12, 'december': 12
    };

    return map[str] || null;
}

function formatDateIndo(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dateObj = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const dayName = DAY_NAMES[dateObj.getUTCDay()];
    const monthName = MONTH_NAMES[m];
    return `${d} ${monthName} ${y}, ${dayName}`;
}

async function fetchFromPrimary(year) {
    const url = `https://api.kemendesa.link/libur-nasional/api/holidays/${year}.json`;
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error(`Primary API status ${res.status}`);
    const json = await res.json();
    const list = Array.isArray(json) ? json : (json.data || []);
    return list.map(item => ({
        date: item.date,
        name: item.name,
        isCutiBersama: Boolean(item.is_cuti_bersama)
    }));
}

async function fetchFromFallback(year, month = null) {
    const url = month
        ? `https://api-hari-libur.vercel.app/api?year=${year}&month=${month}`
        : `https://api-hari-libur.vercel.app/api?year=${year}`;
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error(`Fallback API status ${res.status}`);
    const json = await res.json();
    const list = Array.isArray(json) ? json : (json.data || []);
    return list.map(item => ({
        date: item.date,
        name: item.description || item.name || 'Hari Libur',
        isCutiBersama: (item.is_national_holiday === false)
    }));
}

async function getHolidays(year, month, logger = null) {
    const cacheKey = `${year}`;
    if (holidayCache.has(cacheKey)) {
        return holidayCache.get(cacheKey);
    }

    if (activeProvider === 'primary') {
        try {
            const data = await fetchFromPrimary(year);
            holidayCache.set(cacheKey, data);
            return data;
        } catch (err) {
            logger?.warn?.({ err }, '[Libur] Primary API failed, switching to Fallback');
            activeProvider = 'fallback';
            const data = await fetchFromFallback(year, month);
            return data;
        }
    } else {
        try {
            const data = await fetchFromFallback(year, month);
            return data;
        } catch (err) {
            logger?.warn?.({ err }, '[Libur] Fallback API failed, switching to Primary');
            activeProvider = 'primary';
            const data = await fetchFromPrimary(year);
            holidayCache.set(cacheKey, data);
            return data;
        }
    }
}

function formatHolidays(holidays, month, year) {
    const monthName = MONTH_NAMES[month];
    const monthStr = String(month).padStart(2, '0');

    let output = `📅 *Hari Libur — ${monthName} ${year}*\n\n`;

    const inMonth = holidays.filter(h => h.date && h.date.startsWith(`${year}-${monthStr}`));

    if (inMonth.length === 0) {
        output += `Tidak ada hari libur di bulan ini.`;
    } else {
        const lines = inMonth.map(h => {
            const dateFmt = formatDateIndo(h.date);
            const tag = h.isCutiBersama ? '🟡' : '🔴';
            return `${dateFmt} — ${h.name} ${tag}`;
        });
        output += lines.join('\n');
    }

    return output.trim();
}

function normalizeParams(sockOrOpts, msg, args, ctx) {
    if (sockOrOpts && sockOrOpts.sock) {
        return {
            sock: sockOrOpts.sock,
            msg: sockOrOpts.msg,
            args: sockOrOpts.args || [],
            cmdName: sockOrOpts.cmdName,
            remoteJid: sockOrOpts.remoteJid || sockOrOpts.msg?.key?.remoteJid,
            logger: sockOrOpts.logger
        };
    }
    return {
        sock: sockOrOpts,
        msg,
        args: args || [],
        cmdName: args?._command || 'libur',
        remoteJid: msg?.key?.remoteJid,
        logger: ctx?.logger
    };
}

module.exports = {
    names: ['libur', 'harilibur', 'kalender', 'holiday'],
    parseMonth,
    formatDateIndo,
    formatHolidays,
    getHolidays,
    fetchFromPrimary,
    fetchFromFallback,
    execute: async (sockOrOpts, rawMsg, rawArgs, ctx) => {
        const { sock, msg, args, remoteJid, logger } = normalizeParams(sockOrOpts, rawMsg, rawArgs, ctx);

        // Determine target month and year (WIB time)
        const nowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
        let targetYear = nowWib.getUTCFullYear();
        let targetMonth = nowWib.getUTCMonth() + 1;

        if (args.length > 0) {
            const parsed = parseMonth(args[0]);
            if (parsed) {
                targetMonth = parsed;
            }

            // Check if second argument is a custom year (e.g. !libur maret 2026)
            if (args[1]) {
                const yr = parseInt(args[1], 10);
                if (!isNaN(yr) && yr >= 2020 && yr <= 2030) {
                    targetYear = yr;
                }
            }
        }

        try {
            const holidays = await getHolidays(targetYear, targetMonth, logger);
            const text = formatHolidays(holidays, targetMonth, targetYear);
            return sock.sendMessage(remoteJid, { text }, { quoted: msg });
        } catch (err) {
            logger?.error?.({ err }, '[Libur] Failed to retrieve holidays');
            return sock.sendMessage(remoteJid, {
                text: `❌ *Gagal mengambil data hari libur.*\nMohon coba lagi beberapa saat lagi.`
            }, { quoted: msg });
        }
    }
};
