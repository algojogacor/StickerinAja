const path = require('path');
const fs = require('fs');
const commands = new Map();

// Auto-load all command modules
const commandsDir = path.join(__dirname, 'commands');
fs.readdirSync(commandsDir).filter(f => f.endsWith('.js')).forEach(f => {
    const cmd = require(path.join(commandsDir, f));
    if (cmd.names && cmd.execute) {
        for (const name of cmd.names) {
            commands.set(name, cmd);
        }
    }
});

// Module-level config — read from env once
const PREFIX = process.env.PREFIX || '!';
const BOT_NAME = process.env.STICKERIN_BOT_NAME || 'Stikerin Aja';
const BOT_AUTHOR = process.env.STICKERIN_AUTHOR || 'Bot';

// Shared state across commands (pack/author settings)
const state = new Map();

// Active quiz state — tracks ongoing trivia sessions per chat
// Shared with scheduler via quizState module
const { activeQuizzes } = require('./utils/quizState');
const { recordAnswer, getLeaderboard, getUserScore } = require('./services/quizLeaderboard');

function getSession(jid) {
    if (!state.has(jid)) {
        state.set(jid, {
            pack: BOT_NAME,
            author: BOT_AUTHOR,
            quality: 80,
            type: 'default'
        });
    }
    return state.get(jid);
}

/**
 * Send content — handles both text and image types.
 */
async function sendContent(sock, jid, content, quotedMsg) {
    if (!content) return;
    if (content.type === 'image' && content.imageUrl) {
        await sock.sendMessage(jid, {
            image: { url: content.imageUrl },
            caption: content.caption || ''
        }, quotedMsg ? { quoted: quotedMsg } : {});
    } else if (content.text) {
        await sock.sendMessage(jid, { text: content.text }, quotedMsg ? { quoted: quotedMsg } : {});
    }
}


async function handler(sock, msg, logger) {
    const remoteJid = msg.key.remoteJid;
    const messageText =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

    // Birthday wish collection — before prefix, reply to open-wishes msg
    if (!messageText.startsWith(PREFIX)) {
        // Check if this is a reply to a birthday wish session message
        const quotedStanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
        const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
        if (quotedStanzaId || quotedParticipant) {
            const { isTakeoverActive } = require('./services/birthdayService');
            const { getTakeoverState, addWish } = require('./repositories/birthdayRepository');
            const isActive = await isTakeoverActive(remoteJid);
            if (isActive) {
                const { getWIBToday } = require('./services/birthdayService');
                const takeover = await getTakeoverState(remoteJid, getWIBToday().dateStr);
                const wishMsgId = takeover?.wishMessageId;
                if (wishMsgId && (quotedStanzaId === wishMsgId || quotedParticipant)) {
                    if (!msg.key.fromMe) {
                        const senderId = msg.key.participant || msg.key.remoteJid || 'unknown';
                        const senderName = msg.pushName || 'Anonymous';
                        const messageText_ = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
                        if (messageText_.trim()) {
                            await addWish({
                                groupJid: remoteJid, birthdayEventId: takeover?.wishMessageId || 'unknown',
                                senderId, senderName, messageText: messageText_, messageId: msg.key.id
                            });
                            logger.info({ senderName }, 'Birthday wish collected');
                        }
                        return; // Don't process as quiz answer
                    }
                }
            }
        }

        // Quiz answer check
        const trimmed = messageText.trim();
        const activeQuiz = activeQuizzes.get(remoteJid);
        if (activeQuiz && /^[A-Da-d]$/.test(trimmed)) {
            // Multiple choice (OpenTDB)
            const answer = trimmed.toUpperCase();
            logger.info({ chat: remoteJid, answer }, `Quiz answer: ${answer}`);

            if (activeQuiz.timeout) clearTimeout(activeQuiz.timeout);
            activeQuizzes.delete(remoteJid);

            const isCorrect = answer === activeQuiz.correctAnswer.toUpperCase();
            const senderId = msg.key.participant || msg.key.remoteJid || msg.pushName;
            const sender = msg.pushName || 'Anonymous';
            const stats = await recordAnswer(remoteJid, senderId, sender, isCorrect);

            if (isCorrect) {
                await sock.sendMessage(remoteJid, {
                    text: `🎉 *BENAR!* ${sender}!\n\nJawaban: *${activeQuiz.correctAnswer}* — ${activeQuiz.correctText}\n\n⭐ Score: ${stats.score} | 🔥 Streak: ${stats.streak}`
                }, { quoted: msg });
            } else {
                await sock.sendMessage(remoteJid, {
                    text: `❌ *Salah!* ${sender}\n\nJawaban yang benar: *${activeQuiz.correctAnswer}* — ${activeQuiz.correctText}\n\n⭐ Score: ${stats.score}`
                }, { quoted: msg });
            }
        }
        return;
    }

    const [rawCmd, ...args] = messageText.slice(PREFIX.length).split(/\s+/);
    const cmdName = rawCmd.toLowerCase();
    const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedStanza = msg.message.extendedTextMessage?.contextInfo?.stanzaId;

    // Built-in: show group JID
    if (cmdName === 'gid' || cmdName === 'groupid') {
        const isGroup = remoteJid.endsWith('@g.us');
        await sock.sendMessage(remoteJid, {
            text: isGroup
                ? `📋 *Group JID:* \`${remoteJid}\``
                : `📋 *Chat JID:* \`${remoteJid}\`\n\n⚠️ Ini bukan grup — gunakan command ini di dalam grup.`
        }, { quoted: msg });
        logger.info({ chat: remoteJid }, `→ gid`);
        return;
    }

    // Built-in: manual news trigger
    if (cmdName === 'news') {
        const { getNewsBySlot, getSlots, getNewsCandidates } = require('./services/newsService');
        const validSlots = Object.keys(getSlots());
        const requestedSlot = args[0]?.toLowerCase();

        // ── groqtest subcommand ──
        if (requestedSlot === 'groqtest') {
            await handleGroqTest(sock, msg, remoteJid, logger);
            return;
        }

        let slot = 'morning'; // default
        if (requestedSlot && validSlots.includes(requestedSlot)) {
            slot = requestedSlot;
        } else if (requestedSlot) {
            await sock.sendMessage(remoteJid, {
                text: `⚠️ Slot tidak dikenal: "${requestedSlot}"\n\nGunakan: _!news_ atau _!news <slot>_\nSlot tersedia: ${validSlots.join(', ')}`
            }, { quoted: msg });
            return;
        }

        await sock.sendMessage(remoteJid, { text: `⏳ Mencari berita (${slot})...` }, { quoted: msg });
        logger.info({ chat: remoteJid, slot }, `→ news ${slot} (manual)`);
        try {
            const result = await getNewsBySlot(slot, { logger });
            if (!result || !result.messages || result.messages.length === 0) {
                await sock.sendMessage(remoteJid, { text: '❌ Gagal mengambil berita. Coba lagi nanti.' }, { quoted: msg });
                return;
            }
            for (const text of result.messages) {
                await sock.sendMessage(remoteJid, { text, linkPreview: false });
            }
            logger.info(`✅ Manual news (${slot}) sent (${result.messages.length} message(s))`);
        } catch (err) {
            logger.error({ err }, 'Manual news error');
            await sock.sendMessage(remoteJid, { text: '❌ Gagal mengambil berita.' }, { quoted: msg });
        }
        return;
    }

    // ── groqtest handler ──
    async function handleGroqTest(sock, msg, remoteJid, logger) {
        const { editNewsWithGroq } = require('./services/groqNewsEditor');
        const { getNewsCandidates, getSlots } = require('./services/newsService');
        const { formatNewsMessage } = require('./services/newsService');

        // Check if sender is admin/owner
        const OWNER_JID = process.env.OWNER_JID || '';
        const isOwner = OWNER_JID && (remoteJid === OWNER_JID || msg.key.participant === OWNER_JID);
        const isGroup = remoteJid.endsWith('@g.us');
        const isAdmin = isGroup && msg.key.fromMe;

        if (!isOwner && !isAdmin && isGroup) {
            await sock.sendMessage(remoteJid, { text: '⚠️ Command ini hanya untuk admin grup atau owner bot.' }, { quoted: msg });
            return;
        }

        await sock.sendMessage(remoteJid, { text: '🧪 *Groq AI Editor Test*\n\nMengambil kandidat dan menjalankan Groq...' }, { quoted: msg });

        try {
            // 1. Get limited candidates
            const candidates = await getNewsCandidates(logger);
            const limited = candidates.slice(0, 6);

            if (limited.length === 0) {
                await sock.sendMessage(remoteJid, { text: '❌ Tidak ada kandidat berita yang tersedia.' }, { quoted: msg });
                return;
            }

            // 2. Run Groq editor
            const currentDateJakarta = new Date().toLocaleDateString('id-ID', {
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
                timeZone: 'Asia/Jakarta',
            });

            const result = await editNewsWithGroq({
                candidates: limited,
                slot: 'groqtest',
                currentDateJakarta,
                logger,
            });

            // 3. Show results
            const lines = [];
            lines.push('🧪 *GROQ AI EDITOR TEST*');
            lines.push('');
            lines.push(`📊 *Mode:* \`${result.editorMode}\``);
            if (result.keySlot) {
                lines.push(`🔑 *Key:* \`${result.keySlot}\``);
            }
            if (result.usage) {
                lines.push(`📈 *Tokens:* ${result.usage.total_tokens || '?'} (${result.usage.prompt_tokens || '?'} in / ${result.usage.completion_tokens || '?'} out)`);
            }
            lines.push(`📋 *Kandidat:* ${limited.length}`);
            lines.push(`✅ *Terpilih:* ${result.articles.length}`);
            lines.push('');

            if (result.articles.length > 0) {
                lines.push('📝 *HASIL SELEKSI:*');
                lines.push('');
                for (const a of result.articles) {
                    const typeEmoji = a.type === 'world' ? '🌍' : '🇮🇩';
                    lines.push(`${typeEmoji} *${a.displayTitle}*`);
                    lines.push(`   ${a.summary}`);
                    lines.push(`   📰 ${a.source} | ⭐ ${a.importance}/10 | 📂 ${a.category}`);
                    lines.push(`   🔗 ${a.url}`);
                    lines.push('');
                }
            } else {
                lines.push('⚠️ Tidak ada artikel yang terpilih.');
                lines.push('');
            }

            lines.push('_Test selesai — tidak disimpan ke history._');

            await sock.sendMessage(remoteJid, { text: lines.join('\n'), linkPreview: false }, { quoted: msg });
            logger.info({ chat: remoteJid, editorMode: result.editorMode }, 'Groq test complete');
        } catch (err) {
            logger.error({ err }, 'Groq test error');
            await sock.sendMessage(remoteJid, { text: `❌ Groq test gagal: ${err.message?.slice(0, 200) || 'Unknown error'}` }, { quoted: msg });
        }
    }

    // Built-in: manual entertainment trigger (joke/fact/quote)
    if (cmdName === 'joke' || cmdName === 'fact' || cmdName === 'quote') {
        const { getRandomEntertainment, getFallbackEntertainment } = require('./services/entertainmentService');
        logger.info({ chat: remoteJid }, `→ ${cmdName} (manual)`);
        try {
            const type = cmdName === 'quote' ? 'text' : undefined;
            let content = await getRandomEntertainment({
                includeYoMama: process.env.INCLUDE_YO_MAMA === 'true',
                type,
                logger
            });
            if (!content) content = getFallbackEntertainment();
            await sendContent(sock, remoteJid, content, msg);
            logger.info(`✅ Manual ${cmdName} sent`);
        } catch (err) {
            logger.error({ err }, `Manual ${cmdName} error`);
            await sock.sendMessage(remoteJid, { text: '❌ Gagal mengambil konten.' }, { quoted: msg });
        }
        return;
    }

    // Built-in: random dog image
    if (cmdName === 'dog') {
        const { getRandomEntertainment, getFallbackEntertainment } = require('./services/entertainmentService');
        logger.info({ chat: remoteJid }, '→ dog (manual)');
        try {
            let content = await getRandomEntertainment({ type: 'image', logger });
            if (!content) content = getFallbackEntertainment();
            await sendContent(sock, remoteJid, content, msg);
        } catch (err) {
            logger.error({ err }, 'Manual dog error');
            await sock.sendMessage(remoteJid, { text: '❌ Gagal mengambil gambar.' }, { quoted: msg });
        }
        return;
    }

    // Built-in: random cat image
    if (cmdName === 'cat') {
        const { getRandomEntertainment, getFallbackEntertainment } = require('./services/entertainmentService');
        logger.info({ chat: remoteJid }, '→ cat (manual)');
        try {
            let content = await getRandomEntertainment({ type: 'image', logger });
            // Bias toward cats by filtering for cat sources
            if (!content || !content.imageUrl) content = getFallbackEntertainment();
            await sendContent(sock, remoteJid, content, msg);
        } catch (err) {
            logger.error({ err }, 'Manual cat error');
            await sock.sendMessage(remoteJid, { text: '❌ Gagal mengambil gambar.' }, { quoted: msg });
        }
        return;
    }

    // Built-in: trivia quiz
    if (cmdName === 'quiz') {
        const { getTriviaQuestion } = require('./services/quizService');
        logger.info({ chat: remoteJid }, '→ quiz (manual)');
        try {
            await sock.sendMessage(remoteJid, { text: '⏳ Mencari soal trivia...' }, { quoted: msg });
            const quiz = await getTriviaQuestion({ logger });
            if (!quiz) {
                await sock.sendMessage(remoteJid, { text: '❌ Gagal mengambil soal trivia. Coba lagi nanti.' }, { quoted: msg });
                return;
            }

            // Store active quiz state
            activeQuizzes.set(remoteJid, {
                correctAnswer: quiz.correctAnswer,
                correctText: quiz.correctText,
                format: quiz.format || 'multiple',
                timeout: null
            });

            await sock.sendMessage(remoteJid, { text: quiz.text });

            // Auto-reveal answer after 30 seconds
            const timeout = setTimeout(async () => {
                const active = activeQuizzes.get(remoteJid);
                if (active) {
                    activeQuizzes.delete(remoteJid);
                    await sock.sendMessage(remoteJid, {
                        text: `⏰ *Waktu habis!*\n\nJawaban yang benar: *${active.correctAnswer}* — ${active.correctText}`
                    });
                }
            }, 30_000);
            if (timeout.unref) timeout.unref();

            const active = activeQuizzes.get(remoteJid);
            if (active) active.timeout = timeout;
        } catch (err) {
            logger.error({ err }, 'Manual quiz error');
            await sock.sendMessage(remoteJid, { text: '❌ Gagal mengambil soal trivia.' }, { quoted: msg });
        }
        return;
    }

    // Built-in: quiz leaderboard
    if (cmdName === 'leaderboard' || cmdName === 'lb') {
        logger.info({ chat: remoteJid }, '→ leaderboard');
        const board = await getLeaderboard(remoteJid, 10);

        if (board.length === 0) {
            await sock.sendMessage(remoteJid, {
                text: '🏆 *Quiz Leaderboard*\n\nBelum ada skor. Main quiz dulu yuk — ketik *!quiz*!'
            }, { quoted: msg });
            return;
        }

        const lines = ['🏆 *QUIZ LEADERBOARD* 🏆', ''];

        const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
        for (const entry of board) {
            const medal = medals[entry.rank] || `${entry.rank}.`;
            const streak = entry.streak >= 3 ? ` 🔥${entry.streak}` : '';
            lines.push(`${medal} *${entry.name}* — ${entry.score} pts${streak}`);
        }

        await sock.sendMessage(remoteJid, { text: lines.join('\n') }, { quoted: msg });
        return;
    }
    if (cmdName === 'memegen') {
        const { getCustomMeme, getTemplates } = require('./services/memeService');
        const input = args.join(' ');

        // Show templates if no args
        if (!input) {
            const templates = getTemplates();
            await sock.sendMessage(remoteJid, {
                text: `🎭 *Meme Generator*\n\nGunakan: _!memegen <template> | <teks atas> | <teks bawah>_\n\n*Template populer:*\n${templates.slice(0, 12).join(', ')}\n\nContoh: _!memegen doge | such wow | very amaze_\n\nGunakan _random_ untuk template acak.`
            }, { quoted: msg });
            return;
        }

        const parts = input.split('|').map(s => s.trim());
        let template = 'doge';
        let topText = '';
        let bottomText = '';

        if (parts.length === 1) {
            // Only one part — treat as top text with random template
            topText = parts[0];
            template = 'random';
        } else if (parts.length === 2) {
            template = parts[0] || 'random';
            topText = parts[1] || '';
        } else {
            template = parts[0] || 'random';
            topText = parts[1] || '';
            bottomText = parts[2] || '';
        }

        // Validate template
        const validTemplates = getTemplates();
        if (template !== 'random' && !validTemplates.includes(template)) {
            await sock.sendMessage(remoteJid, {
                text: `⚠️ Template "${template}" tidak dikenal.\n\nTemplate tersedia: ${validTemplates.join(', ')}`
            }, { quoted: msg });
            return;
        }

        const meme = getCustomMeme(template, topText, bottomText);
        logger.info({ chat: remoteJid, template }, '→ memegen');

        try {
            await sock.sendMessage(remoteJid, {
                image: { url: meme.imageUrl },
                caption: meme.caption
            }, { quoted: msg });
        } catch (err) {
            logger.error({ err }, 'Memegen send error');
            await sock.sendMessage(remoteJid, {
                text: `❌ Gagal generate meme. Coba template lain.\n🔗 ${meme.imageUrl}`
            }, { quoted: msg });
        }
        return;
    }

    const cmd = commands.get(cmdName);
    if (!cmd) return;

    logger.info({ cmd: cmdName, chat: remoteJid }, `→ ${cmdName}`);

    try {
        await cmd.execute({
            sock, msg, args, cmdName, remoteJid, quotedMsg, quotedStanza,
            session: getSession(remoteJid),
            logger, PREFIX, state
        });
    } catch (err) {
        logger.error({ err, cmd: cmdName }, 'Command error');
        await sock.sendMessage(remoteJid, {
            text: `❌ Error: ${err.message || 'Unknown error'}`
        }, { quoted: msg });
    }
}

module.exports = { handler, commands, getSession };
