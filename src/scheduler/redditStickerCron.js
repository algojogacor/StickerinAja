// Reddit Sticker scheduler. The filename remains for command compatibility.

const { getSock } = require("../core/socket");
const { shouldSuppressCron } = require("../services/birthdayTakeoverService");
const { createWindowedScheduler } = require("./windowedScheduler");
const { generateStickers, sendOneSticker } = require("../services/redditStickerService");

const DEFAULT_GENERATOR_TIMES = ["07:00", "10:00", "13:00", "16:00", "19:00"];
const DEFAULT_SENDER_TIMES = [
  "08:00", "09:33", "11:07", "12:40", "14:13",
  "15:47", "17:20", "18:53", "20:27", "22:00",
];

function is24HoursActive() {
  return process.env.SCHEDULER_ALLOW_24_HOURS === "true" || process.env.SCHEDULER_24_HOURS === "true";
}

function parseScheduleTimes(value) {
  const is24h = is24HoursActive();
  return String(value || "")
    .split(/[\s,]+/)
    .map((time) => time.trim())
    .filter(Boolean)
    .filter((time) => {
      const match = /^(\d{2}):(\d{2})$/.exec(time);
      if (!match) return false;
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      const minHour = is24h ? 0 : 7;
      const maxHour = is24h ? 23 : 22;
      return hour >= minHour && hour <= maxHour && minute >= 0 && minute <= 59;
    });
}

function formatScheduleMinute(totalMinutes) {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function distributeScheduleTimes(count, startMinutes = 8 * 60, endMinutes = 22 * 60) {
  const safeCount = Math.max(1, Math.min(144, Number.parseInt(count, 10) || 1));
  if (safeCount === 1) return [formatScheduleMinute(endMinutes)];
  const is24h = is24HoursActive();
  if (is24h && (endMinutes - startMinutes >= 23 * 60)) {
    const step = 1440 / safeCount;
    return Array.from({ length: safeCount }, (_, index) =>
      formatScheduleMinute(Math.floor((step * index) % 1440))
    );
  }
  const step = (endMinutes - startMinutes) / (safeCount - 1);
  return Array.from({ length: safeCount }, (_, index) =>
    formatScheduleMinute(Math.round(startMinutes + step * index))
  );
}

function buildSchedules(prefix, {
  timesEnv,
  countEnv,
  fallbackTimes,
  startMinutes = 8 * 60,
  endMinutes = 22 * 60,
} = {}) {
  const explicit = parseScheduleTimes(process.env[timesEnv]);
  const times = explicit.length > 0
    ? [...new Set(explicit)].sort()
    : process.env[countEnv] !== undefined
      ? distributeScheduleTimes(process.env[countEnv], startMinutes, endMinutes)
      : fallbackTimes;

  return times.map((time, index) => ({
    id: `${prefix}-${String(index + 1).padStart(2, "0")}`,
    time,
  }));
}

function getConfiguredGeneratorSchedules() {
  const is24h = is24HoursActive();
  return buildSchedules("generate", {
    timesEnv: "REDDIT_STICKER_GENERATE_TIMES",
    countEnv: "REDDIT_STICKER_GENERATIONS_PER_DAY",
    fallbackTimes: is24h ? ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00"] : DEFAULT_GENERATOR_TIMES,
    startMinutes: is24h ? 0 : 7 * 60,
    endMinutes: is24h ? 20 * 60 : 21 * 60,
  });
}

function getConfiguredSenderSchedules() {
  const is24h = is24HoursActive();
  return buildSchedules("send", {
    timesEnv: "REDDIT_STICKER_SEND_TIMES",
    countEnv: "REDDIT_STICKER_SENDS_PER_DAY",
    fallbackTimes: DEFAULT_SENDER_TIMES,
    startMinutes: is24h ? 0 : 8 * 60,
    endMinutes: is24h ? 23 * 60 : 22 * 60,
  });
}

const GENERATOR_SCHEDULES = getConfiguredGeneratorSchedules();
const SENDER_SCHEDULES = getConfiguredSenderSchedules();

let generatorScheduler = null;
let senderScheduler = null;
let running = false;
let logger = null;
let groupJid = "";
const generatedSlots = new Set();
const pendingStaggerTimeouts = new Set();

function clearPendingStaggerTimeouts() {
  for (const t of pendingStaggerTimeouts) {
    clearTimeout(t);
  }
  pendingStaggerTimeouts.clear();
}

function getJakartaDate() {
  const wib = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return `${wib.getUTCFullYear()}-${String(wib.getUTCMonth() + 1).padStart(2, "0")}-${String(wib.getUTCDate()).padStart(2, "0")}`;
}

function start({ logger: log, groupJid: gid } = {}) {
  if (running) {
    log?.warn("[Reddit Scheduler] Already running — skipping");
    return false;
  }
  if (process.env.REDDIT_STICKER_ENABLED === "false") {
    log?.info("[Reddit Scheduler] REDDIT_STICKER_ENABLED=false — not starting");
    return false;
  }

  logger = log;
  groupJid = gid || process.env.GROUP_JID || "";
  running = true;
  const generatorSchedules = getConfiguredGeneratorSchedules();
  const senderSchedules = getConfiguredSenderSchedules();

  if (!groupJid) {
    logger?.warn("[Reddit Scheduler] No GROUP_JID — sender disabled, generator still runs");
  }

  if (process.env.REDDIT_STICKER_GENERATOR_ENABLED !== "false") {
    generatorScheduler = createWindowedScheduler({
      name: "Reddit Generator",
      slots: generatorSchedules,
      task: runGenerator,
      allow24Hours: true,
      logger,
    });
    generatorScheduler.start();
  }

  if (process.env.REDDIT_STICKER_SENDER_ENABLED !== "false" && groupJid) {
    senderScheduler = createWindowedScheduler({
      name: "Reddit Sender",
      slots: senderSchedules,
      task: sendSticker,
      allow24Hours: true,
      logger,
    });
    senderScheduler.start();
  }

  logger?.info(
    `[Reddit Scheduler] Started: generators ${generatorSchedules.map((slot) => slot.time).join(", ")}; senders ${senderSchedules.map((slot) => slot.time).join(", ")} WIB`
  );
  return true;
}

function stop() {
  running = false;
  clearPendingStaggerTimeouts();
  generatorScheduler?.stop();
  senderScheduler?.stop();
  generatorScheduler = null;
  senderScheduler = null;
  logger?.info("[Reddit Scheduler] Stopped");
}

async function resume() {
  const results = await Promise.all([
    generatorScheduler?.resume() || false,
    senderScheduler?.resume() || false,
  ]);
  return results.some(Boolean);
}

function isRunning() {
  return running;
}

function shouldRecordGenerationSuccess(result) {
  return Number(result?.generated) > 0;
}

async function runGenerator(slot = { id: "generate" }) {
  const today = getJakartaDate();
  const slotId = slot?.id || "generate";
  const generationKey = `${today}:${slotId}`;
  for (const key of generatedSlots) {
    if (!key.startsWith(`${today}:`)) generatedSlots.delete(key);
  }
  if (generatedSlots.has(generationKey)) {
    logger?.info({ slot: generationKey }, "[Reddit Scheduler] Generator slot already completed — skipping");
    return true;
  }

  logger?.info({ slot: generationKey }, "[Reddit Scheduler] Running sticker generator...");
  try {
    const result = await generateStickers({ logger, slot: slotId });
    if (shouldRecordGenerationSuccess(result)) {
      generatedSlots.add(generationKey);
    } else {
      logger?.warn(
        { slot: generationKey },
        "[Reddit Scheduler] No new stickers generated — this slot remains retryable until a later slot"
      );
    }
    logger?.info(result, `[Reddit Scheduler] Generator done: ${result.generated} stickers`);
    return true;
  } catch (error) {
    logger?.error({ err: error }, "[Reddit Scheduler] Generator failed");
    return false;
  }
}

async function sendSticker(slot) {
  if (await shouldSuppressCron(groupJid, "reddit-sticker")) {
    logger?.info("[Reddit Scheduler] Birthday takeover — skipping send");
    return true;
  }

  let senderEnabled = true;
  try {
    const { isCronSenderEnabled } = require("../commands/reddit");
    senderEnabled = isCronSenderEnabled();
  } catch {
    // Command module may not be loaded yet; enabled is the safe compatibility default.
  }
  if (!senderEnabled) {
    logger?.info("[Reddit Scheduler] Sender toggle is OFF — skipping");
    return true;
  }

  const sock = getSock();
  if (!sock) {
    logger?.warn("[Reddit Scheduler] WhatsApp unavailable — pending until reconnect");
    return false;
  }
  if (!groupJid) return true;

  try {
    const { searchAndSendGiphy, sendOneSticker } = require("../services/redditStickerService");

    // ── Option 2: Staggered Sending (Sebar Acak di sepanjang jeda 15 menit) ──
    // Phase 1: Minute +0 — Send 1 Photo Meme from Reddit
    logger?.info(`[Reddit Scheduler] Staggered #1/3: Sending 1 Photo Meme for slot ${slot?.time || slot?.id}...`);
    const memeRes = await sendOneSticker(sock, groupJid, { logger, count: 1 });
    if (memeRes?.sent > 0) {
      logger?.info(`[Reddit Scheduler] Sent ${memeRes.sent} Photo Meme`);
    }

    // Phase 2: Minute +5 (300s) — Send 1 Transparent Cutout Sticker
    const t2 = setTimeout(async () => {
      pendingStaggerTimeouts.delete(t2);
      try {
        const liveSock = getSock();
        if (!liveSock || !groupJid) return;
        logger?.info(`[Reddit Scheduler] Staggered #2/3: Sending 1 Transparent Sticker (+5m)...`);
        await searchAndSendGiphy("", liveSock, groupJid, { type: "stickers", logger });
      } catch (err) {
        logger?.warn({ err: err?.message }, "[Reddit Scheduler] Staggered transparent sticker failed");
      }
    }, 5 * 60 * 1000);
    pendingStaggerTimeouts.add(t2);

    // Phase 3: Minute +10 (600s) — Send 1 Animated Video GIF
    const t3 = setTimeout(async () => {
      pendingStaggerTimeouts.delete(t3);
      try {
        const liveSock = getSock();
        if (!liveSock || !groupJid) return;
        logger?.info(`[Reddit Scheduler] Staggered #3/3: Sending 1 Animated GIF (+10m)...`);
        await searchAndSendGiphy("", liveSock, groupJid, { type: "gifs", logger });
      } catch (err) {
        logger?.warn({ err: err?.message }, "[Reddit Scheduler] Staggered animated GIF failed");
      }
    }, 10 * 60 * 1000);
    pendingStaggerTimeouts.add(t3);

    logger?.info(`[Reddit Scheduler] Staggered dispatch scheduled for slot ${slot?.time || slot?.id} (Meme now, Sticker +5m, GIF +10m)`);
    return true;
  } catch (error) {
    logger?.error({ err: error }, "[Reddit Scheduler] Send batch failed — pending until reconnect");
    return false;
  }
}

module.exports = {
  GENERATOR_SCHEDULES,
  SENDER_SCHEDULES,
  getConfiguredGeneratorSchedules,
  getConfiguredSenderSchedules,
  distributeScheduleTimes,
  start,
  stop,
  resume,
  isRunning,
  runGenerator,
  sendSticker,
  shouldRecordGenerationSuccess,
};
