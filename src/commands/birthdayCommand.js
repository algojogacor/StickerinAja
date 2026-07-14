// Birthday commands: !ultah tambah/ubah/hapus/list/hariini/berikutnya/test/mode
const { addBirthday, removeBirthday, updateBirthday, getBirthdaysList, getTodayBirthdays, getTomorrowBirthdays,
    isTakeoverActive, activateTakeover, deactivateTakeover, evaluateAndActivate, getWIBToday } = require('../services/birthdayService');
const { BIRTHDAY_FEATURE_ENABLED, BIRTHDAY_TAKEOVER_ENABLED } = require('../config/birthdayConfig');

const OWNER_JID = (process.env.OWNER_JID || '').replace(/@.*/, '') + '@s.whatsapp.net';

function isAdmin(sock, msg, remoteJid) {
    const senderId = msg.key.participant || msg.key.remoteJid;
    return senderId === OWNER_JID || senderId === remoteJid; // Simplified: owner or group chat
}

function parseDate(str) {
    if (!str) return null;
    const m = str.match(/^(\d{1,2})-(\d{1,2})$/);
    if (!m) return null;
    const day = parseInt(m[1]), month = parseInt(m[2]);
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;
    return { day, month };
}

async function handleTambah(ctx) {
    const { sock, msg, args, remoteJid, logger } = ctx;
    if (!isAdmin(sock, msg, remoteJid)) {
        return sock.sendMessage(remoteJid, { text: '⚠️ Hanya admin grup atau pemilik bot yang bisa menambah data ulang tahun.' }, { quoted: msg });
    }

    // Get mentioned person
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const qMention = msg.message?.extendedTextMessage?.contextInfo?.participant;
    const pid = mentioned[0] || qMention;
    if (!pid) {
        return sock.sendMessage(remoteJid, { text: '⚠️ Tag orang yang ulang tahun. Contoh: _!ultah tambah @orang 17-08_' }, { quoted: msg });
    }

    // Find date in args
    let dateStr = '', year = null;
    for (const arg of args) {
        if (/\d{1,2}-\d{1,2}(-\d{4})?/.test(arg)) { dateStr = arg; break; }
    }
    const parsed = parseDate(dateStr);
    if (!parsed) {
        return sock.sendMessage(remoteJid, { text: '⚠️ Format tanggal: DD-MM. Contoh: _!ultah tambah @orang 17-08_' }, { quoted: msg });
    }

    // Year
    const ym = dateStr.match(/(\d{4})$/);
    if (ym) year = parseInt(ym[1]);

    const name = pid.split('@')[0].replace(/[^a-zA-Z0-9 _-]/g, '') || 'Unknown';
    await addBirthday(remoteJid, pid, name, parsed.day, parsed.month, year, msg.key.participant || 'unknown');

    await sock.sendMessage(remoteJid, {
        text: `✅ Ulang tahun *${name}* ditambahkan: ${String(parsed.day).padStart(2,'0')}-${String(parsed.month).padStart(2,'0')}${year ? ` (${year})` : ''}`,
        mentions: [pid]
    }, { quoted: msg });
}

async function handleUbah(ctx) {
    const { sock, msg, args, remoteJid } = ctx;
    if (!isAdmin(sock, msg, remoteJid)) {
        return sock.sendMessage(remoteJid, { text: '⚠️ Hanya admin grup atau pemilik bot.' }, { quoted: msg });
    }
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const pid = mentioned[0];
    if (!pid) {
        return sock.sendMessage(remoteJid, { text: '⚠️ Tag orang yang ingin diubah data ulang tahunnya.' }, { quoted: msg });
    }
    let dateStr = '';
    for (const arg of args) {
        if (/\d{1,2}-\d{1,2}/.test(arg)) { dateStr = arg; break; }
    }
    const parsed = parseDate(dateStr);
    if (!parsed) {
        return sock.sendMessage(remoteJid, { text: '⚠️ Format: _!ultah ubah @orang DD-MM_' }, { quoted: msg });
    }
    await updateBirthday(remoteJid, pid, { birthDay: parsed.day, birthMonth: parsed.month });
    await sock.sendMessage(remoteJid, { text: `✅ Data ulang tahun diperbarui.`, mentions: [pid] }, { quoted: msg });
}

async function handleHapus(ctx) {
    const { sock, msg, args, remoteJid } = ctx;
    if (!isAdmin(sock, msg, remoteJid)) {
        return sock.sendMessage(remoteJid, { text: '⚠️ Hanya admin grup atau pemilik bot.' }, { quoted: msg });
    }
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const pid = mentioned[0];
    if (!pid) {
        return sock.sendMessage(remoteJid, { text: '⚠️ Tag orang yang ingin dihapus data ulang tahunnya.' }, { quoted: msg });
    }
    await removeBirthday(remoteJid, pid);
    await sock.sendMessage(remoteJid, { text: '✅ Data ulang tahun dihapus.', mentions: [pid] }, { quoted: msg });
}

async function handleList(ctx) {
    const { sock, msg, remoteJid } = ctx;
    const all = await getBirthdaysList(remoteJid);
    if (!all.length) {
        return sock.sendMessage(remoteJid, { text: '📋 Belum ada data ulang tahun. Tambah dengan _!ultah tambah @orang DD-MM_' }, { quoted: msg });
    }
    const sorted = all.sort((a, b) => (a.birthMonth * 100 + a.birthDay) - (b.birthMonth * 100 + b.birthDay));
    const lines = ['🎂 *DAFTAR ULANG TAHUN*', ''];
    for (const r of sorted) {
        const ageInfo = r.birthYear ? ` (lahir ${r.birthYear})` : '';
        lines.push(`• ${String(r.birthDay).padStart(2,'0')}-${String(r.birthMonth).padStart(2,'0')} — ${r.name}${ageInfo}`);
    }
    await sock.sendMessage(remoteJid, { text: lines.join('\n') }, { quoted: msg });
}

async function handleHariIni(ctx) {
    const { sock, msg, remoteJid } = ctx;
    const birthdays = await getTodayBirthdays(remoteJid);
    if (!birthdays.length) {
        return sock.sendMessage(remoteJid, { text: '🎂 Tidak ada yang ulang tahun hari ini.' }, { quoted: msg });
    }
    const mentions = birthdays.map(p => p.participantId);
    const lines = ['🎂 *YANG ULANG TAHUN HARI INI* 🎂', ''];
    for (const p of birthdays) {
        lines.push(`🎉 @${p.name}`);
    }
    lines.push('', 'Ketik _!ultah mode on_ untuk mengaktifkan Birthday Takeover!');
    await sock.sendMessage(remoteJid, { text: lines.join('\n'), mentions }, { quoted: msg });
}

async function handleBerikutnya(ctx) {
    const { sock, msg, remoteJid } = ctx;
    const tomorrow = await getTomorrowBirthdays(remoteJid);
    if (tomorrow.length) {
        const mentions = tomorrow.map(p => p.participantId);
        const lines = ['📅 *BESOK ADA YANG ULANG TAHUN!*', '', ...tomorrow.map(p => `🎂 @${p.name}`)];
        return sock.sendMessage(remoteJid, { text: lines.join('\n'), mentions }, { quoted: msg });
    }
    // Find next birthday
    const all = await getBirthdaysList(remoteJid);
    if (!all.length) return sock.sendMessage(remoteJid, { text: '📋 Belum ada data.' }, { quoted: msg });
    const { day, month } = getWIBToday();
    const sorted = all.map(r => {
        let dist = (r.birthMonth * 100 + r.birthDay) - (month * 100 + day);
        if (dist <= 0) dist += 1300; // wrap to next year
        return { ...r, dist };
    }).sort((a, b) => a.dist - b.dist);

    const next = sorted[0];
    await sock.sendMessage(remoteJid, {
        text: `📅 *ULANG TAHUN BERIKUTNYA*\n\n${String(next.birthDay).padStart(2,'0')}-${String(next.birthMonth).padStart(2,'0')} — ${next.name}`,
        mentions: [next.participantId]
    }, { quoted: msg });
}

async function handleMode(ctx) {
    const { sock, msg, args, remoteJid } = ctx;
    if (!isAdmin(sock, msg, remoteJid)) {
        return sock.sendMessage(remoteJid, { text: '⚠️ Hanya admin grup atau pemilik bot.' }, { quoted: msg });
    }
    const mode = args[0]?.toLowerCase();
    if (mode === 'on') {
        const birthdays = await getTodayBirthdays(remoteJid);
        if (!birthdays.length) return sock.sendMessage(remoteJid, { text: '⚠️ Tidak ada yang ulang tahun hari ini.' }, { quoted: msg });
        await activateTakeover(remoteJid, birthdays);
        return sock.sendMessage(remoteJid, {
            text: `✅ *Birthday Takeover AKTIF!*\n\nSeluruh cron normal akan ditunda hari ini untuk merayakan ${birthdays.map(p => p.name).join(' & ')}.`,
            mentions: birthdays.map(p => p.participantId)
        }, { quoted: msg });
    }
    if (mode === 'off') {
        await deactivateTakeover(remoteJid);
        return sock.sendMessage(remoteJid, { text: '✅ Birthday Takeover dinonaktifkan. Cron normal akan dilanjutkan.' }, { quoted: msg });
    }
    const active = await isTakeoverActive(remoteJid);
    return sock.sendMessage(remoteJid, {
        text: active ? '🔴 Birthday Takeover sedang *AKTIF*. Gunakan _!ultah mode off_ untuk menonaktifkan.' : '🟢 Birthday Takeover *TIDAK AKTIF*. Gunakan _!ultah mode on_ untuk mengaktifkan.'
    }, { quoted: msg });
}

async function handleTest(ctx) {
    const { sock, msg, remoteJid } = ctx;
    if (!isAdmin(sock, msg, remoteJid)) {
        return sock.sendMessage(remoteJid, { text: '⚠️ Hanya admin.' }, { quoted: msg });
    }
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (!mentioned[0]) return sock.sendMessage(remoteJid, { text: '⚠️ Tag orang untuk test.' }, { quoted: msg });
    const name = mentioned[0].split('@')[0].replace(/[^a-zA-Z0-9 _-]/g, '') || 'Unknown';

    await sock.sendMessage(remoteJid, { text: `🧪 *[TEST MODE]* 🧪\n\n🚨🎉 Seandainya ini hari ulang tahun @${name}...\n\nSelamat ulang tahun! 🎂`, mentions: [mentioned[0]] });

    setTimeout(async () => {
        await sock.sendMessage(remoteJid, { text: `🧪 *[TEST MODE]* 🧪\n\n🎂 Ini adalah simulasi ucapan untuk @${name}`, mentions: [mentioned[0]] });
        setTimeout(async () => {
            await sock.sendMessage(remoteJid, { text: `🧪 *[TEST MODE]* 🧪\n\n✅ Simulasi selesai. Cron normal tidak terpengaruh.` });
        }, 2000);
    }, 3000);
}

module.exports = {
    names: ['ultah', 'birthday'],
    async execute(ctx) {
        if (!BIRTHDAY_FEATURE_ENABLED) return;
        const sub = ctx.args[0]?.toLowerCase();
        if (!sub) {
            return ctx.sock.sendMessage(ctx.remoteJid, {
                text: `🎂 *BIRTHDAY MANAGER*\n\nGunakan:\n_!ultah tambah @orang DD-MM_\n_!ultah ubah @orang DD-MM_\n_!ultah hapus @orang_\n_!ultah list_\n_!ultah hariini_\n_!ultah berikutnya_\n_!ultah test @orang_\n_!ultah mode on/off_`
            }, { quoted: ctx.msg });
        }
        if (sub === 'tambah' || sub === 'add') return handleTambah(ctx);
        if (sub === 'ubah' || sub === 'edit') return handleUbah(ctx);
        if (sub === 'hapus' || sub === 'delete' || sub === 'remove') return handleHapus(ctx);
        if (sub === 'list') return handleList(ctx);
        if (sub === 'hariini' || sub === 'today') return handleHariIni(ctx);
        if (sub === 'berikutnya' || sub === 'next') return handleBerikutnya(ctx);
        if (sub === 'test') return handleTest(ctx);
        if (sub === 'mode') return handleMode(ctx);
    }
};
