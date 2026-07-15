const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const newsScheduler = require("../src/scheduler/newsScheduler");
const newsService = require("../src/services/newsService");
const { setSock, clearSock } = require("../src/core/socket");

const originalGetNewsBySlot = newsService.getNewsBySlot;
const originalConfirmNewsSent = newsService.confirmNewsSent;

afterEach(() => {
  newsScheduler.stop();
  clearSock();
  newsService.getNewsBySlot = originalGetNewsBySlot;
  newsService.confirmNewsSent = originalConfirmNewsSent;
});

describe("News Scheduler delivery", () => {
  it("waits for reconnect before generating a briefing", async () => {
    let generated = 0;
    newsService.getNewsBySlot = async () => {
      generated += 1;
      return { messages: ["brief"], generationKey: "g1" };
    };
    newsScheduler.start({ groupJid: "group@g.us" });

    const completed = await newsScheduler.sendNewsSlot({
      id: "morning",
      date: "2026-07-15",
      key: "2026-07-15:morning",
    });

    assert.equal(completed, false);
    assert.equal(generated, 0);
  });

  it("resumes a partially sent multi-message briefing without duplicating earlier parts", async () => {
    let generated = 0;
    let confirmed = 0;
    newsService.getNewsBySlot = async () => {
      generated += 1;
      return { messages: ["part-1", "part-2"], generationKey: "g2" };
    };
    newsService.confirmNewsSent = async () => { confirmed += 1; };

    const firstAttempt = [];
    setSock({
      async sendMessage(_jid, payload) {
        firstAttempt.push(payload.text);
        if (payload.text === "part-2") throw new Error("connection closed");
      },
    });
    newsScheduler.start({ groupJid: "group@g.us" });
    const slot = { id: "midday", date: "2026-07-15", key: "2026-07-15:midday" };

    assert.equal(await newsScheduler.sendNewsSlot(slot), false);
    assert.deepEqual(firstAttempt, ["part-1", "part-2"]);

    const resumed = [];
    setSock({ async sendMessage(_jid, payload) { resumed.push(payload.text); } });
    assert.equal(await newsScheduler.sendNewsSlot(slot), true);
    assert.deepEqual(resumed, ["part-2"]);
    assert.equal(generated, 1);
    assert.equal(confirmed, 1);
  });
});
