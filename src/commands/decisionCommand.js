// Decision commands: !pilih, !acak, !bagitim, !urutkan, !koin, !dadu, !angka, !pasangan
// Auto-loaded by handler scanner. No cron. Works during birthday takeover.
const { pick, splitTeams, shuffle, rollDice, flipCoin, randomNumber, makePairs } = require('../services/decisionService');

// ── Cooldown (5s per group to prevent spam) ──────────────
const cooldowns = new Map();
const COOLDOWN_MS = 5000;

function checkCooldown(groupJid) {
    const last = cooldowns.get(groupJid);
    if (last && Date.now() - last < COOLDOWN_MS) return false;
    cooldowns.set(groupJid, Date.now());
    return true;
}

/** Extract unique mention IDs from a message, excluding bot self. */
function getMentions(msg) {
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const qMention = msg.message?.extendedTextMessage?.contextInfo?.participant;
    const unique = [...new Set(mentioned.filter(Boolean))];
    if (qMention && !unique.includes(qMention)) unique.push(qMention);
    return unique;
}

function getMentionNames(msg) {
    const mentions = getMentions(msg);
    return mentions.map(id => {
        const name = id.split('@')[0];
        return { id, displayName: name.replace(/[^a-zA-Z0-9 _-]/g, '') || 'Unknown' };
    });
}

async function pilihCommand(ctx) {
    const { sock, msg, args, remoteJid } = ctx;
    if (!checkCooldown(remoteJid)) {
        return sock.sendMessage(remoteJid, { text: '⏳ Tunggu 5 detik dulu...' }, { quoted: msg });
    }

    const input = args.join(' ').trim();
    if (!input.includes('|') && !input.includes('\n')) {
        return sock.sendMessage(remoteJid, {
            text: '🎯 Gunakan: _!pilih opsi1 | opsi2 | opsi3_'
        }, { quoted: msg });
    }

    const options = input.split(/[|\n]/).map(o => o.trim()).filter(Boolean);
    if (options.length < 2) {
        return sock.sendMessage(remoteJid, {
            text: '⚠️ Minimal 2 pilihan, pisahkan dengan |'
        }, { quoted: msg });
    }
    if (options.length > 50) {
        return sock.sendMessage(remoteJid, {
            text: '⚠️ Maksimal 50 pilihan'
        }, { quoted: msg });
    }

    const chosen = pick(options);
    const displayOptions = options.map((o, i) => `${i + 1}. ${o}`).join('\n');

    await sock.sendMessage(remoteJid, {
        text: `🎯 *HASIL PILIHAN*\n\nDari pilihan:\n${displayOptions}\n\nBot memilih: *${chosen}*\n\n_Pilihan dilakukan secara acak._`
    }, { quoted: msg });
}

async function acakCommand(ctx) {
    const { sock, msg, remoteJid } = ctx;
    if (!checkCooldown(remoteJid)) {
        return sock.sendMessage(remoteJid, { text: '⏳ Tunggu 5 detik dulu...' }, { quoted: msg });
    }

    const people = getMentionNames(msg);
    if (people.length < 2) {
        return sock.sendMessage(remoteJid, {
            text: '⚠️ Tag minimal 2 orang. Contoh: _!acak @orang1 @orang2 @orang3_'
        }, { quoted: msg });
    }

    const shuffled = shuffle(people);
    const lines = ['🎲 *ACAK URUTAN*', ''];
    shuffled.forEach((p, i) => {
        lines.push(`${i + 1}. @${p.displayName}`);
    });

    await sock.sendMessage(remoteJid, {
        text: lines.join('\n'),
        mentions: shuffled.map(p => p.id)
    }, { quoted: msg });
}

async function bagiTimCommand(ctx) {
    const { sock, msg, args, remoteJid } = ctx;
    if (!checkCooldown(remoteJid)) {
        return sock.sendMessage(remoteJid, { text: '⏳ Tunggu 5 detik dulu...' }, { quoted: msg });
    }

    const teamCount = parseInt(args[0]);
    if (!teamCount || teamCount < 2 || teamCount > 20) {
        return sock.sendMessage(remoteJid, {
            text: '⚠️ Gunakan: _!bagitim <jumlah tim> @orang1 @orang2 ..._\nContoh: _!bagitim 2 @ardi @budi @cici @doni_'
        }, { quoted: msg });
    }

    // Get people from mentions (skip first arg which is team count)
    const people = getMentionNames(msg);
    if (people.length < teamCount) {
        return sock.sendMessage(remoteJid, {
            text: `⚠️ Butuh minimal ${teamCount} peserta untuk ${teamCount} tim.`
        }, { quoted: msg });
    }

    const teams = splitTeams(people, teamCount);
    const lines = ['🎲 *PEMBAGIAN TIM*', ''];
    const allMentions = [];

    for (let i = 0; i < teams.length; i++) {
        lines.push(`*Tim ${i + 1}*`);
        for (const p of teams[i]) {
            lines.push(`• @${p.displayName}`);
            allMentions.push(p.id);
        }
        lines.push('');
    }

    await sock.sendMessage(remoteJid, {
        text: lines.join('\n'),
        mentions: allMentions
    }, { quoted: msg });
}

async function urutkanCommand(ctx) {
    const { sock, msg, args, remoteJid } = ctx;
    if (!checkCooldown(remoteJid)) {
        return sock.sendMessage(remoteJid, { text: '⏳ Tunggu 5 detik dulu...' }, { quoted: msg });
    }

    const input = args.join(' ').trim();
    if (!input.includes('|') && !input.includes('\n')) {
        return sock.sendMessage(remoteJid, {
            text: '🔀 Gunakan: _!urutkan item1 | item2 | item3_'
        }, { quoted: msg });
    }

    const items = input.split(/[|\n]/).map(o => o.trim()).filter(Boolean);
    if (items.length < 2) {
        return sock.sendMessage(remoteJid, {
            text: '⚠️ Minimal 2 item untuk diurutkan'
        }, { quoted: msg });
    }

    const shuffled = shuffle(items);
    const lines = ['🔀 *URUTAN ACAK*', ''];
    shuffled.forEach((item, i) => {
        lines.push(`${i + 1}. ${item}`);
    });

    await sock.sendMessage(remoteJid, { text: lines.join('\n') }, { quoted: msg });
}

async function koinCommand(ctx) {
    const { sock, msg, remoteJid } = ctx;
    if (!checkCooldown(remoteJid)) {
        return sock.sendMessage(remoteJid, { text: '⏳ Tunggu 5 detik dulu...' }, { quoted: msg });
    }

    const result = flipCoin();
    const emoji = result === 'Kepala' ? '🪙' : '🪙';
    await sock.sendMessage(remoteJid, {
        text: `${emoji} *Koin dilempar!*\n\nHasil: *${result}*`
    }, { quoted: msg });
}

async function daduCommand(ctx) {
    const { sock, msg, args, remoteJid } = ctx;
    if (!checkCooldown(remoteJid)) {
        return sock.sendMessage(remoteJid, { text: '⏳ Tunggu 5 detik dulu...' }, { quoted: msg });
    }

    let sides = 6;
    if (args[0]) {
        sides = parseInt(args[0]);
        if (isNaN(sides) || sides < 2 || sides > 1000) {
            return sock.sendMessage(remoteJid, {
                text: '⚠️ Jumlah sisi dadu: 2–1000'
            }, { quoted: msg });
        }
    }

    const result = rollDice(sides);
    await sock.sendMessage(remoteJid, {
        text: `🎲 *Dadu ${sides} sisi dilempar!*\n\nHasil: *${result}*`
    }, { quoted: msg });
}

async function angkaCommand(ctx) {
    const { sock, msg, args, remoteJid } = ctx;
    if (!checkCooldown(remoteJid)) {
        return sock.sendMessage(remoteJid, { text: '⏳ Tunggu 5 detik dulu...' }, { quoted: msg });
    }

    const min = parseInt(args[0]);
    const max = parseInt(args[1]);
    if (isNaN(min) || isNaN(max)) {
        return sock.sendMessage(remoteJid, {
            text: '🔢 Gunakan: _!angka <min> <max>_\nContoh: _!angka 1 100_'
        }, { quoted: msg });
    }

    const result = randomNumber(min, max);
    await sock.sendMessage(remoteJid, {
        text: `🔢 *Angka acak (${min}–${max})*\n\nHasil: *${result}*`
    }, { quoted: msg });
}

async function pasanganCommand(ctx) {
    const { sock, msg, remoteJid } = ctx;
    if (!checkCooldown(remoteJid)) {
        return sock.sendMessage(remoteJid, { text: '⏳ Tunggu 5 detik dulu...' }, { quoted: msg });
    }

    const people = getMentionNames(msg);
    if (people.length < 2) {
        return sock.sendMessage(remoteJid, {
            text: '💕 Tag minimal 2 orang. Contoh: _!pasangan @orang1 @orang2 @orang3 @orang4_'
        }, { quoted: msg });
    }

    const pairs = makePairs(people);
    const lines = ['💕 *PASANGAN ACAK*', ''];
    const allMentions = [];

    for (let i = 0; i < pairs.length; i++) {
        const { pair, type } = pairs[i];
        if (type === 'pair') {
            lines.push(`❤️ Pasangan ${i + 1}: @${pair[0].displayName} & @${pair[1].displayName}`);
            allMentions.push(pair[0].id, pair[1].id);
        } else {
            lines.push(`😢 Sendiri: @${pair[0].displayName}`);
            allMentions.push(pair[0].id);
        }
    }

    await sock.sendMessage(remoteJid, {
        text: lines.join('\n'),
        mentions: allMentions
    }, { quoted: msg });
}

module.exports = {
    names: ['pilih', 'choose', 'acak', 'shuffle', 'bagitim', 'split', 'urutkan',
        'koin', 'coin', 'dadu', 'dice', 'angka', 'random', 'pasangan', 'pairs'],
    async execute(ctx) {
        const cmd = ctx.cmdName;

        if (cmd === 'pilih' || cmd === 'choose') return pilihCommand(ctx);
        if (cmd === 'acak' || cmd === 'shuffle') return acakCommand(ctx);
        if (cmd === 'bagitim' || cmd === 'split') return bagiTimCommand(ctx);
        if (cmd === 'urutkan') return urutkanCommand(ctx);
        if (cmd === 'koin' || cmd === 'coin') return koinCommand(ctx);
        if (cmd === 'dadu' || cmd === 'dice') return daduCommand(ctx);
        if (cmd === 'angka' || cmd === 'random') return angkaCommand(ctx);
        if (cmd === 'pasangan' || cmd === 'pairs') return pasanganCommand(ctx);
    }
};
