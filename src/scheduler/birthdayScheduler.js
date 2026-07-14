// Birthday Scheduler — takeover timeline runner + midnight checks.
const cron = require('node-cron');
const { getSock } = require('../core/socket');
const bday = require('../services/birthdayService');
const repo = require('../repositories/birthdayRepository');
const fmt = require('../formatters/birthdayMessageFormatter');
const { BIRTHDAY_AUDIO_PATH, BIRTHDAY_CARD_PATH, BIRTHDAY_STICKER_PATH, TAKEOVER_SCHEDULE } = require('../config/birthdayConfig');
const { splitLongMessage } = require('../formatters/footballMessageFormatter');
const fs = require('fs'), path = require('path');

function wibNow() { return new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }); }

class BirthdayScheduler {
    constructor(opts = {}) {
        this.logger = opts.logger; this.groupJid = opts.groupJid;
        this.cronJobs = []; this.takeoverTimers = []; this.running = false;
    }

    start() {
        if (this.running) { this.logger?.warn('Birthday scheduler already running'); return; }
        this.running = true;

        // ── 23:58 — Check tomorrow for birthdays ──
        const preMidnight = cron.schedule('58 23 * * *', () => this.checkTomorrow(), { timezone: 'Asia/Jakarta', name: 'bday-check' });
        this.cronJobs.push(preMidnight);

        // ── 00:02 — Activate takeover if today has birthdays ──
        const postMidnight = cron.schedule('2 0 * * *', () => this.activateToday(), { timezone: 'Asia/Jakarta', name: 'bday-activate' });
        this.cronJobs.push(postMidnight);

        // ── 00:05 — Run takeover events loop ──
        const takeoverLoop = cron.schedule('5 0 * * *', () => this.startTakeoverLoop(), { timezone: 'Asia/Jakarta', name: 'bday-loop' });
        this.cronJobs.push(takeoverLoop);

        // ── Also evaluate on startup (after 5s) ──
        setTimeout(() => { if (this.running) this.activateToday().then(() => this.startTakeoverLoop()); }, 5000);

        this.logger?.info('🎂 Birthday scheduler started');
    }

    stop() {
        this.running = false;
        for (const j of this.cronJobs) j.stop(); this.cronJobs = [];
        for (const t of this.takeoverTimers) clearTimeout(t); this.takeoverTimers = [];
        this.logger?.info('🛑 Birthday scheduler stopped');
    }

    async checkTomorrow() {
        const birthdays = await bday.getTomorrowBirthdays(this.groupJid);
        if (birthdays.length) {
            this.logger?.info({ count: birthdays.length }, '🎂 Tomorrow has birthdays — preparing takeover');
        }
    }

    async activateToday() {
        const sock = getSock();
        if (!sock || !this.groupJid) return;
        const birthdays = await bday.evaluateAndActivate(this.groupJid);
        if (birthdays) {
            this.logger?.info({ count: birthdays.length, names: birthdays.map(p => p.name).join(', ') }, '🎂 Birthday takeover activated!');
        }
    }

    async startTakeoverLoop() {
        const sock = getSock();
        if (!sock || !this.groupJid) return;
        const active = await bday.isTakeoverActive(this.groupJid);
        if (!active) return;

        const persons = await bday.getTakeoverBirthdayPersons(this.groupJid);
        if (!persons.length) return;

        this.logger?.info({ persons: persons.map(p => p.name) }, '🎂 Running birthday takeover events...');

        // Schedule each takeover event
        for (const slot of TAKEOVER_SCHEDULE) {
            const [h, m] = slot.time.split(':').map(Number);
            const delay = this.msUntil(h, m);
            if (delay < 0) continue; // already past

            const timer = setTimeout(() => this.runEvent(slot.event, persons), delay);
            if (timer.unref) timer.unref();
            this.takeoverTimers.push(timer);
            this.logger?.info(`🎂 Takeover event "${slot.event}" scheduled at ${slot.time} WIB (in ${Math.round(delay/60000)}min)`);
        }
    }

    msUntil(hour, minute) {
        const wib = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
        const target = new Date(wib); target.setHours(hour, minute, 0, 0);
        return target.getTime() - Date.now();
    }

    async runEvent(event, persons) {
        const sock = getSock();
        if (!sock || !this.groupJid) return;

        const active = await bday.isTakeoverActive(this.groupJid);
        if (!active) return;

        const alreadySent = await bday.hasSentEvent(this.groupJid, event);
        if (alreadySent) { this.logger?.info(`🎂 Event "${event}" already sent — skip`); return; }

        this.logger?.info(`🎂 Running takeover event: ${event}`);

        try {
            switch (event) {
                case 'grand_opening': {
                    const msg = fmt.formatGrandOpening(persons);
                    await sock.sendMessage(this.groupJid, { text: msg.text, mentions: msg.mentions });
                    // Sticker if available
                    if (BIRTHDAY_STICKER_PATH && fs.existsSync(BIRTHDAY_STICKER_PATH)) {
                        await new Promise(r => setTimeout(r, 2000));
                        const sticker = fs.readFileSync(BIRTHDAY_STICKER_PATH);
                        await sock.sendMessage(this.groupJid, { sticker });
                    }
                    await new Promise(r => setTimeout(r, 2500));
                    const msg2 = fmt.formatGrandOpening(persons);
                    await sock.sendMessage(this.groupJid, { text: msg2.text, mentions: msg2.mentions });
                    break;
                }
                case 'birthday_song': {
                    const msg = fmt.formatBirthdaySong(persons);
                    // Try local audio file first (buffer), then URL fallback
                    const audioPath = BIRTHDAY_AUDIO_PATH && fs.existsSync(BIRTHDAY_AUDIO_PATH) ? BIRTHDAY_AUDIO_PATH : null;
                    if (audioPath) {
                        try {
                            const audioBuffer = fs.readFileSync(audioPath);
                            await sock.sendMessage(this.groupJid, {
                                audio: audioBuffer,
                                mimetype: 'audio/mpeg',
                                ptt: false
                            });
                            await new Promise(r => setTimeout(r, 8000));
                        } catch (audioErr) {
                            this.logger?.warn({ err: audioErr }, 'Failed to send birthday audio');
                        }
                    }
                    await sock.sendMessage(this.groupJid, { text: msg.text, mentions: msg.mentions });
                    break;
                }
                case 'birthday_card': {
                    const msg = fmt.formatBirthdayCard(persons);
                    const cardPath = BIRTHDAY_CARD_PATH && fs.existsSync(BIRTHDAY_CARD_PATH) ? BIRTHDAY_CARD_PATH : null;
                    if (cardPath) {
                        try {
                            const imgBuffer = fs.readFileSync(cardPath);
                            await sock.sendMessage(this.groupJid, { image: imgBuffer, caption: msg.text, mentions: msg.mentions });
                        } catch {
                            await sock.sendMessage(this.groupJid, { text: msg.text, mentions: msg.mentions });
                        }
                    } else {
                        await sock.sendMessage(this.groupJid, { text: msg.text, mentions: msg.mentions });
                    }
                    break;
                }
                case 'open_wishes': {
                    const msg = fmt.formatOpenWishes(persons);
                    const sent = await sock.sendMessage(this.groupJid, { text: msg.text, mentions: msg.mentions });
                    // Store message key for wish collection
                    if (sent?.key) {
                        await repo.setTakeoverState(this.groupJid, bday.getWIBToday().dateStr, {
                            ...(await repo.getTakeoverState(this.groupJid, bday.getWIBToday().dateStr) || {}),
                            wishMessageId: sent.key.id
                        });
                    }
                    break;
                }
                case 'birthday_spotlight': {
                    const msg = fmt.formatBirthdaySpotlight(persons);
                    await sock.sendMessage(this.groupJid, { text: msg.text, mentions: msg.mentions });
                    break;
                }
                case 'crowd_reminder': {
                    const msg = fmt.formatCrowdReminder(persons);
                    await sock.sendMessage(this.groupJid, { text: msg.text, mentions: msg.mentions });
                    break;
                }
                case 'birthday_recap': {
                    const takeover = await repo.getTakeoverState(this.groupJid, bday.getWIBToday().dateStr);
                    const eventId = takeover?.wishMessageId || 'unknown';
                    const wishes = await repo.getWishes(this.groupJid, eventId);
                    const reactions = await repo.getWishReactions(this.groupJid, eventId);
                    const msg = fmt.formatBirthdayRecap(persons, wishes, reactions);
                    const chunks = splitLongMessage(msg.text, 3500);
                    for (const chunk of chunks) {
                        await sock.sendMessage(this.groupJid, { text: chunk, mentions: msg.mentions });
                    }
                    break;
                }
                case 'closing': {
                    const msg = fmt.formatClosing(persons);
                    await sock.sendMessage(this.groupJid, { text: msg.text, mentions: msg.mentions });
                    // Mark celebrated
                    const year = bday.getWIBToday().year;
                    for (const p of persons) {
                        await bday.markCelebrated(this.groupJid, p.participantId, year);
                    }
                    break;
                }
            }
            await bday.addSentEvent(this.groupJid, event);
            this.logger?.info(`✅ Birthday event "${event}" sent`);
        } catch (err) {
            this.logger?.error({ err, event }, `Birthday event "${event}" failed`);
        }
    }
}

module.exports = { BirthdayScheduler };
