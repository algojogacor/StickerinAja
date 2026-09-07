const fs = require("fs");
const { getBotSock } = require("../core/socket");
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

async function getTargetGroups() {
  const config = getConfig();
  const explicitTarget = config.BIRTHDAY_TARGET_JID || (groupJid && groupJid !== process.env.GROUP_JID ? groupJid : null);
  if (explicitTarget) {
    return [explicitTarget];
  }

  let birthdayGroups = [];
  try {
    if (typeof birthday.getTodayBirthdayGroups === "function") {
      birthdayGroups = await birthday.getTodayBirthdayGroups();
    }
  } catch (err) {
    logger?.warn({ err }, "[Birthday] Failed to fetch active birthday groups");
  }

  if (birthdayGroups.length > 0) {
    return [...new Set(birthdayGroups.filter(Boolean))];
  }

  const defaultJid = groupJid || process.env.GROUP_JID || "";
  return defaultJid ? [defaultJid] : [];
}

async function resolveMentionsForGroup(sock, targetJid, persons) {
  const baseMentions = persons.map((p) => p.participantId).filter(Boolean);
  if (!targetJid?.endsWith("@g.us") || typeof sock?.groupMetadata !== "function") {
    return baseMentions;
  }
  try {
    const metadata = await sock.groupMetadata(targetJid);
    const enriched = [...baseMentions];
    for (const person of persons) {
      const target = (person.participantId || "").replace(/:\d+(?=@)/, "");
      const match = (metadata?.participants || []).find((part) => {
        const pid = (part?.id || "").replace(/:\d+(?=@)/, "");
        const pjid = (part?.jid || "").replace(/:\d+(?=@)/, "");
        const plid = (part?.lid || "").replace(/:\d+(?=@)/, "");
        return pid === target || pjid === target || plid === target;
      });
      if (match) {
        if (match.id) enriched.push(match.id.replace(/:\d+(?=@)/, ""));
        if (match.jid) enriched.push(match.jid.replace(/:\d+(?=@)/, ""));
        if (match.lid) enriched.push(match.lid.replace(/:\d+(?=@)/, ""));
      }
    }
    return [...new Set(enriched.filter(Boolean))];
  } catch {
    return baseMentions;
  }
}

async function runEventForGroup(event, targetJid, personsOverride) {
  if (!event || !targetJid) return false;
  const config = getConfig();
  if (config.BIRTHDAY_TARGET_JID && targetJid !== config.BIRTHDAY_TARGET_JID) {
    logger?.info({ event, targetJid, allowed: config.BIRTHDAY_TARGET_JID }, "[Birthday] Skipping group - does not match BIRTHDAY_TARGET_JID");
    return false;
  }
  try {
    await birthday.evaluateAndActivate(targetJid);
    if (!await birthday.isTakeoverActive(targetJid)) return true;
    if (await birthday.hasSentEvent(targetJid, event)) return true;

    const persons = personsOverride || await birthday.getTakeoverBirthdayPersons(targetJid);
    if (!persons.length) return true;
    const sock = getBotSock();
    if (!sock) {
      logger?.warn({ event, targetJid }, "[Birthday] Bot session unavailable — skipping event to isolate personal session");
      return false;
    }

    const groupMentions = await resolveMentionsForGroup(sock, targetJid, persons);

    let sentMessage = null;
    if (event === "opening") {
      const msg = formatter.formatOpening(persons);
      msg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, msg);
      const sticker = assetBuffer("BIRTHDAY_STICKER_PATH");
      if (sticker) await sock.sendMessage(targetJid, { sticker });
    } else if (event === "song") {
      // If opening was missed earlier today (e.g. birthday added after 07:00), send opening first
      if (!await birthday.hasSentEvent(targetJid, "opening")) {
        const openingMsg = formatter.formatOpening(persons);
        openingMsg.mentions = groupMentions;
        await sock.sendMessage(targetJid, openingMsg);
        const sticker = assetBuffer("BIRTHDAY_STICKER_PATH");
        if (sticker) await sock.sendMessage(targetJid, { sticker });
        await birthday.addSentEvent(targetJid, "opening");
      }
      const audio = assetBuffer("BIRTHDAY_AUDIO_PATH");
      if (audio) {
        await sock.sendMessage(targetJid, { audio, mimetype: "audio/mpeg", ptt: false });
      }
      const songMsg = formatter.formatSong(persons);
      songMsg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, songMsg);
    } else if (event === "card") {
      const card = assetBuffer("BIRTHDAY_CARD_PATH");
      const message = formatter.formatCard(persons);
      sentMessage = card
        ? await sock.sendMessage(targetJid, { image: card, caption: message.text, mentions: groupMentions })
        : await sock.sendMessage(targetJid, { text: message.text, mentions: groupMentions });
    } else if (event === "spotlight") {
      const msg = formatter.formatSpotlight(persons);
      msg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, msg);
    } else if (event === "reminder") {
      const msg = formatter.formatReminder(persons);
      msg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, msg);
    } else if (event === "recap") {
      const wishMessageId = await birthday.getWishMessageId(targetJid);
      const wishes = wishMessageId ? await birthday.getWishes(targetJid, wishMessageId) : [];
      const msg = formatter.formatRecap(persons, wishes);
      msg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, msg);
    } else if (event === "closing") {
      const msg = formatter.formatClosing(persons);
      msg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, msg);
      const year = birthday.getWIBToday().year;
      for (const person of persons) await birthday.markCelebrated(targetJid, person.participantId, year);
    }

    if (event === "card" && sentMessage?.key?.id) {
      // Card is the public message that wishes should reply to.
      await birthday.setWishMessageId(targetJid, sentMessage.key.id);
    }
    await birthday.addSentEvent(targetJid, event);
    if (event === "closing") await birthday.deactivateTakeover(targetJid);
    logger?.info({ event, targetJid }, "[Birthday] Event delivered");
    return true;
  } catch (error) {
    logger?.error({ err: error, event, targetJid }, "[Birthday] Event failed for group");
    return false;
  }
}

async function runEvent(eventOrSlot, personsOverride) {
  const event = typeof eventOrSlot === "string" ? eventOrSlot : eventOrSlot?.id;
  if (!event) return false;
  if (runningEvents.has(event)) return false;
  runningEvents.add(event);

  try {
    const targetGroups = await getTargetGroups();
    for (const targetJid of targetGroups) {
      await runEventForGroup(event, targetJid, personsOverride);
    }
    return true;
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
  groupJid = jid || config.BIRTHDAY_TARGET_JID || process.env.GROUP_JID || "";
  if (!groupJid) {
    logger?.warn("[Birthday] No GROUP_JID or BIRTHDAY_TARGET_JID; scheduler not started");
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

module.exports = { EVENT_SCHEDULES, start, stop, resume, isRunning, runEvent, runEventForGroup, getTargetGroups };
