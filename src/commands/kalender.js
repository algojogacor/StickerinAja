/**
 * COMMAND: !kalender, !cal, !calendar
 * Visual Calendar Generator (PNG) with Indonesian National Holidays & Cuti Bersama.
 */

const sharp = require('sharp');
const { parseMonth, getHolidays } = require('./libur');

const MONTH_NAMES = [
    '', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
];

const DAY_NAMES = ['MIN', 'SEN', 'SEL', 'RAB', 'KAM', 'JUM', 'SAB'];

/**
 * Generate Visual Calendar PNG Buffer using SVG template + Sharp
 * @param {number} year - Target Year (e.g. 2026)
 * @param {number} month - Target Month (1 - 12)
 * @param {Array} holidays - Array of holiday items
 * @returns {Promise<Buffer>} PNG image buffer
 */
async function generateCalendarPng(year, month, holidays = []) {
    const monthStr = String(month).padStart(2, '0');
    const holidaysInMonth = (Array.isArray(holidays) ? holidays : [])
        .filter(h => h && h.date && h.date.startsWith(`${year}-${monthStr}`));

    // Map day number -> holiday object
    const holidayMap = new Map();
    holidaysInMonth.forEach(h => {
        const parts = h.date.split('-');
        if (parts.length === 3) {
            const day = parseInt(parts[2], 10);
            if (!isNaN(day)) {
                holidayMap.set(day, h);
            }
        }
    });

    // Calendar date calculations
    const firstDayIndex = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0 = Sunday
    const totalDaysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const prevMonthDays = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();

    const nowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const isCurrentMonth = (nowWib.getUTCFullYear() === year && (nowWib.getUTCMonth() + 1) === month);
    const currentDay = isCurrentMonth ? nowWib.getUTCDate() : -1;

    // Dimensions
    const width = 800;
    const padding = 40;
    const gridTop = 180;
    const colWidth = (width - padding * 2) / 7;
    const rowHeight = 64;

    // Build day cells
    let cellsSvg = '';
    let row = 0;
    let col = firstDayIndex;

    // 1. Previous month padding days
    for (let i = 0; i < firstDayIndex; i++) {
        const prevDay = prevMonthDays - firstDayIndex + 1 + i;
        const x = padding + i * colWidth + colWidth / 2;
        const y = gridTop + row * rowHeight + 35;
        cellsSvg += `<text x="${x}" y="${y}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="18" fill="#4B5563" font-weight="500">${prevDay}</text>`;
    }

    // 2. Current month days
    for (let day = 1; day <= totalDaysInMonth; day++) {
        const x = padding + col * colWidth + colWidth / 2;
        const y = gridTop + row * rowHeight + 35;
        const isToday = (day === currentDay);
        const isSunday = (col === 0);
        const holiday = holidayMap.get(day);

        // Highlight circle for today or holiday
        if (isToday) {
            cellsSvg += `<circle cx="${x}" cy="${gridTop + row * rowHeight + 28}" r="22" fill="#3B82F6" />`;
        } else if (holiday) {
            const circleColor = holiday.isCutiBersama ? 'rgba(234, 179, 8, 0.2)' : 'rgba(239, 68, 68, 0.2)';
            cellsSvg += `<circle cx="${x}" cy="${gridTop + row * rowHeight + 28}" r="22" fill="${circleColor}" />`;
        }

        // Text styling
        let textColor = '#F3F4F6';
        let fontWeight = '500';

        if (isToday) {
            textColor = '#FFFFFF';
            fontWeight = '700';
        } else if (holiday) {
            textColor = holiday.isCutiBersama ? '#FACC15' : '#F87171';
            fontWeight = '700';
        } else if (isSunday) {
            textColor = '#F87171';
        }

        cellsSvg += `<text x="${x}" y="${y}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="20" fill="${textColor}" font-weight="${fontWeight}">${day}</text>`;

        // Add dot marker for holiday
        if (holiday && !isToday) {
            const dotColor = holiday.isCutiBersama ? '#FACC15' : '#EF4444';
            cellsSvg += `<circle cx="${x}" cy="${gridTop + row * rowHeight + 52}" r="3" fill="${dotColor}" />`;
        }

        col++;
        if (col > 6) {
            col = 0;
            row++;
        }
    }

    // 3. Next month padding days
    if (col > 0) {
        let nextDay = 1;
        while (col <= 6) {
            const x = padding + col * colWidth + colWidth / 2;
            const y = gridTop + row * rowHeight + 35;
            cellsSvg += `<text x="${x}" y="${y}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="18" fill="#4B5563" font-weight="500">${nextDay}</text>`;
            nextDay++;
            col++;
        }
        row++;
    }

    // Bottom section: Holiday list
    const holidayListTop = gridTop + row * rowHeight + 40;
    let holidayListSvg = '';
    let curY = holidayListTop;

    if (holidaysInMonth.length > 0) {
        holidayListSvg += `<line x1="${padding}" y1="${curY - 15}" x2="${width - padding}" y2="${curY - 15}" stroke="#374151" stroke-width="1.5" />`;
        holidayListSvg += `<text x="${padding}" y="${curY + 10}" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="700" fill="#9CA3AF">HARI LIBUR &amp; CUTI BERSAMA</text>`;
        curY += 38;

        holidaysInMonth.forEach(h => {
            const d = parseInt(h.date.split('-')[2], 10);
            const tagColor = h.isCutiBersama ? '#FACC15' : '#EF4444';
            const tagBg = h.isCutiBersama ? 'rgba(234, 179, 8, 0.15)' : 'rgba(239, 68, 68, 0.15)';
            const typeText = h.isCutiBersama ? 'Cuti Bersama' : 'Libur Nasional';
            const cleanName = (h.name || '').replace(/&/g, '&amp;');

            holidayListSvg += `
                <rect x="${padding}" y="${curY - 16}" width="38" height="24" rx="6" fill="${tagBg}" />
                <text x="${padding + 19}" y="${curY + 1}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="14" font-weight="700" fill="${tagColor}">${d}</text>
                <text x="${padding + 50}" y="${curY + 1}" font-family="system-ui, -apple-system, sans-serif" font-size="15" font-weight="500" fill="#E5E7EB">${cleanName}</text>
                <text x="${width - padding}" y="${curY + 1}" text-anchor="end" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="600" fill="${tagColor}">${typeText}</text>
            `;
            curY += 32;
        });
    }

    const totalHeight = Math.max(680, curY + 30);

    // Full SVG Document
    const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}">
        <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#0F172A" />
                <stop offset="100%" stop-color="#1E293B" />
            </linearGradient>
        </defs>

        <!-- Background Container -->
        <rect width="${width}" height="${totalHeight}" fill="url(#bg)" rx="24" />
        <rect x="2" y="2" width="${width - 4}" height="${totalHeight - 4}" fill="none" stroke="#334155" stroke-width="2" rx="22" />

        <!-- Header -->
        <g transform="translate(${padding}, 40)">
            <text x="0" y="32" font-family="system-ui, -apple-system, sans-serif" font-size="34" font-weight="800" fill="#FFFFFF" letter-spacing="-0.5">${MONTH_NAMES[month]} ${year}</text>
            <text x="0" y="58" font-family="system-ui, -apple-system, sans-serif" font-size="15" font-weight="500" fill="#94A3B8">Kalender Nasional Indonesia &amp; Cuti Bersama</text>

            <!-- Legend pills -->
            <g transform="translate(${width - padding * 2 - 260}, 14)">
                <circle cx="10" cy="12" r="5" fill="#3B82F6" />
                <text x="22" y="16" font-family="system-ui, -apple-system, sans-serif" font-size="12" fill="#94A3B8">Hari Ini</text>

                <circle cx="90" cy="12" r="5" fill="#EF4444" />
                <text x="102" y="16" font-family="system-ui, -apple-system, sans-serif" font-size="12" fill="#94A3B8">Libur</text>

                <circle cx="160" cy="12" r="5" fill="#FACC15" />
                <text x="172" y="16" font-family="system-ui, -apple-system, sans-serif" font-size="12" fill="#94A3B8">Cuti</text>
            </g>
        </g>

        <!-- Day Names Row -->
        <g transform="translate(0, 130)">
            <rect x="${padding}" y="0" width="${width - padding * 2}" height="38" rx="8" fill="#1E293B" />
            ${DAY_NAMES.map((name, i) => {
                const x = padding + i * colWidth + colWidth / 2;
                const color = (i === 0) ? '#EF4444' : '#94A3B8';
                return `<text x="${x}" y="24" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="14" font-weight="700" fill="${color}" letter-spacing="1">${name}</text>`;
            }).join('')}
        </g>

        <!-- Calendar Days Grid -->
        ${cellsSvg}

        <!-- Holidays Footer Section -->
        ${holidayListSvg}
    </svg>
    `;

    return sharp(Buffer.from(svg))
        .png({ compressionLevel: 8 })
        .toBuffer();
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
        cmdName: args?._command || 'kalender',
        remoteJid: msg?.key?.remoteJid,
        logger: ctx?.logger
    };
}

module.exports = {
    names: ['kalender', 'cal', 'calendar'],
    generateCalendarPng,
    execute: async (sockOrOpts, rawMsg, rawArgs, ctx) => {
        const { sock, msg, args, remoteJid, logger } = normalizeParams(sockOrOpts, rawMsg, rawArgs, ctx);

        // Determine default month and year (WIB time)
        const nowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
        let targetYear = nowWib.getUTCFullYear();
        let targetMonth = nowWib.getUTCMonth() + 1;

        if (args.length > 0) {
            const parsed = parseMonth(args[0]);
            if (!parsed) {
                return sock.sendMessage(remoteJid, {
                    text: `❌ Bulan tidak valid.`
                }, { quoted: msg });
            }
            targetMonth = parsed;

            // Optional year argument (e.g. !kalender maret 2026)
            if (args[1]) {
                const yr = parseInt(args[1], 10);
                if (!isNaN(yr) && yr >= 1900 && yr <= 2100) {
                    targetYear = yr;
                }
            }
        }

        // Fetch holiday data with graceful fallback
        let holidays = [];
        try {
            holidays = await getHolidays(targetYear, targetMonth, logger);
        } catch (err) {
            logger?.warn?.({ err }, '[Kalender] Failed to load holidays, rendering base calendar');
            holidays = [];
        }

        try {
            const pngBuffer = await generateCalendarPng(targetYear, targetMonth, holidays);
            return sock.sendMessage(remoteJid, {
                image: pngBuffer,
                caption: `📅 *Kalender ${MONTH_NAMES[targetMonth]} ${targetYear}*`
            }, { quoted: msg });
        } catch (err) {
            logger?.error?.({ err }, '[Kalender] Error generating visual calendar image');
            return sock.sendMessage(remoteJid, {
                text: `❌ *Gagal membuat gambar kalender.*\nMohon coba lagi beberapa saat lagi.`
            }, { quoted: msg });
        }
    }
};
