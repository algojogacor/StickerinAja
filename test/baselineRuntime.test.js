// Baseline runtime test — verifies that all critical modules load
// without MODULE_NOT_FOUND or syntax errors.
// These tests would have detected the pre-existing Phase 1 gaps.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("Baseline Module Loading", () => {
  const modules = [
    { name: "windowedScheduler", path: "../src/scheduler/windowedScheduler" },
    { name: "newsScheduler", path: "../src/scheduler/newsScheduler" },
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

describe("handler extractMessageContent", () => {
  const { extractMessageContent } = require("../src/handler");

  it("extracts text from plain conversation message", () => {
    const res = extractMessageContent({ message: { conversation: "!s" } });
    assert.equal(res.text, "!s");
    assert.equal(res.quotedMsg, null);
  });

  it("extracts caption from direct imageMessage", () => {
    const res = extractMessageContent({ message: { imageMessage: { caption: "!s --crop" } } });
    assert.equal(res.text, "!s --crop");
    assert.equal(res.quotedMsg, null);
  });

  it("extracts caption from direct videoMessage", () => {
    const res = extractMessageContent({ message: { videoMessage: { caption: "!s" } } });
    assert.equal(res.text, "!s");
  });

  it("extracts quoted message from extendedTextMessage", () => {
    const quotedImage = { imageMessage: { url: "https://example.com/img.jpg" } };
    const res = extractMessageContent({
      message: {
        extendedTextMessage: {
          text: "!s",
          contextInfo: { stanzaId: "stanza-123", quotedMessage: quotedImage }
        }
      }
    });
    assert.equal(res.text, "!s");
    assert.deepEqual(res.quotedMsg, quotedImage);
    assert.equal(res.quotedStanza, "stanza-123");
  });

  it("extracts from viewOnceMessage or ephemeralMessage wrappers", () => {
    const res = extractMessageContent({
      message: {
        ephemeralMessage: {
          message: {
            imageMessage: { caption: "!s" }
          }
        }
      }
    });
    assert.equal(res.text, "!s");
  });
});

describe("exifHelper WebP Metadata Injection", () => {
  const { createExif, addExifToWebp } = require("../src/utils/exifHelper");
  const sharp = require("sharp");

  it("generates valid EXIF binary buffer", () => {
    const exif = createExif("MyPack", "MyAuthor");
    assert.ok(Buffer.isBuffer(exif));
    assert.ok(exif.length > 50);
    assert.ok(exif.toString().includes("MyPack"));
    assert.ok(exif.toString().includes("MyAuthor"));
  });

  it("injects EXIF metadata into WebP buffer successfully", async () => {
    const rawWebp = await sharp({
      create: { width: 512, height: 512, channels: 4, background: { r: 100, g: 150, b: 200, alpha: 1 } }
    }).webp().toBuffer();

    const withExif = addExifToWebp(rawWebp, "yg buat stiker femboy", "rtl femboy");
    assert.ok(Buffer.isBuffer(withExif));
    assert.ok(withExif.length > rawWebp.length);
    assert.equal(withExif.slice(0, 4).toString(), "RIFF");
    assert.equal(withExif.slice(8, 12).toString(), "WEBP");

    const meta = await sharp(withExif).metadata();
    assert.equal(meta.format, "webp");
    assert.equal(meta.width, 512);
    assert.ok(meta.exif);
    assert.ok(meta.exif.toString().includes("rtl femboy"));
    assert.ok(meta.exif.toString().includes("yg buat stiker femboy"));
  });
});

describe("Per-user session state and 6h expiration", () => {
  const { getSession } = require("../src/handler");

  it("isolates settings between different user JIDs", () => {
    const s1 = getSession("user1@s.whatsapp.net");
    const s2 = getSession("user2@s.whatsapp.net");

    s1.pack = "Ahay Pack";
    s1.author = "User Satu";

    s2.pack = "Uhuy Pack";
    s2.author = "User Dua";

    assert.equal(getSession("user1@s.whatsapp.net").pack, "Ahay Pack");
    assert.equal(getSession("user1@s.whatsapp.net").author, "User Satu");
    assert.equal(getSession("user2@s.whatsapp.net").pack, "Uhuy Pack");
    assert.equal(getSession("user2@s.whatsapp.net").author, "User Dua");
  });

  it("resets custom pack and author back to default after 6 hours", () => {
    const s = getSession("expiring_user@s.whatsapp.net");
    s.pack = "Temporary Pack";
    s.author = "Temporary Author";
    // Set customExpiresAt to 1 millisecond in the past
    s.customExpiresAt = Date.now() - 1;

    const refreshed = getSession("expiring_user@s.whatsapp.net");
    assert.equal(refreshed.pack, process.env.STICKERIN_BOT_NAME || "Stikerin Aja");
    assert.equal(refreshed.author, process.env.STICKERIN_AUTHOR || "Bot");
    assert.equal(refreshed.customExpiresAt, null);
  });
});


