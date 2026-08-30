const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  fetchMemeApiPosts,
  fetchGiphyPosts,
  discoverTrendingPosts,
  discoverByKeyword,
} = require("../src/services/redditStickerDiscovery");

const {
  searchAndSendGiphy,
  searchAndSend,
} = require("../src/services/redditStickerService");

const {
  validateHostname,
  ALLOWED_REDDIT_MEDIA_HOSTS,
} = require("../src/services/redditMediaDownloader");

const redditCommand = require("../src/commands/reddit");

describe("Meme-API and GIPHY Integrations", () => {
  it("exports discovery and service methods for Meme-API and GIPHY", () => {
    assert.strictEqual(typeof fetchMemeApiPosts, "function");
    assert.strictEqual(typeof fetchGiphyPosts, "function");
    assert.strictEqual(typeof searchAndSendGiphy, "function");
    assert.strictEqual(typeof searchAndSend, "function");
  });

  it("includes GIPHY hostnames in allowed downloader hosts", () => {
    assert.ok(ALLOWED_REDDIT_MEDIA_HOSTS.includes("media.giphy.com"));
    assert.ok(ALLOWED_REDDIT_MEDIA_HOSTS.includes("i.giphy.com"));
    assert.strictEqual(validateHostname("media.giphy.com"), true);
    assert.strictEqual(validateHostname("media0.giphy.com"), true);
    assert.strictEqual(validateHostname("media1.giphy.com"), true);
    assert.strictEqual(validateHostname("media2.giphy.com"), true);
  });

  it("registers gif, giphy, and sgif command names", () => {
    assert.ok(redditCommand.names.includes("gif"));
    assert.ok(redditCommand.names.includes("giphy"));
    assert.ok(redditCommand.names.includes("sgif"));
    assert.ok(redditCommand.names.includes("meme"));
  });

  it("rejects empty keywords safely", async () => {
    await assert.rejects(
      async () => searchAndSendGiphy("", {}, "dummy@g.us"),
      /Keyword kosong/i
    );
  });
});
