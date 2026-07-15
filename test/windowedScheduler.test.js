const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  createWindowedScheduler,
  getTestIntervalMinutes,
  getNextJakartaSlot,
  normalizeDailySlots,
} = require("../src/scheduler/windowedScheduler");

describe("Windowed scheduler slot calculation", () => {
  const newsSlots = [
    { id: "morning", time: "07:00" },
    { id: "midday", time: "12:00" },
    { id: "evening", time: "17:00" },
    { id: "nightcap", time: "22:00" },
  ];

  it("selects the next absolute WIB slot instead of anchoring to process start", () => {
    const next = getNextJakartaSlot(newsSlots, new Date("2026-07-15T02:30:00.000Z"));

    assert.equal(next.id, "midday");
    assert.equal(next.key, "2026-07-15:midday");
    assert.equal(next.runAt.toISOString(), "2026-07-15T05:00:00.000Z");
  });

  it("rolls to 07:00 WIB on the next day after the final slot", () => {
    const next = getNextJakartaSlot(newsSlots, new Date("2026-07-15T15:01:00.000Z"));

    assert.equal(next.id, "morning");
    assert.equal(next.key, "2026-07-16:morning");
    assert.equal(next.runAt.toISOString(), "2026-07-16T00:00:00.000Z");
  });

  it("rejects slots outside the 07:00 through 22:00 WIB window", () => {
    assert.throws(
      () => normalizeDailySlots([{ id: "too-early", time: "06:59" }]),
      /07:00-22:00/
    );
    assert.throws(
      () => normalizeDailySlots([{ id: "too-late", time: "22:01" }]),
      /07:00-22:00/
    );
  });

  it("accepts only a safe positive integer for the temporary test interval", () => {
    assert.equal(getTestIntervalMinutes({ SCHEDULER_TEST_INTERVAL_MINUTES: "5" }), 5);
    assert.equal(getTestIntervalMinutes({ SCHEDULER_TEST_INTERVAL_MINUTES: "0" }), null);
    assert.equal(getTestIntervalMinutes({ SCHEDULER_TEST_INTERVAL_MINUTES: "abc" }), null);
    assert.equal(getTestIntervalMinutes({}), null);
  });
});

describe("Windowed scheduler lifecycle", () => {
  it("recomputes the next wall-clock slot after a run and avoids overlap", async () => {
    let now = new Date("2026-07-15T00:00:00.000Z"); // 07:00 WIB
    const timers = [];
    let resolveTask;
    let calls = 0;

    const scheduler = createWindowedScheduler({
      name: "test",
      slots: [
        { id: "first", time: "07:01" },
        { id: "second", time: "12:00" },
      ],
      now: () => now,
      setTimer: (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      },
      clearTimer: () => {},
      task: async () => {
        calls += 1;
        await new Promise((resolve) => { resolveTask = resolve; });
        return true;
      },
    });

    scheduler.start();
    assert.equal(timers[0].delay, 60_000);

    now = new Date("2026-07-15T00:01:00.000Z");
    const firstRun = timers[0].callback();
    await scheduler.resume();
    assert.equal(calls, 1, "resume must not overlap an in-flight task");

    resolveTask();
    await firstRun;

    assert.equal(timers[1].delay, 17_940_000);
    scheduler.stop();
  });

  it("keeps a retryable due slot pending until resume succeeds", async () => {
    let now = new Date("2026-07-15T00:00:00.000Z");
    let timer;
    const outcomes = [false, true];

    const scheduler = createWindowedScheduler({
      name: "retry",
      slots: [{ id: "send", time: "07:01" }],
      now: () => now,
      setTimer: (callback, delay) => {
        timer = { callback, delay };
        return timer;
      },
      clearTimer: () => {},
      task: async () => outcomes.shift(),
    });

    scheduler.start();
    now = new Date("2026-07-15T00:01:00.000Z");
    await timer.callback();
    assert.equal(scheduler.getState().pendingSlot?.id, "send");

    await scheduler.resume();
    assert.equal(scheduler.getState().pendingSlot, null);
    scheduler.stop();
  });

  it("does not resume pending delivery outside 07:00-22:00 WIB", async () => {
    let now = new Date("2026-07-15T13:59:00.000Z"); // 20:59 WIB
    let timer;
    let calls = 0;
    const scheduler = createWindowedScheduler({
      name: "window-guard",
      slots: [{ id: "send", time: "21:00" }],
      now: () => now,
      setTimer: (callback, delay) => {
        timer = { callback, delay };
        return timer;
      },
      clearTimer: () => {},
      task: async () => {
        calls += 1;
        return false;
      },
    });

    scheduler.start();
    now = new Date("2026-07-15T14:00:00.000Z");
    await timer.callback();
    assert.equal(calls, 1);

    now = new Date("2026-07-15T16:00:00.000Z"); // 23:00 WIB
    await scheduler.resume();
    assert.equal(calls, 1);
    assert.equal(scheduler.getState().pendingSlot?.id, "send");
    scheduler.stop();
  });

  it("uses an absolute five-minute cadence only when test mode is explicitly enabled", async () => {
    let now = new Date("2026-07-15T00:00:00.000Z"); // 07:00 WIB
    const timers = [];
    const executed = [];
    const scheduler = createWindowedScheduler({
      name: "five-minute-test",
      slots: [
        { id: "first", time: "07:00" },
        { id: "second", time: "12:00" },
      ],
      testIntervalMinutes: 5,
      now: () => now,
      setTimer: (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      },
      clearTimer: () => {},
      task: async (slot) => {
        executed.push(slot);
        return true;
      },
    });

    scheduler.start();
    assert.equal(timers[0].delay, 300_000);

    now = new Date("2026-07-15T00:05:00.000Z");
    await timers[0].callback();
    assert.equal(executed[0].id, "first");
    assert.equal(executed[0].time, "07:05");
    assert.equal(executed[0].testMode, true);
    assert.equal(timers[1].delay, 300_000);

    now = new Date("2026-07-15T00:10:00.000Z");
    await timers[1].callback();
    assert.equal(executed[1].id, "second");
    assert.equal(executed[1].time, "07:10");
    scheduler.stop();
  });
});
