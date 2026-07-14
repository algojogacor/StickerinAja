// Birthday message formatter.
const { SPOTLIGHT_TEMPLATES, BIRTHDAY_SONG_URL } = require('../config/birthdayConfig');

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function namesToMentionText(persons) {
    return persons.map(p => `@${p.name}`).join(', ');
}

function namesToMentionList(persons) {
    return persons.map(p => p.participantId);
}

function formatGrandOpening(persons) {
    const mentionText = namesToMentionText(persons);
    const names = persons.map(p => p.name).join(' & ');
    return {
        text: `🚨🎉 *PERHATIAN WARGA GRUP!* 🎉🚨\n\nHari ini bukan hari biasa.\n\nHari ini adalah hari ulang tahunnya\n🎂 *${names}* 🎂\n\nSelamat ulang tahun! Hari ini grup resmi diambil alih untuk merayakan kamu 🥳`,
        mentions: namesToMentionList(persons)
    };
}

function formatBirthdaySong(persons) {
    const mentionText = namesToMentionText(persons);
    let text = `🎸 *LAGU WAJIB HARI INI*\n\nBangun, ${mentionText}! Lagu kebangsaan ulang tahunmu sudah diputar 🎂\n\nSelamat ulang tahun! Semoga hari ini penuh hal baik dan orang-orang yang sayang sama kamu.`;
    if (BIRTHDAY_SONG_URL) text += `\n\n🎵 ${BIRTHDAY_SONG_URL}`;
    return { text, mentions: namesToMentionList(persons) };
}

function formatBirthdayCard(persons) {
    const mentionText = namesToMentionText(persons);
    return {
        text: `🎁 *SPECIAL BIRTHDAY CARD*\n\nKartu spesial untuk ${mentionText} dari seluruh warga grup 💐\n\nSemoga tahun barumu membawa lebih banyak kebahagiaan, pengalaman seru, dan hal-hal baik.`,
        mentions: namesToMentionList(persons)
    };
}

function formatOpenWishes(persons) {
    const mentionText = namesToMentionText(persons);
    return {
        text: `📢 *SESI UCAPAN DIBUKA!*\n\nSemua warga grup dipersilakan meninggalkan ucapan, doa, cerita lucu, atau pesan untuk ${mentionText}.\n\nReply pesan ini agar ucapan kalian masuk ke Birthday Recap malam nanti 🎉`,
        mentions: namesToMentionList(persons)
    };
}

function formatBirthdaySpotlight(persons) {
    const mentionText = namesToMentionText(persons);
    const template = pick(SPOTLIGHT_TEMPLATES);
    const msg = template.replace(/@BIRTHDAY_PERSON/g, mentionText);
    return { text: msg, mentions: namesToMentionList(persons) };
}

function formatCrowdReminder(persons) {
    const mentionText = namesToMentionText(persons);
    return {
        text: `🎊 *MASIH ADA WAKTU!*\n\nYang belum mengucapkan selamat kepada ${mentionText}, sesi ucapan masih dibuka sampai malam.\n\nBoleh kirim doa, pesan, meme, foto, atau cerita lucu kalian 🎂`,
        mentions: namesToMentionList(persons)
    };
}

function formatBirthdayRecap(persons, wishes, reactions) {
    const mentionText = namesToMentionText(persons);
    const lines = [`💌 *BIRTHDAY WISHES FOR ${persons.map(p => p.name).join(' & ').toUpperCase()}*`, ''];

    if (wishes && wishes.length > 0) {
        for (const w of wishes) {
            const sender = w.sender_name || 'Anonymous';
            const msg = (w.message_text || '').slice(0, 300);
            if (msg.trim()) lines.push(`Dari ${sender}:\n_"${msg}"_\n`);
        }
    } else {
        lines.push('Belum ada ucapan yang masuk — tapi semuanya tetap sayang kok! 🥰');
    }

    // Reactions summary
    if (reactions && Object.keys(reactions).length > 0) {
        lines.push('');
        lines.push('*Reactions:*');
        for (const [emoji, count] of Object.entries(reactions)) {
            lines.push(`${emoji} ${count}`);
        }
    }

    return { text: lines.join('\n'), mentions: namesToMentionList(persons) };
}

function formatClosing(persons) {
    const mentionText = namesToMentionText(persons);
    const names = persons.map(p => p.name).join(' & ');
    return {
        text: `🌙 *BIRTHDAY TAKEOVER CLOSING*\n\nSatu hari penuh untuk merayakan ${names} hampir selesai.\n\nTerima kasih sudah menjadi bagian dari grup ini. Semoga semua doa baik hari ini kembali menjadi kebahagiaan untukmu.\n\nSelamat ulang tahun sekali lagi, ${mentionText}! 🎂✨`,
        mentions: namesToMentionList(persons)
    };
}

module.exports = { formatGrandOpening, formatBirthdaySong, formatBirthdayCard, formatOpenWishes,
    formatBirthdaySpotlight, formatCrowdReminder, formatBirthdayRecap, formatClosing };
