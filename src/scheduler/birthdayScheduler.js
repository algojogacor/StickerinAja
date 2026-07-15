const fs = require("fs");
const { getSock } = require("../core/socket");
const { createWindowedScheduler } = require("./windowedScheduler");
const repository = require("../repositories/birthdayRepository");
const birthday = require("../services/birthdayService");
const formatter = require("../formatters/birthdayMessageFormatter");
const { getConfig, EVENT_SCHEDULES } = require("../config/birthdayConfig");

let scheduler = null;
let logger = null;
let groupJid = "";
const runningEvents = new Set();

function assetBuffer(configKey) {
  const filePath = getConfig()[configKey];
  if (!filePath || !fs.existsSync(filePath)) return null;
  try { return fs.readFileSync(filePath); } catch { return null; }
}

async function runEvent(eventOrSlot, personsOverride) {
  const event = typeof eventOrSlot === "string" ? eventOrSlot : eventOrSlot?.id;
  if (!event || !groupJid) return false;
  if (runningEvents.has(event)) return false;
  runningEvents.add(event);

  try {
    await birthday.evaluateAndActivate(groupJid);
    if (!await birthday.isTakeoverActive(groupJid)) return true;
    if (await birthday.hasSentEvent(groupJid, event)) return true;

    const persons = personsOverride || await birthday.getTakeoverBirthdayPersons(groupJid);
    if (!persons.length) return true;
    const sock = getSock();
    if (!sock) {
      logger?.warn({ event }, "[Birthday] WhatsApp unavailable; event remains retryable");
      return false;
    }

    let sentMessage = null;
    const config = getConfig();
    if (event === "opening") {
      sentMessage = await sock.sendMessage(groupJid, formatter.formatOpening(persons));
      const sticker = assetBuffer("BIRTHDAY_STICKER_PATH");
      if (sticker) await sock.sendMessage(groupJid, { sticker });
    } else if (event === "song") {
      const audio = assetBuffer("BIRTHDAY_AUDIO_PATH");
      if (audio) {
        await sock.sendMessage(groupJid, { audio, mimetype: "audio/mpeg", ptt: false });
      }
      sentMessage = await sock.sendMessage(groupJid, formatter.formatSong(persons));
    } else if (event === "card") {
      const card = assetBuffer("BIRTHDAY_CARD_PATH");
      const message = formatter.formatCard(persons);
      sentMessage = card
        ? await sock.sendMessage(groupJid, { image: card, caption: message.text, mentions: message.mentions })
        : await sock.sendMessage(groupJid, message);
    } else if (event === "spotlight") {
      sentMessage = await sock.sendMessage(groupJid, formatter.formatSpotlight(persons));
    } else if (event === "reminder") {
      sentMessage = await sock.sendMessage(groupJid, formatter.formatReminder(persons));
    } else if (event === "recap") {
      const wishMessageId = await birthday.getWishMessageId(groupJid);
      const wishes = wishMessageId ? await birthday.getWishes(groupJid, wishMessageId) : [];
      sentMessage = await sock.sendMessage(groupJid, formatter.formatRecap(persons, wishes));
    } else if (event === "closing") {
      sentMessage = await sock.sendMessage(groupJid, formatter.formatClosing(persons));
      const year = birthday.getWIBToday().year;
      for (const person of persons) await birthday.markCelebrated(groupJid, person.participantId, year);
    }

    if (event === "card" && sentMessage?.key?.id) {
      // Card is the public message that wishes should reply to.
      await birthday.setWishMessageId(groupJid, sentMessage.key.id);
    }
    await birthday.addSentEvent(groupJid, event);
    if (event === "closing") await birthday.deactivateTakeover(groupJid);
    logger?.info({ event }, "[Birthday] Event delivered");
    return true;
  } catch (error) {
    logger?.error({ err: error, event }, "[Birthday] Event failed; will retry");
    return false;
  } finally {
    runningEvents.delete(event);
  }
}

function start({ logger: log, groupJid: jid } = {}) {
  if (scheduler?.getState().running) return false;
  const config = getConfig();
  if (!config.BIRTHDAY_FEATURE_ENABLED || !config.BIRTHDAY_TAKEOVER_ENABLED) {
    log?.info("[Birthday] Feature disabled; scheduler not started");
    return false;
  }
  logger = log;
  groupJid = jid || process.env.GROUP_JID || "";
  if (!groupJid) {
    logger?.warn("[Birthday] No GROUP_JID; scheduler not started");
    return false;
  }
  scheduler = createWindowedScheduler({
    name: "Birthday Scheduler",
    slots: EVENT_SCHEDULES,
    task: (slot) => runEvent(slot.id),
    logger,
  });
  scheduler.start();
  logger?.info({ slots: EVENT_SCHEDULES.map((slot) => slot.time) }, "[Birthday] Scheduler started");
  return true;
}

function stop() {
  scheduler?.stop();
  scheduler = null;
  runningEvents.clear();
  logger?.info("[Birthday] Scheduler stopped");
}

function resume() {
  return scheduler?.resume() || Promise.resolve(false);
}

function isRunning() {
  return Boolean(scheduler?.getState().running);
}

module.exports = { EVENT_SCHEDULES, start, stop, resume, isRunning, runEvent };
