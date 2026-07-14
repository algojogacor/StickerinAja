// Baseline runtime test — verifies that all critical modules load
// without MODULE_NOT_FOUND or syntax errors.
// These tests would have detected the pre-existing Phase 1 gaps.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("Baseline Module Loading", () => {
  const modules = [
    { name: "node-cron", path: "node-cron" },
    { name: "contentHistory", path: "../src/utils/contentHistory" },
    { name: "groqNewsEditor", path: "../src/services/groqNewsEditor" },
    { name: "newsService", path: "../src/services/newsService" },
    { name: "redditStickerCron", path: "../src/scheduler/redditStickerCron" },
    { name: "redditStickerDiscovery", path: "../src/services/redditStickerDiscovery" },
    { name: "redditStickerService", path: "../src/services/redditStickerService" },
    { name: "redditMediaDownloader", path: "../src/services/redditMediaDownloader" },
    { name: "redditMediaConverter", path: "../src/services/redditMediaConverter" },
    { name: "redditMediaResolver", path: "../src/services/redditMediaResolver" },
    { name: "redditUrlParser", path: "../src/utils/redditUrlParser" },
    { name: "redditStickerRepository", path: "../src/repositories/redditStickerRepository" },
    { name: "birthdayTakeoverService", path: "../src/services/birthdayTakeoverService" },
    { name: "cache", path: "../src/utils/cache" },
    { name: "textRenderer", path: "../src/utils/textRenderer" },
    { name: "socket", path: "../src/core/socket" },
    { name: "baileys", path: "../src/baileys" },
    { name: "handler", path: "../src/handler" },
    { name: "reddit commands", path: "../src/commands/reddit" },
    { name: "sticker commands", path: "../src/commands/sticker" },
    { name: "settings commands", path: "../src/commands/settings" },
    { name: "menu commands", path: "../src/commands/menu" },
  ];

  for (const mod of modules) {
    it(`should load ${mod.name}`, () => {
      const loaded = require(mod.path);
      assert.ok(loaded, `${mod.name} should export something`);
    });
  }
});

describe("groqNewsEditor Exports", () => {
  const editor = require("../src/services/groqNewsEditor");

  it("should export callGroqStructured", () => {
    assert.equal(typeof editor.callGroqStructured, "function");
  });

  it("should export editNewsWithGroq", () => {
    assert.equal(typeof editor.editNewsWithGroq, "function");
  });

  it("should export summarizeFxMarketContext", () => {
    assert.equal(typeof editor.summarizeFxMarketContext, "function");
  });

  it("should export isolateUrls", () => {
    assert.equal(typeof editor.isolateUrls, "function");
  });

  it("should export hydrateUrls", () => {
    assert.equal(typeof editor.hydrateUrls, "function");
  });

  it("should export generateArticleId", () => {
    assert.equal(typeof editor.generateArticleId, "function");
  });
});

describe("contentHistory Exports", () => {
  const ch = require("../src/utils/contentHistory");

  it("should export hashContent", () => {
    assert.equal(typeof ch.hashContent, "function");
  });

  it("should export hasSent", () => {
    assert.equal(typeof ch.hasSent, "function");
  });

  it("should export markSent", () => {
    assert.equal(typeof ch.markSent, "function");
  });

  it("should export clearNamespace", () => {
    assert.equal(typeof ch.clearNamespace, "function");
  });

  it("should export getEntryCount", () => {
    assert.equal(typeof ch.getEntryCount, "function");
  });
});
