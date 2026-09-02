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

  it("handles empty keywords with fallback queries gracefully", async () => {
    const dummySock = { sendMessage: async () => ({}) };
    const res = await searchAndSendGiphy("", dummySock, "dummy@g.us");
    assert.ok(typeof res === "object");
  });

  it("fetchGiphyPosts supports offset and randomOffset parameters", async () => {
    // When no API key is set, returns empty array without throwing
    const res1 = await fetchGiphyPosts({ query: "meme", offset: 10 });
    assert.ok(Array.isArray(res1));

    const res2 = await fetchGiphyPosts({ query: "meme", randomOffset: true, maxRandomOffset: 30 });
    assert.ok(Array.isArray(res2));
  });

  it("exports curated fallback lists containing popular reaction memes", () => {
    const {
      CURATED_REACTION_FALLBACKS,
      CURATED_STICKER_FALLBACKS,
      UNUSABLE_STICKER_SUBREDDITS,
      isAutomatedMemeCandidate,
    } = require("../src/services/redditStickerService");

    assert.ok(Array.isArray(CURATED_REACTION_FALLBACKS));
    assert.ok(CURATED_REACTION_FALLBACKS.includes("cat meme reaction"));
    assert.ok(CURATED_REACTION_FALLBACKS.includes("facepalm meme"));
    assert.ok(CURATED_REACTION_FALLBACKS.includes("laughing hard meme"));
    assert.ok(CURATED_REACTION_FALLBACKS.includes("crying meme"));
    assert.ok(CURATED_REACTION_FALLBACKS.includes("side eye meme"));
    assert.ok(CURATED_REACTION_FALLBACKS.includes("sus meme"));

    assert.ok(Array.isArray(CURATED_STICKER_FALLBACKS));
    assert.ok(CURATED_STICKER_FALLBACKS.includes("cat reaction sticker"));
    assert.ok(CURATED_STICKER_FALLBACKS.includes("pepe sticker"));

    assert.ok(UNUSABLE_STICKER_SUBREDDITS.has("wholesomememes"));
    assert.ok(UNUSABLE_STICKER_SUBREDDITS.has("animemes"));
    assert.ok(UNUSABLE_STICKER_SUBREDDITS.has("goodanimemes"));
    assert.ok(UNUSABLE_STICKER_SUBREDDITS.has("funny"));

    // Filters cheesy foreign greeting cards and daytime bedtime greetings
    assert.strictEqual(isAutomatedMemeCandidate({ subreddit: "giphy", title: "Te Iubesc... INFINIT!" }), false);
    assert.strictEqual(isAutomatedMemeCandidate({ subreddit: "giphy", title: "ti amo amore mio" }), false);
    assert.strictEqual(isAutomatedMemeCandidate({ subreddit: "giphy", title: "cat meme reaction" }), true);
  });
});


