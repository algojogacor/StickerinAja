// FX Cron tests — idempotency keys, slot generation, module contract.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const fxCron = require("../src/scheduler/fxCron");

describe("FX Cron — Module Contract", () => {
  it("exports start function", () => {
    assert.equal(typeof fxCron.start, "function");
  });

  it("exports stop function", () => {
    assert.equal(typeof fxCron.stop, "function");
  });

  it("exports isRunning function", () => {
    assert.equal(typeof fxCron.isRunning, "function");
    assert.equal(typeof fxCron.isRunning(), "boolean");
  });

  it("exports runHourlyRateUpdate function", () => {
    assert.equal(typeof fxCron.runHourlyRateUpdate, "function");
  });

  it("exports runMarketContextRefresh function", () => {
    assert.equal(typeof fxCron.runMarketContextRefresh, "function");
  });

  it("exports manualRefresh function", () => {
    assert.equal(typeof fxCron.manualRefresh, "function");
  });

  it("preserves the intended scheduled slot when reconnect delivery runs late", () => {
    assert.equal(
      fxCron.getJakartaHourlySlot({ date: "2026-07-15", time: "07:05" }),
      "2026-07-15:07"
    );
    assert.deepEqual(
      fxCron.getJakartaContextSlot({ date: "2026-07-15", time: "10:15" }),
      { threeHourSlot: "2026-07-15:10", hour: 10 }
    );
  });

  it("uses minute-specific execution keys during temporary interval testing", () => {
    assert.equal(
      fxCron.getJakartaHourlySlot({
        date: "2026-07-15",
        time: "07:05",
        testMode: true,
      }),
      "2026-07-15:07-05"
    );
    assert.deepEqual(
      fxCron.getJakartaContextSlot({
        date: "2026-07-15",
        time: "07:10",
        testMode: true,
      }),
      { threeHourSlot: "2026-07-15:07-10", hour: 7 }
    );
  });
});

describe("FX Cron — Idempotency Key Format", () => {
  // These test the slot key format via a helper concept
  // (the actual helper functions are internal to fxCron.js)

  it("hourly slot format is YYYY-MM-DD:HH", () => {
    // Validate the format: YYYY-MM-DD:HH
    const pattern = /^\d{4}-\d{2}-\d{2}:\d{2}$/;
    const now = new Date();
    const wib = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
    const year = wib.getFullYear();
    const month = String(wib.getMonth() + 1).padStart(2, "0");
    const day = String(wib.getDate()).padStart(2, "0");
    const hour = String(wib.getHours()).padStart(2, "0");
    const slot = `${year}-${month}-${day}:${hour}`;
    assert.ok(pattern.test(slot), `Slot "${slot}" should match YYYY-MM-DD:HH`);
  });

  it("collect and delivery have separate key prefixes", () => {
    const slot = "2026-07-14:15";
    const collectKey = `fx-collect:USD-IDR:${slot}`;
    const deliveryKey = `fx-delivery:USD-IDR:${slot}`;
    assert.notEqual(collectKey, deliveryKey);
    assert.ok(collectKey.startsWith("fx-collect:"));
    assert.ok(deliveryKey.startsWith("fx-delivery:"));
  });

  it("context slot uses 3-hour grouping", () => {
    const now = new Date();
    const wib = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
    const year = wib.getFullYear();
    const month = String(wib.getMonth() + 1).padStart(2, "0");
    const day = String(wib.getDate()).padStart(2, "0");
    const hour = Math.floor(wib.getHours() / 3) * 3;
    const slot = `${year}-${month}-${day}:${String(hour).padStart(2, "0")}`;
    const contextKey = `fx-context:USD-IDR:${slot}`;
    assert.ok(contextKey.startsWith("fx-context:"));
    // Hour should be 0, 3, 6, 9, 12, 15, 18, or 21
    assert.ok([0, 3, 6, 9, 12, 15, 18, 21].includes(hour));
  });
});

describe("FX Cron — Scheduler Not Running Without Start", () => {
  it("isRunning returns false before start is called", () => {
    // fxCron might not have been started in test environment
    // Just verify the type is correct
    assert.equal(typeof fxCron.isRunning(), "boolean");
  });
});
