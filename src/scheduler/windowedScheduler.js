// Recursive absolute-slot scheduler for Asia/Jakarta.
// Each timeout targets a wall-clock slot, then the next delay is recomputed.
// This avoids cumulative setInterval drift and keeps all jobs inside 07:00-22:00 WIB.

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const WINDOW_START_MINUTES = 7 * 60;
const WINDOW_END_MINUTES = 22 * 60;
const WINDOW_RUNTIME_END_MINUTES = 22 * 60 + 30;

function getTestIntervalMinutes(env = process.env) {
  const value = Number(env?.SCHEDULER_TEST_INTERVAL_MINUTES);
  if (!Number.isInteger(value) || value < 1 || value > 60) return null;
  return value;
}

function parseTime(time) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(time || ""));
  if (!match) throw new Error(`Invalid scheduler time: ${time}`);

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid scheduler time: ${time}`);

  return { hour, minute, totalMinutes: hour * 60 + minute };
}

function normalizeDailySlots(slots) {
  if (!Array.isArray(slots) || slots.length === 0) {
    throw new Error("Windowed scheduler requires at least one daily slot");
  }

  const seen = new Set();
  return slots.map((slot) => {
    if (!slot?.id) throw new Error("Every scheduler slot requires an id");
    const parsed = parseTime(slot.time);
    if (parsed.totalMinutes < WINDOW_START_MINUTES || parsed.totalMinutes > WINDOW_END_MINUTES) {
      throw new Error(`Scheduler slot ${slot.id}@${slot.time} is outside 07:00-22:00 WIB`);
    }

    const identity = `${slot.id}@${slot.time}`;
    if (seen.has(identity)) throw new Error(`Duplicate scheduler slot: ${identity}`);
    seen.add(identity);

    return { ...slot, ...parsed };
  }).sort((a, b) => a.totalMinutes - b.totalMinutes || a.id.localeCompare(b.id));
}

function formatJakartaDate(localDate) {
  const year = localDate.getUTCFullYear();
  const month = String(localDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(localDate.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toUtcFromJakarta(localDate, hour, minute) {
  return new Date(Date.UTC(
    localDate.getUTCFullYear(),
    localDate.getUTCMonth(),
    localDate.getUTCDate(),
    hour - 7,
    minute,
    0,
    0
  ));
}

function getNextJakartaSlot(slots, currentTime = new Date()) {
  const normalized = normalizeDailySlots(slots);
  const now = currentTime instanceof Date ? currentTime : new Date(currentTime);
  if (Number.isNaN(now.getTime())) throw new Error("Invalid current scheduler time");

  const jakartaNow = new Date(now.getTime() + JAKARTA_OFFSET_MS);
  for (const slot of normalized) {
    const runAt = toUtcFromJakarta(jakartaNow, slot.hour, slot.minute);
    if (runAt.getTime() > now.getTime()) {
      const date = formatJakartaDate(jakartaNow);
      return { ...slot, date, key: `${date}:${slot.id}`, runAt };
    }
  }

  const tomorrow = new Date(jakartaNow.getTime());
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const slot = normalized[0];
  const runAt = toUtcFromJakarta(tomorrow, slot.hour, slot.minute);
  const date = formatJakartaDate(tomorrow);
  return { ...slot, date, key: `${date}:${slot.id}`, runAt };
}

function isInsideJakartaRuntimeWindow(currentTime = new Date()) {
  const now = currentTime instanceof Date ? currentTime : new Date(currentTime);
  if (Number.isNaN(now.getTime())) return false;
  const jakartaNow = new Date(now.getTime() + JAKARTA_OFFSET_MS);
  const minutes = jakartaNow.getUTCHours() * 60 + jakartaNow.getUTCMinutes();
  return minutes >= WINDOW_START_MINUTES && minutes < WINDOW_RUNTIME_END_MINUTES;
}

function buildTestSlot(baseSlot, runAt) {
  const jakartaRunAt = new Date(runAt.getTime() + JAKARTA_OFFSET_MS);
  const date = formatJakartaDate(jakartaRunAt);
  const hour = String(jakartaRunAt.getUTCHours()).padStart(2, "0");
  const minute = String(jakartaRunAt.getUTCMinutes()).padStart(2, "0");
  const time = `${hour}:${minute}`;
  return {
    ...baseSlot,
    date,
    time,
    key: `${date}:test-${hour}${minute}-${baseSlot.id}`,
    runAt,
    testMode: true,
  };
}

function createWindowedScheduler({
  name,
  slots,
  task,
  logger,
  now = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  testIntervalMinutes = getTestIntervalMinutes(),
}) {
  if (typeof task !== "function") throw new Error("Windowed scheduler requires a task function");
  const normalizedSlots = normalizeDailySlots(slots);
  const testIntervalMs = Number.isInteger(testIntervalMinutes)
    && testIntervalMinutes >= 1
    && testIntervalMinutes <= 60
    ? testIntervalMinutes * 60 * 1000
    : null;

  let running = false;
  let timer = null;
  let nextSlot = null;
  let pendingSlot = null;
  let inFlight = null;
  let testNextRunAt = null;
  let testSlotIndex = 0;

  async function executePending(reason) {
    if (!running || !pendingSlot || inFlight) return false;
    const slot = pendingSlot;

    inFlight = (async () => {
      try {
        const completed = await task(slot, { reason });
        if (completed !== false && pendingSlot?.key === slot.key) {
          pendingSlot = null;
        }
        return completed !== false;
      } catch (error) {
        logger?.error({ err: error, slot: slot.key }, `[${name}] Scheduled task failed`);
        return false;
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  }

  function scheduleNext() {
    if (!running) return;
    if (testIntervalMs) {
      const currentTime = now();
      if (!testNextRunAt) {
        testNextRunAt = new Date(currentTime.getTime() + testIntervalMs);
      }
      while (testNextRunAt.getTime() <= currentTime.getTime()) {
        testNextRunAt = new Date(testNextRunAt.getTime() + testIntervalMs);
      }
      const baseSlot = normalizedSlots[testSlotIndex % normalizedSlots.length];
      testSlotIndex += 1;
      nextSlot = buildTestSlot(baseSlot, testNextRunAt);
    } else {
      nextSlot = getNextJakartaSlot(normalizedSlots, now());
    }
    const delay = Math.max(0, nextSlot.runAt.getTime() - now().getTime());
    const scheduledSlot = nextSlot;

    timer = setTimer(async () => {
      timer = null;
      nextSlot = null;
      pendingSlot = scheduledSlot;
      if (isInsideJakartaRuntimeWindow(now())) {
        await executePending("scheduled");
      } else {
        logger?.warn({ slot: scheduledSlot.key }, `[${name}] Delayed slot retained outside the active WIB window`);
      }
      if (testIntervalMs) {
        testNextRunAt = new Date(scheduledSlot.runAt.getTime() + testIntervalMs);
      }
      scheduleNext();
    }, delay);

    timer?.unref?.();
    logger?.info(
      { slot: scheduledSlot.key, runAt: scheduledSlot.runAt.toISOString() },
      `[${name}] Next slot scheduled`
    );
  }

  function start() {
    if (running) {
      logger?.warn(`[${name}] Already running — skipping`);
      return false;
    }
    running = true;
    if (testIntervalMs) {
      logger?.warn(`[${name}] TEST MODE enabled — running every ${testIntervalMinutes} minutes`);
    }
    scheduleNext();
    return true;
  }

  function stop() {
    running = false;
    if (timer) clearTimer(timer);
    timer = null;
    nextSlot = null;
  }

  async function resume() {
    if (!isInsideJakartaRuntimeWindow(now())) {
      logger?.info(`[${name}] Pending slot retained outside the 07:00-22:29 WIB runtime window`);
      return false;
    }
    return executePending("resume");
  }

  function getState() {
    return {
      running,
      nextSlot,
      pendingSlot,
      inFlight: Boolean(inFlight),
      testMode: Boolean(testIntervalMs),
      testIntervalMinutes: testIntervalMs ? testIntervalMinutes : null,
    };
  }

  return { start, stop, resume, getState };
}

module.exports = {
  WINDOW_START_MINUTES,
  WINDOW_END_MINUTES,
  getTestIntervalMinutes,
  normalizeDailySlots,
  getNextJakartaSlot,
  isInsideJakartaRuntimeWindow,
  createWindowedScheduler,
};
