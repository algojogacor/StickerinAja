const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const newsScheduler = require("../src/scheduler/newsScheduler");
const redditScheduler = require("../src/scheduler/redditStickerCron");
const fxScheduler = require("../src/scheduler/fxCron");

function minutes(time) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function assertInsideWindow(slots) {
  for (const slot of slots) {
    assert.ok(minutes(slot.time) >= minutes("07:00"), `${slot.time} is before 07:00`);
    assert.ok(minutes(slot.time) <= minutes("22:00"), `${slot.time} is after 22:00`);
  }
}

describe("production scheduler configuration", () => {
  it("runs news four times daily from 07:00 through 22:00 WIB", () => {
    assert.deepEqual(
      newsScheduler.SCHEDULES.map((slot) => `${slot.id}@${slot.time}`),
      ["morning@07:00", "midday@12:00", "evening@17:00", "nightcap@22:00"]
    );
    assertInsideWindow(newsScheduler.SCHEDULES);
  });

  it("generates and sends Reddit stickers throughout the active WIB window", () => {
    assert.equal(redditScheduler.GENERATOR_SCHEDULES.length, 5);
    assert.equal(redditScheduler.SENDER_SCHEDULES.length, 10);
    assertInsideWindow([...redditScheduler.GENERATOR_SCHEDULES, ...redditScheduler.SENDER_SCHEDULES]);
  });

  it("allows the daily Reddit send count to be configured through env", () => {
    const previous = process.env.REDDIT_STICKER_SENDS_PER_DAY;
    const previousTimes = process.env.REDDIT_STICKER_SEND_TIMES;
    process.env.REDDIT_STICKER_SENDS_PER_DAY = "3";
    delete process.env.REDDIT_STICKER_SEND_TIMES;
    try {
      const schedules = redditScheduler.getConfiguredSenderSchedules();
      assert.equal(schedules.length, 3);
      assertInsideWindow(schedules);
      assert.deepEqual(schedules.map((slot) => slot.id), ["send-01", "send-02", "send-03"]);
    } finally {
      if (previous === undefined) delete process.env.REDDIT_STICKER_SENDS_PER_DAY;
      else process.env.REDDIT_STICKER_SENDS_PER_DAY = previous;
      if (previousTimes === undefined) delete process.env.REDDIT_STICKER_SEND_TIMES;
      else process.env.REDDIT_STICKER_SEND_TIMES = previousTimes;
    }
  });

  it("supports explicit Reddit send times from env", () => {
    const previous = process.env.REDDIT_STICKER_SEND_TIMES;
    process.env.REDDIT_STICKER_SEND_TIMES = "08:00,12:30,22:00";
    try {
      assert.deepEqual(
        redditScheduler.getConfiguredSenderSchedules().map((slot) => slot.time),
        ["08:00", "12:30", "22:00"]
      );
    } finally {
      if (previous === undefined) delete process.env.REDDIT_STICKER_SEND_TIMES;
      else process.env.REDDIT_STICKER_SEND_TIMES = previous;
    }
  });

  it("keeps FX cadence while preventing overnight runs", () => {
    assert.equal(fxScheduler.RATE_SCHEDULES[0].time, "07:05");
    assert.equal(fxScheduler.RATE_SCHEDULES.at(-1).time, "21:05");
    assert.equal(fxScheduler.RATE_SCHEDULES.length, 15);
    assert.deepEqual(
      fxScheduler.CONTEXT_SCHEDULES.map((slot) => slot.time),
      ["07:15", "10:15", "13:15", "16:15", "19:15"]
    );
    assertInsideWindow([...fxScheduler.RATE_SCHEDULES, ...fxScheduler.CONTEXT_SCHEDULES]);
  });
});
