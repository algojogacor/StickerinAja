// News delivery scheduler using absolute daily WIB slots.

const { getSock } = require("../core/socket");
const { shouldSuppressCron } = require("../services/birthdayTakeoverService");
const newsService = require("../services/newsService");
const { createWindowedScheduler } = require("./windowedScheduler");

const SCHEDULES = [
  { id: "morning", time: "07:00" },
  { id: "midday", time: "12:00" },
  { id: "evening", time: "17:00" },
  { id: "nightcap", time: "22:00" },
];

let scheduler = null;
let logger = null;
let groupJid = "";
const pendingDeliveries = new Map();

async function sendNewsSlot(slot) {
  const sock = getSock();
  if (!sock) {
    logger?.warn({ slot: slot.key }, "[News Scheduler] WhatsApp unavailable — pending until reconnect");
    return false;
  }

  if (await shouldSuppressCron(groupJid, "news")) {
    pendingDeliveries.delete(slot.key);
    logger?.info({ slot: slot.key }, "[News Scheduler] Birthday takeover — delivery suppressed");
    return true;
  }

  let delivery = pendingDeliveries.get(slot.key);
  if (!delivery) {
    const result = await newsService.getNewsBySlot(slot.id, {
      logger,
      groupJid,
      dateJakarta: slot.date,
    });
    if (!result?.messages?.length) return true;

    delivery = { ...result, nextMessageIndex: 0 };
    pendingDeliveries.set(slot.key, delivery);
  }

  try {
    while (delivery.nextMessageIndex < delivery.messages.length) {
      await sock.sendMessage(groupJid, { text: delivery.messages[delivery.nextMessageIndex] });
      delivery.nextMessageIndex += 1;
    }

    await newsService.confirmNewsSent(delivery.generationKey);
    pendingDeliveries.delete(slot.key);
    logger?.info({ slot: slot.key }, "[News Scheduler] Briefing delivered");
    return true;
  } catch (error) {
    logger?.error({ err: error, slot: slot.key }, "[News Scheduler] Delivery failed — pending until reconnect");
    return false;
  }
}

function start({ logger: log, groupJid: jid } = {}) {
  if (scheduler?.getState().running) {
    log?.warn("[News Scheduler] Already running — skipping");
    return false;
  }
  if (process.env.NEWS_SCHEDULER_ENABLED === "false") {
    log?.info("[News Scheduler] NEWS_SCHEDULER_ENABLED=false — not starting");
    return false;
  }

  logger = log;
  groupJid = jid || process.env.GROUP_JID || "";
  if (!groupJid) {
    logger?.warn("[News Scheduler] No GROUP_JID — not starting");
    return false;
  }

  scheduler = createWindowedScheduler({
    name: "News Scheduler",
    slots: SCHEDULES,
    task: sendNewsSlot,
    logger,
  });
  scheduler.start();
  logger?.info("[News Scheduler] Started at 07:00, 12:00, 17:00, and 22:00 WIB");
  return true;
}

function stop() {
  scheduler?.stop();
  scheduler = null;
  logger?.info("[News Scheduler] Stopped");
}

function resume() {
  return scheduler?.resume() || Promise.resolve(false);
}

function isRunning() {
  return Boolean(scheduler?.getState().running);
}

module.exports = { SCHEDULES, start, stop, resume, isRunning, sendNewsSlot };
