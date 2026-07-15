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

function parseScheduleTimes(value) {
  return String(value || "")
    .split(/[\s,]+/)
    .map((time) => time.trim())
    .filter(Boolean)
    .filter((time) => {
      const match = /^(\d{2}):(\d{2})$/.exec(time);
      if (!match) return false;
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      return hour >= 7 && hour <= 22 && minute >= 0 && minute <= 59;
    });
}

function formatScheduleMinute(totalMinutes) {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function distributeScheduleTimes(count, startMinutes = 8 * 60, endMinutes = 22 * 60) {
  const safeCount = Math.max(1, Math.min(24, Number.parseInt(count, 10) || 1));
  if (safeCount === 1) return [formatScheduleMinute(endMinutes)];
  const step = (endMinutes - startMinutes) / (safeCount - 1);
  return Array.from({ length: safeCount }, (_, index) =>
    formatScheduleMinute(Math.round(startMinutes + step * index))
  );
}

function buildSchedules(prefix, {
  timesEnv,
  countEnv,
  fallbackTimes,
  startMinutes,
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
  return buildSchedules("generate", {
    timesEnv: "REDDIT_STICKER_GENERATE_TIMES",
    countEnv: "REDDIT_STICKER_GENERATIONS_PER_DAY",
    fallbackTimes: DEFAULT_GENERATOR_TIMES,
    startMinutes: 7 * 60,
    endMinutes: 21 * 60,
  });
}

function getConfiguredSenderSchedules() {
  return buildSchedules("send", {
    timesEnv: "REDDIT_STICKER_SEND_TIMES",
    countEnv: "REDDIT_STICKER_SENDS_PER_DAY",
    fallbackTimes: DEFAULT_SENDER_TIMES,
    startMinutes: 8 * 60,
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
      logger,
    });
    generatorScheduler.start();
  }

  if (process.env.REDDIT_STICKER_SENDER_ENABLED !== "false" && groupJid) {
    senderScheduler = createWindowedScheduler({
      name: "Reddit Sender",
      slots: senderSchedules,
      task: sendSticker,
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

async function sendSticker() {
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
    const result = await sendOneSticker(sock, groupJid, { logger });
    if (result.sent > 0) logger?.info(`[Reddit Scheduler] Sticker sent (${result.sent})`);
    return true;
  } catch (error) {
    logger?.error({ err: error }, "[Reddit Scheduler] Send failed — pending until reconnect");
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
