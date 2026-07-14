// Group scheduler — orchestrates news slots, entertainment, auto-meme, and auto-quiz.
// Designed to start/stop cleanly on Baileys connect/disconnect cycles.

const cron = require('node-cron');
const { getSock } = require('../core/socket');
const { getNewsBySlot, getSlots, confirmNewsSent } = require('../services/newsService');
const { getRandomEntertainment, getFallbackEntertainment } = require('../services/entertainmentService');
const { getRandomMeme } = require('../services/memeService');
const { getTriviaQuestion } = require('../services/quizService');
const { activeQuizzes } = require('../utils/quizState');
const { shouldSuppressCron } = require('../services/birthdayTakeoverService');
const { isCronSenderEnabled } = require('../commands/reddit');

// Lazy-loaded Reddit sticker service (avoids circular dependency)
let _redditStickerService = null;
function getRedditStickerService() {
    if (!_redditStickerService) {
        _redditStickerService = require('../services/redditStickerService');
    }
    return _redditStickerService;
}

/** Guard — skip cron if birthday takeover is active for this group. */
async function skipIfBirthday(jobName) {
    const gid = process.env.GROUP_JID || '';
    if (await shouldSuppressCron(gid, jobName)) return true;
    return false;
}

// ── Helpers ──────────────────────────────────────────────

function randomDelayToNext({ startHour, endHour }) {
    const now = new Date();
    const wibNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const currentMinutes = wibNow.getHours() * 60 + wibNow.getMinutes();
    const startMinutes = startHour * 60;
    const endMinutes = endHour * 60;
    const windowMinutes = endMinutes - startMinutes;
    let targetMinutes;

    if (currentMinutes < startMinutes) {
        targetMinutes = startMinutes + Math.floor(Math.random() * windowMinutes);
    } else if (currentMinutes >= startMinutes && currentMinutes < endMinutes - 10) {
        const minTarget = currentMinutes + 10;
        if (minTarget >= endMinutes) {
            targetMinutes = startMinutes + Math.floor(Math.random() * windowMinutes) + 24 * 60;
        } else {
            targetMinutes = minTarget + Math.floor(Math.random() * (endMinutes - minTarget));
        }
    } else {
        targetMinutes = startMinutes + Math.floor(Math.random() * windowMinutes) + 24 * 60;
    }

    const targetMs = targetMinutes * 60 * 1000;
    const wibMidnight = new Date(wibNow);
    wibMidnight.setHours(0, 0, 0, 0);
    const currentMs = wibNow.getTime() - wibMidnight.getTime();
    let delayMs = targetMs - currentMs;
    if (delayMs < 60_000) delayMs = 60_000;
    return delayMs;
}

function wibNow() {
    return new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
}

/** Send content — handles both text and image types. */
async function sendContent(sock, jid, content) {
    if (!content) return;
    if (content.type === 'image' && content.imageUrl) {
        await sock.sendMessage(jid, { image: { url: content.imageUrl }, caption: content.caption || '' });
    } else if (content.text) {
        await sock.sendMessage(jid, { text: content.text });
    }
}

// ── Scheduler Class ──────────────────────────────────────

class GroupScheduler {
    constructor(opts = {}) {
        this.logger = opts.logger;
        this.groupJid = opts.groupJid;
        this.entertainmentCount = opts.entertainmentCount || 8;
        this.startHour = opts.startHour || 8;
        this.endHour = opts.endHour || 22;
        this.includeYoMama = opts.includeYoMama || false;

        // Timers & cron jobs
        this.newsCronJobs = [];
        this.memeCronJobs = [];
        this.quizCronJob = null;
        this.entertainmentTimer = null;
        this.bootTimer = null;
        this.memeTimer = null;
        this.quizTimer = null;
        this.redditGenCronJob = null;
        this.redditSendCronJobs = [];
        this.redditGenRanToday = false;
        this.redditGenDay = -1;

        // State
        this.entertainmentSentToday = 0;
        this.entertainmentDay = -1;
        this.memeSentToday = 0;
        this.memeDay = -1;
        this.quizSentToday = false;
        this.quizDay = -1;
        this.running = false;
        this.bootMessageSent = false;
    }

    // ── Lifecycle ──────────────────────────────────────

    start() {
        if (this.running) {
            this.logger?.warn('Scheduler already running — skipping duplicate start');
            return;
        }

        this.running = true;
        this.bootMessageSent = false;
        this.logger?.info('🕒 Starting group schedulers...');

        // Boot message: 60s delay for server stabilization
        this.scheduleBootMessage();

        // 4 daily news slots
        this.startNewsCron();

        // Auto-meme: 2x/day
        this.startMemeCron();

        // Auto-quiz: 1x/day
        this.startQuizCron();

        // Reddit sticker bank: generator + sender cron
        this.startRedditCron();

        // Random entertainment: N times between startHour–endHour
        this.resetCounters();
        this.scheduleNextEntertainment();

        this.logger?.info({
            group: this.groupJid,
            entertainmentCount: this.entertainmentCount,
            window: `${this.startHour}:00–${this.endHour}:00 WIB`
        }, '✅ Group schedulers started');
    }

    stop() {
        this.running = false;

        for (const { job } of this.newsCronJobs) job.stop();
        this.newsCronJobs = [];
        for (const { job } of this.memeCronJobs) job.stop();
        this.memeCronJobs = [];
        if (this.quizCronJob) { this.quizCronJob.stop(); this.quizCronJob = null; }

        if (this.entertainmentTimer) { clearTimeout(this.entertainmentTimer); this.entertainmentTimer = null; }
        if (this.bootTimer) { clearTimeout(this.bootTimer); this.bootTimer = null; }
        if (this.memeTimer) { clearTimeout(this.memeTimer); this.memeTimer = null; }
        if (this.quizTimer) { clearTimeout(this.quizTimer); this.quizTimer = null; }
        if (this.redditGenCronJob) { this.redditGenCronJob.stop(); this.redditGenCronJob = null; }
        for (const { job } of this.redditSendCronJobs) job.stop();
        this.redditSendCronJobs = [];

        this.logger?.info('🛑 Group schedulers stopped');
    }

    // ── News ───────────────────────────────────────────

    startNewsCron() {
        for (const { job } of this.newsCronJobs) job.stop();
        this.newsCronJobs = [];

        const slots = getSlots();
        for (const [slot, def] of Object.entries(slots)) {
            const job = cron.schedule(def.cron, () => this.sendNews(slot), {
                timezone: 'Asia/Jakarta', name: `${slot}-news`
            });
            this.newsCronJobs.push({ slot, job });
            this.logger?.info(`📰 ${def.emoji} ${def.title} scheduled: daily at ${def.cron} WIB`);
        }
    }

    async sendNews(slot) {
        if (await skipIfBirthday(`news-${slot}`)) { this.logger?.info(`🎂 Birthday takeover — skipping news ${slot}`); return; }
        const sock = getSock();
        if (!sock) { this.retryNews(slot); return; }
        if (!this.groupJid) return;

        this.logger?.info(`📰 [${slot}] Preparing news...`);
        try {
            const result = await getNewsBySlot(slot, {
                logger: this.logger,
                groupJid: this.groupJid,
            });

            if (!result || !result.messages || result.messages.length === 0) {
                this.logger?.info(`📰 [${slot}] No news to send`);
                return;
            }

            for (const text of result.messages) {
                await sock.sendMessage(this.groupJid, { text, linkPreview: false });
            }

            if (result.generationKey) {
                confirmNewsSent(result.generationKey);
            }

            this.logger?.info(`✅ [${slot}] News sent (${result.messages.length} message(s))`);
        } catch (err) {
            this.logger?.error({ err }, `[${slot}] News failed — retrying in 60s`);
            setTimeout(async () => {
                const s = getSock();
                if (!s) return;
                const result = await getNewsBySlot(slot, {
                    logger: this.logger,
                    groupJid: this.groupJid,
                });
                if (result && result.messages && result.messages.length > 0) {
                    for (const t of result.messages) {
                        await s.sendMessage(this.groupJid, { text: t, linkPreview: false });
                    }
                    if (result.generationKey) {
                        confirmNewsSent(result.generationKey);
                    }
                }
            }, 60_000);
        }
    }

    retryNews(slot) {
        setTimeout(() => { const s = getSock(); if (s) this.sendNews(slot); }, 2 * 60_000);
    }

    // ── Meme Cron ──────────────────────────────────────

    startMemeCron() {
        for (const { job } of this.memeCronJobs) job.stop();
        this.memeCronJobs = [];

        // 2x daily at pseudo-random times: ~10:30 and ~18:30 WIB with ±30min jitter
        const schedules = ['30 10 * * *', '30 18 * * *'];
        for (const s of schedules) {
            const job = cron.schedule(s, () => this.sendAutoMeme(), {
                timezone: 'Asia/Jakarta', name: `meme-${s.replace(/[^0-9]/g, '')}`
            });
            this.memeCronJobs.push({ job });
        }
        this.logger?.info('🎭 Auto-meme scheduled: 2x daily (~10:30 & ~18:30 WIB)');
    }

    async sendAutoMeme() {
        if (await skipIfBirthday('auto-meme')) { this.logger?.info('🎂 Birthday takeover — skipping auto-meme'); return; }
        const sock = getSock();
        if (!sock) return;

        this.logger?.info('🎭 Generating auto-meme...');
        try {
            const meme = await getRandomMeme({ logger: this.logger });
            if (meme) {
                await sendContent(sock, this.groupJid, meme);
                this.memeSentToday++;
                this.logger?.info(`✅ Auto-meme sent (#${this.memeSentToday})`);
            }
        } catch (err) {
            this.logger?.error({ err }, 'Auto-meme failed');
        }
    }

    // ── Quiz Cron ──────────────────────────────────────

    startQuizCron() {
        if (this.quizCronJob) this.quizCronJob.stop();
        // Once daily at ~14:00 WIB
        this.quizCronJob = cron.schedule('0 14 * * *', () => this.sendAutoQuiz(), {
            timezone: 'Asia/Jakarta', name: 'auto-quiz'
        });
        this.logger?.info('🧠 Auto-quiz scheduled: daily at 14:00 WIB');
    }

    async sendAutoQuiz() {
        if (await skipIfBirthday('auto-quiz')) { this.logger?.info('🎂 Birthday takeover — skipping auto-quiz'); return; }
        const sock = getSock();
        if (!sock) return;

        this.logger?.info('🧠 Preparing auto-quiz...');
        try {
            const quiz = await getTriviaQuestion({ logger: this.logger });
            if (!quiz) {
                this.logger?.warn('Auto-quiz: all sources exhausted — skipped');
                return;
            }

            activeQuizzes.set(this.groupJid, {
                correctAnswer: quiz.correctAnswer,
                correctText: quiz.correctText,
                format: quiz.format || 'multiple',
                timeout: null
            });

            await sock.sendMessage(this.groupJid, { text: quiz.text });

            // Auto-reveal after 30 seconds
            const timeout = setTimeout(async () => {
                const active = activeQuizzes.get(this.groupJid);
                if (active) {
                    activeQuizzes.delete(this.groupJid);
                    await sock.sendMessage(this.groupJid, {
                        text: `⏰ *Waktu habis!*\n\nJawaban: *${active.correctAnswer}* — ${active.correctText}`
                    });
                }
            }, 30_000);
            if (timeout.unref) timeout.unref();

            const active = activeQuizzes.get(this.groupJid);
            if (active) active.timeout = timeout;

            this.logger?.info('✅ Auto-quiz sent');
        } catch (err) {
            this.logger?.error({ err }, 'Auto-quiz failed');
        }
    }

    // ── Entertainment ──────────────────────────────────

    resetCounters() {
        const now = new Date();
        const wibNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
        const today = wibNow.getDate();
        if (this.entertainmentDay !== today) {
            this.entertainmentDay = today;
            this.entertainmentSentToday = 0;
        }
        if (this.memeDay !== today) {
            this.memeDay = today;
            this.memeSentToday = 0;
        }
        if (this.quizDay !== today) {
            this.quizDay = today;
            this.quizSentToday = false;
        }
    }

    scheduleNextEntertainment() {
        if (!this.running) return;
        if (this.entertainmentTimer) clearTimeout(this.entertainmentTimer);

        this.resetCounters();

        if (this.entertainmentSentToday >= this.entertainmentCount) {
            this.logger?.info(`Entertainment quota reached (${this.entertainmentSentToday}/${this.entertainmentCount})`);
            this.entertainmentDay = -1;
            const delay = randomDelayToNext({ startHour: this.startHour, endHour: this.endHour });
            this.entertainmentTimer = setTimeout(() => this.sendEntertainment(), delay);
            if (this.entertainmentTimer.unref) this.entertainmentTimer.unref();
            return;
        }

        const delayMs = randomDelayToNext({ startHour: this.startHour, endHour: this.endHour });
        const wibTime = new Date(Date.now() + delayMs).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        this.logger?.info(`Next entertainment: ${wibTime} WIB (${Math.round(delayMs / 60000)} min)`);

        this.entertainmentTimer = setTimeout(() => this.sendEntertainment(), delayMs);
        if (this.entertainmentTimer.unref) this.entertainmentTimer.unref();
    }

    async sendEntertainment() {
        if (!this.running) return;
        if (await skipIfBirthday('entertainment')) { this.logger?.info('🎂 Birthday takeover — skipping entertainment'); this.scheduleNextEntertainment(); return; }

        const sock = getSock();
        if (!sock) {
            this.entertainmentTimer = setTimeout(() => this.sendEntertainment(), 5 * 60_000);
            if (this.entertainmentTimer.unref) this.entertainmentTimer.unref();
            return;
        }

        if (!this.groupJid) { this.scheduleNextEntertainment(); return; }

        this.resetCounters();
        this.logger?.info('🎭 Fetching entertainment...');

        try {
            let content = await getRandomEntertainment({
                includeYoMama: this.includeYoMama,
                logger: this.logger
            });
            if (!content) { content = getFallbackEntertainment(); }

            await sendContent(sock, this.groupJid, content);
            this.entertainmentSentToday++;
            this.logger?.info({
                label: content.label,
                type: content.type || 'text',
                count: `${this.entertainmentSentToday}/${this.entertainmentCount}`,
                time: wibNow()
            }, `✅ Entertainment sent`);
        } catch (err) {
            this.logger?.error({ err }, 'Failed to send entertainment');
        }

        this.scheduleNextEntertainment();
    }

    // ── Boot Message ──────────────────────────────────

    scheduleBootMessage() {
        if (this.bootTimer) clearTimeout(this.bootTimer);
        this.bootTimer = setTimeout(() => this.sendBootMessage(), 60_000);
        if (this.bootTimer.unref) this.bootTimer.unref();
        this.logger?.info(`🚀 Boot message: ${wibNow()} WIB (60s from now)`);
    }

    async sendBootMessage() {
        if (!this.running || this.bootMessageSent) return;
        if (await skipIfBirthday('boot-message')) { this.logger?.info('🎂 Birthday takeover — skipping boot message'); return; }

        const sock = getSock();
        if (!sock) {
            this.bootTimer = setTimeout(() => this.sendBootMessage(), 30_000);
            if (this.bootTimer.unref) this.bootTimer.unref();
            return;
        }
        if (!this.groupJid) return;

        this.bootMessageSent = true;
        try {
            let content = await getRandomEntertainment({
                includeYoMama: this.includeYoMama,
                logger: this.logger
            });
            if (!content) content = getFallbackEntertainment();
            await sendContent(sock, this.groupJid, content);
            this.logger?.info('✅ Boot message sent');
        } catch (err) {
            this.logger?.error({ err }, 'Boot message failed');
        }
    }

    // ── Reddit Sticker Bank ─────────────────────────────

    startRedditCron() {
        if (process.env.REDDIT_STICKER_ENABLED === 'false') {
            this.logger?.info('🎭 Reddit Sticker Bank disabled — skipping cron');
            return;
        }

        // Generator: once daily in early morning (5:00 AM WIB)
        // Recommends dini hari so stickers are ready before active hours
        if (this.redditGenCronJob) this.redditGenCronJob.stop();
        this.redditGenCronJob = cron.schedule('0 5 * * *', () => this.runRedditGenerator(), {
            timezone: 'Asia/Jakarta', name: 'reddit-sticker-gen'
        });
        this.logger?.info('🎭 Reddit sticker generator scheduled: daily at 05:00 WIB');

        // Sender: 2x daily during active hours (~10:00 and ~18:00 WIB)
        for (const { job } of this.redditSendCronJobs) job.stop();
        this.redditSendCronJobs = [];
        const sendSchedules = ['0 10 * * *', '0 18 * * *'];
        for (const s of sendSchedules) {
            const job = cron.schedule(s, () => this.sendRedditSticker(), {
                timezone: 'Asia/Jakarta', name: `reddit-sticker-send-${s.replace(/[^0-9]/g, '')}`
            });
            this.redditSendCronJobs.push({ job });
        }
        this.logger?.info('🎭 Reddit sticker sender scheduled: 2x daily (~10:00 & ~18:00 WIB)');
    }

    async runRedditGenerator() {
        const now = new Date();
        const wib = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
        const today = wib.getDate();
        const dateStr = wib.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });

        // Idempotency: only run once per day
        if (this.redditGenDay === today && this.redditGenRanToday) {
            this.logger?.info('🎭 Reddit generator already ran today — skipping');
            return;
        }

        this.logger?.info('🎭 Running Reddit sticker generator...');
        try {
            const svc = getRedditStickerService();
            const result = await svc.generateStickers({ logger: this.logger });
            this.redditGenRanToday = true;
            this.redditGenDay = today;
            this.logger?.info(result, `🎭 Reddit generator complete: ${result.generated} stickers`);
        } catch (err) {
            this.logger?.error({ err }, '🎭 Reddit generator failed');
        }
    }

    async sendRedditSticker() {
        // Check birthday takeover suppression
        if (await skipIfBirthday('reddit-sticker')) {
            this.logger?.info('🎂 Birthday takeover — skipping reddit sticker send');
            return;
        }

        // Check cron sender toggle
        if (!isCronSenderEnabled()) {
            this.logger?.info('🎭 Reddit cron sender is OFF — skipping');
            return;
        }

        const sock = getSock();
        if (!sock) return;
        if (!this.groupJid) return;

        this.logger?.info('🎭 Sending Reddit sticker from bank...');
        try {
            const svc = getRedditStickerService();
            const result = await svc.sendOneSticker(sock, this.groupJid, { logger: this.logger });
            if (result.sent > 0) {
                this.logger?.info(`🎭 Reddit sticker sent (${result.sent})`);
            }
        } catch (err) {
            this.logger?.error({ err }, '🎭 Reddit sticker send failed');
        }
    }
}

module.exports = { GroupScheduler };
