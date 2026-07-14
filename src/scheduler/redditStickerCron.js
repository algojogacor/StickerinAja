// Reddit Sticker Cron — standalone generator + sender.
// Integrates with origin/main architecture via getSock() from socket module.
// Birthday takeover suppression via shouldSuppressCron() stub.
// Cron toggle via isCronSenderEnabled() from commands/reddit.js.

const cron = require("node-cron");
const { getSock } = require("../core/socket");
const { shouldSuppressCron } = require("../services/birthdayTakeoverService");
const {
  generateStickers,
  sendOneSticker,
} = require("../services/redditStickerService");

let genCronJob = null;
let sendCronJobs = [];
let running = false;
let logger = null;
let groupJid = "";

// Idempotency per day
let genRanToday = false;
let genDay = -1;

function start({ logger: log, groupJid: gid } = {}) {
  if (running) {
    log?.warn("[Reddit Cron] Already running — skipping");
    return;
  }

  if (process.env.REDDIT_STICKER_ENABLED === "false") {
    log?.info("[Reddit Cron] REDDIT_STICKER_ENABLED=false — not starting");
    return;
  }

  logger = log;
  groupJid = gid || process.env.GROUP_JID || "";
  running = true;

  if (!groupJid) {
    logger?.warn("[Reddit Cron] No GROUP_JID set — sender disabled, generator still runs");
  }

  // Generator: once daily at 05:00 WIB
  if (process.env.REDDIT_STICKER_GENERATOR_ENABLED !== "false") {
    genCronJob = cron.schedule(
      "0 5 * * *",
      () => runGenerator(),
      { timezone: "Asia/Jakarta", name: "reddit-sticker-gen" }
    );
    logger?.info("[Reddit Cron] Generator scheduled: daily at 05:00 WIB");
  }

  // Sender: 2x daily
  if (process.env.REDDIT_STICKER_SENDER_ENABLED !== "false" && groupJid) {
    const schedules = ["0 10 * * *", "0 18 * * *"];
    for (const s of schedules) {
      const job = cron.schedule(
        s,
        () => sendSticker(),
        { timezone: "Asia/Jakarta", name: `reddit-sticker-send-${s.replace(/[^0-9]/g, "")}` }
      );
      sendCronJobs.push(job);
    }
    logger?.info("[Reddit Cron] Sender scheduled: 2x daily (10:00 & 18:00 WIB)");
  }
}

function stop() {
  running = false;
  if (genCronJob) { genCronJob.stop(); genCronJob = null; }
  for (const j of sendCronJobs) j.stop();
  sendCronJobs = [];
  logger?.info("[Reddit Cron] Stopped");
}

function isRunning() {
  return running;
}

async function runGenerator() {
  const now = new Date();
  const wib = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  const today = wib.getDate();

  if (genDay === today && genRanToday) {
    logger?.info("[Reddit Cron] Generator already ran today — skipping");
    return;
  }

  logger?.info("[Reddit Cron] Running sticker generator...");
  try {
    const result = await generateStickers({ logger });
    genRanToday = true;
    genDay = today;
    logger?.info(result, `[Reddit Cron] Generator done: ${result.generated} stickers`);
  } catch (err) {
    logger?.error({ err }, "[Reddit Cron] Generator failed");
  }
}

async function sendSticker() {
  if (await shouldSuppressCron(groupJid, "reddit-sticker")) {
    logger?.info("[Reddit Cron] Birthday takeover — skipping send");
    return;
  }

  // Check cron sender toggle from commands/reddit.js
  let senderEnabled = true;
  try {
    const { isCronSenderEnabled } = require("../commands/reddit");
    senderEnabled = isCronSenderEnabled();
  } catch {
    // If command module isn't loaded yet, default to enabled
  }

  if (!senderEnabled) {
    logger?.info("[Reddit Cron] Sender toggle is OFF — skipping");
    return;
  }

  const sock = getSock();
  if (!sock) {
    logger?.warn("[Reddit Cron] No socket — skipping send");
    return;
  }

  if (!groupJid) return;

  logger?.info("[Reddit Cron] Sending sticker from bank...");
  try {
    const result = await sendOneSticker(sock, groupJid, { logger });
    if (result.sent > 0) {
      logger?.info(`[Reddit Cron] Sticker sent (${result.sent})`);
    }
  } catch (err) {
    logger?.error({ err }, "[Reddit Cron] Send failed");
  }
}

module.exports = { start, stop, isRunning, runGenerator, sendSticker };
