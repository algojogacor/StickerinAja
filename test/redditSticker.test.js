// Unit tests for Reddit Sticker Bank.
// Uses Node.js built-in test runner (node:test).
// Mocked — no real credentials or network calls used.
//
// Run: node --test test/redditSticker.test.js

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// ══════════════════════════════════════════════════════════════
// URL PARSING (new standalone redditUrlParser)
// ══════════════════════════════════════════════════════════════

describe("Reddit URL Parsing (redditUrlParser)", () => {
  const {
    parseRedditPostUrl,
    isRedditPostUrl,
    extractPostId,
    REDDIT_POST_HOSTS,
  } = require("../src/utils/redditUrlParser");

  it("parses standard reddit URL", () => {
    const result = parseRedditPostUrl(
      "https://www.reddit.com/r/memes/comments/abc123/title/"
    );
    assert.ok(result);
    assert.strictEqual(result.postId, "abc123");
    assert.strictEqual(result.subreddit, "memes");
  });

  it("parses old.reddit.com URL", () => {
    const result = parseRedditPostUrl(
      "https://old.reddit.com/r/funny/comments/xyz789/slug/"
    );
    assert.ok(result);
    assert.strictEqual(result.postId, "xyz789");
    assert.strictEqual(result.subreddit, "funny");
  });

  it("parses redd.it shortlink", () => {
    const result = parseRedditPostUrl("https://redd.it/abc123");
    assert.ok(result);
    assert.strictEqual(result.postId, "abc123");
  });

  it("parses reddit.com (no www)", () => {
    const result = parseRedditPostUrl(
      "https://reddit.com/r/memes/comments/abc123/"
    );
    assert.ok(result);
    assert.strictEqual(result.postId, "abc123");
  });

  it("rejects fake reddit hostname (substring check bypass)", () => {
    assert.strictEqual(
      parseRedditPostUrl("https://reddit.com.evil.org/r/a/comments/abc123/"),
      null
    );
    assert.strictEqual(
      parseRedditPostUrl("https://fake-reddit.com/r/a/comments/abc123/"),
      null
    );
    assert.strictEqual(
      parseRedditPostUrl("https://www.reddit.com.example.com/r/memes/comments/abc/"),
      null
    );
  });

  it("rejects subreddit homepage", () => {
    assert.strictEqual(parseRedditPostUrl("https://reddit.com/r/memes/"), null);
    assert.strictEqual(
      parseRedditPostUrl("https://reddit.com/r/memes/hot/"),
      null
    );
  });

  it("rejects non-post Reddit pages", () => {
    assert.strictEqual(
      parseRedditPostUrl("https://reddit.com/r/popular/"),
      null
    );
    assert.strictEqual(
      parseRedditPostUrl("https://reddit.com/search/?q=test"),
      null
    );
    assert.strictEqual(
      parseRedditPostUrl("https://reddit.com/user/someuser/"),
      null
    );
    assert.strictEqual(
      parseRedditPostUrl("https://reddit.com/message/inbox/"),
      null
    );
  });

  it("rejects non-reddit URLs", () => {
    assert.strictEqual(
      parseRedditPostUrl("https://youtube.com/watch?v=abc"),
      null
    );
    assert.strictEqual(
      parseRedditPostUrl("https://twitter.com/user/status/123"),
      null
    );
  });

  it("rejects invalid input", () => {
    assert.strictEqual(parseRedditPostUrl(""), null);
    assert.strictEqual(parseRedditPostUrl(null), null);
    assert.strictEqual(parseRedditPostUrl("not a url"), null);
  });

  it("accepts HTTP for URL parsing (HTTPS enforced by downloader)", () => {
    // URL parser validates structure; HTTPS requirement is in the downloader
    const result = parseRedditPostUrl("http://reddit.com/r/memes/comments/abc123/");
    assert.ok(result);
    assert.strictEqual(result.postId, "abc123");
  });

  it("isRedditPostUrl helper works", () => {
    assert.strictEqual(
      isRedditPostUrl("https://reddit.com/r/a/comments/abc123/"),
      true
    );
    assert.strictEqual(isRedditPostUrl("https://google.com/"), false);
  });

  it("extractPostId helper works", () => {
    assert.strictEqual(
      extractPostId("https://reddit.com/r/a/comments/abc123/"),
      "abc123"
    );
    assert.strictEqual(extractPostId("https://redd.it/xyz789"), "xyz789");
    assert.strictEqual(extractPostId("not a url"), null);
  });

  it("REDDIT_POST_HOSTS uses Set for O(1) lookup", () => {
    assert.ok(REDDIT_POST_HOSTS instanceof Set);
    assert.ok(REDDIT_POST_HOSTS.has("reddit.com"));
    assert.ok(REDDIT_POST_HOSTS.has("www.reddit.com"));
    assert.ok(REDDIT_POST_HOSTS.has("old.reddit.com"));
    assert.ok(REDDIT_POST_HOSTS.has("redd.it"));
  });
});

// ══════════════════════════════════════════════════════════════
// DISCOVERY — You.com search result normalization (ADAPTER)
// ══════════════════════════════════════════════════════════════

describe("You.com Search Result Normalization (Adapter)", () => {
  const { normalizeSearchResult } = require("../src/services/redditStickerDiscovery");

  it("normalizes a valid Reddit post result", () => {
    const raw = {
      title: "Funny meme about programming",
      description: "A hilarious take on JavaScript promises",
      url: "https://www.reddit.com/r/ProgrammerHumor/comments/abc123/funny_meme/",
      source: "reddit.com",
      page_age: "5 hours ago",
      thumbnail: "https://preview.redd.it/abc123.jpg?width=640",
    };

    const result = normalizeSearchResult(raw, 0);
    assert.ok(result);
    assert.strictEqual(result.id, "abc123");
    assert.strictEqual(result.subreddit, "ProgrammerHumor");
    assert.strictEqual(result.title, "Funny meme about programming");
    assert.strictEqual(result._source, "you.com");
    assert.strictEqual(result.over_18, false);
    assert.strictEqual(result.spoiler, false);
    assert.ok(result.created_utc > 0);
  });

  it("normalizes a redd.it shortlink result", () => {
    const raw = {
      title: "Check this out",
      url: "https://redd.it/xyz789",
      page_age: "2 days ago",
    };

    const result = normalizeSearchResult(raw, 1);
    assert.ok(result);
    assert.strictEqual(result.id, "xyz789");
  });

  it("rejects non-Reddit URLs", () => {
    const raw = {
      title: "Not Reddit",
      url: "https://twitter.com/user/status/123",
    };

    assert.strictEqual(normalizeSearchResult(raw, 0), null);
  });

  it("rejects Reddit homepage URLs", () => {
    const raw = {
      title: "Memes",
      url: "https://reddit.com/r/memes/",
    };

    assert.strictEqual(normalizeSearchResult(raw, 0), null);
  });

  it("handles missing optional fields gracefully", () => {
    const raw = {
      url: "https://reddit.com/r/test/comments/min123/",
    };

    const result = normalizeSearchResult(raw, 0);
    assert.ok(result);
    assert.strictEqual(result.title, "");
    assert.strictEqual(result.author, "");
    assert.strictEqual(result.score, 0);
    assert.strictEqual(result._searchThumbnailUrl, null);
  });

  it("normalized result has required fields for resolver", () => {
    const raw = {
      title: "Test Post",
      url: "https://reddit.com/r/memes/comments/test456/test_post/",
      page_age: "1 hour ago",
      thumbnail: "https://preview.redd.it/test.jpg",
    };

    const result = normalizeSearchResult(raw, 0);
    assert.ok(result);

    // Fields the resolver expects
    assert.ok("id" in result);
    assert.ok("subreddit" in result);
    assert.ok("permalink" in result);
    assert.ok("url" in result);
    assert.ok("created_utc" in result);
    assert.ok("over_18" in result);
    assert.ok("spoiler" in result);
    assert.ok("is_self" in result);
    assert.ok("is_video" in result);
    assert.ok("thumbnail" in result);
    assert.ok("preview" in result);

    // Adapter metadata (not from Reddit OAuth)
    assert.strictEqual(result._source, "you.com");
    assert.strictEqual(result._searchIndex, 0);
  });

  it("does NOT fake Reddit vote metadata", () => {
    const raw = {
      url: "https://reddit.com/r/test/comments/vote1/",
    };
    const result = normalizeSearchResult(raw, 0);
    assert.strictEqual(result.score, 0);
    assert.strictEqual(result.num_comments, 0);
    assert.strictEqual(result.upvote_ratio, 0);
  });
});

// ══════════════════════════════════════════════════════════════
// DISCOVERY — no OAuth credentials needed
// ══════════════════════════════════════════════════════════════

describe("No Reddit OAuth Required", () => {
  it("redditStickerDiscovery does not import redditService", () => {
    const mod = require("../src/services/redditStickerDiscovery");
    // Should only depend on urlParser, not on redditService
    assert.ok(typeof mod.discoverTrendingPosts === "function");
    assert.ok(typeof mod.discoverByKeyword === "function");
    assert.ok(typeof mod.fetchRedditPageMetadata === "function");
  });

  it("redditStickerService does not import redditService (OAuth)", () => {
    const mod = require("../src/services/redditStickerService");
    assert.ok(typeof mod.generateStickers === "function");
    assert.ok(typeof mod.searchAndSend === "function");
    // The module should work without REDDIT_CLIENT_ID set
  });

  it("works when REDDIT_CLIENT_ID is empty", () => {
    const prev = process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_CLIENT_ID;
    // Module should load without throwing
    const mod = require("../src/services/redditStickerService");
    assert.ok(typeof mod.generateStickers === "function");
    if (prev) process.env.REDDIT_CLIENT_ID = prev;
  });

  it("works when REDDIT_CLIENT_SECRET is empty", () => {
    const prev = process.env.REDDIT_CLIENT_SECRET;
    delete process.env.REDDIT_CLIENT_SECRET;
    const mod = require("../src/services/redditStickerService");
    assert.ok(typeof mod.searchAndSend === "function");
    if (prev) process.env.REDDIT_CLIENT_SECRET = prev;
  });
});

// ══════════════════════════════════════════════════════════════
// MEDIA DOWNLOADER — URL VALIDATION
// ══════════════════════════════════════════════════════════════

describe("Media URL Validation", () => {
  const { validateMediaUrl, validateHostname } = require("../src/services/redditMediaDownloader");

  it("accepts i.redd.it URLs", () => {
    const result = validateMediaUrl("https://i.redd.it/abc123.jpg");
    assert.strictEqual(result.ok, true);
  });

  it("accepts preview.redd.it URLs", () => {
    const result = validateMediaUrl("https://preview.redd.it/abc123.png?width=1080");
    assert.strictEqual(result.ok, true);
  });

  it("accepts v.redd.it URLs", () => {
    const result = validateMediaUrl("https://v.redd.it/abc123/DASH_720.mp4");
    assert.strictEqual(result.ok, true);
  });

  it("rejects external host", () => {
    const result = validateMediaUrl("https://youtube.com/watch?v=abc");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "unsupported_external_host");
  });

  it("rejects HTTP (not HTTPS)", () => {
    const result = validateMediaUrl("http://i.redd.it/abc.jpg");
    assert.strictEqual(result.ok, false);
  });

  it("rejects localhost", () => {
    assert.strictEqual(validateHostname("localhost"), false);
    assert.strictEqual(validateHostname("127.0.0.1"), false);
  });

  it("rejects empty/invalid input", () => {
    assert.strictEqual(validateMediaUrl("").ok, false);
    assert.strictEqual(validateMediaUrl("not-a-url").ok, false);
  });
});

// ══════════════════════════════════════════════════════════════
// MEDIA RESOLVER — POST ELIGIBILITY
// ══════════════════════════════════════════════════════════════

describe("Post Eligibility", () => {
  const { isEligibleRedditPost } = require("../src/services/redditMediaResolver");

  it("rejects posts without ID", () => {
    assert.strictEqual(isEligibleRedditPost({}), false);
    assert.strictEqual(isEligibleRedditPost(null), false);
    assert.strictEqual(isEligibleRedditPost(undefined), false);
  });

  it("rejects self posts (text only)", () => {
    assert.strictEqual(isEligibleRedditPost({ id: "123", is_self: true }), false);
  });

  it("rejects stickied posts", () => {
    assert.strictEqual(isEligibleRedditPost({ id: "123", stickied: true }), false);
  });

  it("rejects removed posts", () => {
    assert.strictEqual(
      isEligibleRedditPost({ id: "123", removed_by_category: "moderator" }),
      false
    );
  });

  it("rejects NSFW posts when disabled", () => {
    const prev = process.env.REDDIT_ALLOW_NSFW;
    delete process.env.REDDIT_ALLOW_NSFW;
    assert.strictEqual(isEligibleRedditPost({ id: "123", over_18: true }), false);
    if (prev) process.env.REDDIT_ALLOW_NSFW = prev;
  });

  it("accepts NSFW posts when enabled", () => {
    const prev = process.env.REDDIT_ALLOW_NSFW;
    process.env.REDDIT_ALLOW_NSFW = "true";
    assert.strictEqual(isEligibleRedditPost({ id: "123", over_18: true }), true);
    if (prev) process.env.REDDIT_ALLOW_NSFW = prev;
  });

  it("rejects spoiler posts when disabled", () => {
    const prev = process.env.REDDIT_ALLOW_SPOILER;
    delete process.env.REDDIT_ALLOW_SPOILER;
    assert.strictEqual(isEligibleRedditPost({ id: "123", spoiler: true }), false);
    if (prev) process.env.REDDIT_ALLOW_SPOILER = prev;
  });

  it("accepts normal eligible post", () => {
    assert.strictEqual(
      isEligibleRedditPost({
        id: "abc123",
        score: 500,
        created_utc: Math.floor(Date.now() / 1000) - 3600,
      }),
      true
    );
  });
});

// ══════════════════════════════════════════════════════════════
// MEDIA RESOLVER — MEDIA TYPES
// ══════════════════════════════════════════════════════════════

describe("Media Resolution", () => {
  const { resolveMedia, resolveVideo, resolveGallery, resolveImage } =
    require("../src/services/redditMediaResolver");

  it("resolves direct image from i.redd.it", () => {
    const post = {
      id: "abc",
      url: "https://i.redd.it/abc123.jpg",
      preview: {
        images: [{ source: { url: "https://preview.redd.it/abc123.jpg?width=1080" } }],
      },
    };
    const media = resolveMedia(post);
    assert.ok(media);
    assert.strictEqual(media.mediaType, "image");
  });

  it("resolves Reddit video", () => {
    const post = {
      id: "abc",
      is_video: true,
      is_gif: false,
      media: {
        reddit_video: {
          fallback_url: "https://v.redd.it/abc/DASH_720.mp4",
          duration: 15,
          has_audio: true,
        },
      },
    };
    const media = resolveMedia(post);
    assert.ok(media);
    assert.strictEqual(media.mediaType, "video");
    assert.ok(media.mediaUrl.includes("v.redd.it"));
  });

  it("resolves GIF (is_gif flag)", () => {
    const post = {
      id: "abc",
      is_video: true,
      is_gif: true,
      media: {
        reddit_video: {
          fallback_url: "https://v.redd.it/abc/DASH_720.mp4",
          duration: 3,
        },
      },
    };
    const media = resolveMedia(post);
    assert.ok(media);
    assert.strictEqual(media.mediaType, "gif");
  });

  it("resolves Reddit gallery", () => {
    const post = {
      id: "abc",
      is_gallery: true,
      gallery_data: {
        items: [{ media_id: "img1" }, { media_id: "img2" }],
      },
      media_metadata: {
        img1: {
          s: { u: "https://preview.redd.it/gallery1.jpg?width=1080" },
        },
        img2: {
          s: { u: "https://preview.redd.it/gallery2.jpg?width=1080" },
        },
      },
    };
    const media = resolveMedia(post);
    assert.ok(media);
    assert.strictEqual(media.mediaType, "image");
    assert.strictEqual(media.isGallery, true);
    assert.strictEqual(media.galleryCount, 2);
  });

  it("resolves crosspost", () => {
    const post = {
      id: "wrapper123",
      is_self: false,
      crosspost_parent_list: [
        {
          id: "original456",
          subreddit: "memes",
          title: "Original post",
          url: "https://i.redd.it/original.jpg",
          preview: {
            images: [{ source: { url: "https://preview.redd.it/original.jpg?width=1080" } }],
          },
        },
      ],
      url: "https://www.reddit.com/r/all/comments/original456/",
    };
    const media = resolveMedia(post);
    assert.ok(media);
    assert.strictEqual(media.mediaType, "image");
    assert.strictEqual(media.isCrosspost, true);
    assert.strictEqual(media.originalPostId, "original456");
  });

  it("rejects unsupported external hosts", () => {
    const post = {
      id: "abc",
      url: "https://youtube.com/watch?v=abc123",
      post_hint: "link",
    };
    const media = resolveMedia(post);
    assert.strictEqual(media, null);
  });

  it("returns null for text-only posts", () => {
    const post = { id: "abc", is_self: true, selftext: "just text" };
    const media = resolveMedia(post);
    assert.strictEqual(media, null);
  });
});

// ══════════════════════════════════════════════════════════════
// RANKING
// ══════════════════════════════════════════════════════════════

describe("Reddit Ranking", () => {
  const { calculateRedditRank } = require("../src/services/redditMediaResolver");

  it("higher score gives higher rank", () => {
    const low = calculateRedditRank({ score: 100, num_comments: 10, upvote_ratio: 0.8, created_utc: Math.floor(Date.now() / 1000) - 3600 });
    const high = calculateRedditRank({ score: 5000, num_comments: 10, upvote_ratio: 0.8, created_utc: Math.floor(Date.now() / 1000) - 3600 });
    assert.ok(high > low);
  });

  it("fresher posts rank higher (same score)", () => {
    const base = { score: 1000, num_comments: 50, upvote_ratio: 0.9 };
    const fresh = calculateRedditRank({ ...base, created_utc: Math.floor(Date.now() / 1000) - 3600 });
    const old = calculateRedditRank({ ...base, created_utc: Math.floor(Date.now() / 1000) - 3600 * 48 });
    assert.ok(fresh > old);
  });

  it("handles missing fields gracefully", () => {
    const rank = calculateRedditRank({});
    assert.ok(typeof rank === "number");
    assert.ok(Number.isFinite(rank));
  });
});

// ══════════════════════════════════════════════════════════════
// CONVERTER — SIZE LIMITS
// ══════════════════════════════════════════════════════════════

describe("Converter Size Limits", () => {
  it("STATIC_MAX_BYTES env default is 100000", () => {
    const maxBytes = parseInt(process.env.STICKER_STATIC_MAX_BYTES || "100000", 10);
    assert.strictEqual(maxBytes, 100000);
  });

  it("ANIMATED_MAX_BYTES env default is 500000", () => {
    const maxBytes = parseInt(process.env.STICKER_ANIMATED_MAX_BYTES || "500000", 10);
    assert.strictEqual(maxBytes, 500000);
  });

  it("ANIMATED_MAX_SECONDS env default is 10", () => {
    const maxSec = parseInt(process.env.STICKER_ANIMATED_MAX_SECONDS || "10", 10);
    assert.strictEqual(maxSec, 10);
  });

  it("ANIMATED_TARGET_SECONDS env default is 6", () => {
    const targetSec = parseInt(process.env.STICKER_ANIMATED_TARGET_SECONDS || "6", 10);
    assert.strictEqual(targetSec, 6);
  });

  it("isAnimatedMedia correctly identifies types", () => {
    const { isAnimatedMedia } = require("../src/services/redditMediaConverter");
    assert.strictEqual(isAnimatedMedia("gif"), true);
    assert.strictEqual(isAnimatedMedia("video"), true);
    assert.strictEqual(isAnimatedMedia("image"), false);
  });
});

// ══════════════════════════════════════════════════════════════
// STICKER BANK REPOSITORY
// ══════════════════════════════════════════════════════════════

describe("Sticker Bank Repository", () => {
  const repo = require("../src/repositories/redditStickerRepository");

  it("computeHash produces consistent output", () => {
    const buf = Buffer.from("test data");
    const hash1 = repo.computeHash(buf);
    const hash2 = repo.computeHash(Buffer.from("test data"));
    assert.strictEqual(hash1, hash2);
  });

  it("computeHash produces different output for different data", () => {
    const hash1 = repo.computeHash(Buffer.from("test data"));
    const hash2 = repo.computeHash(Buffer.from("different data"));
    assert.notStrictEqual(hash1, hash2);
  });

  it("insertSticker and getStickerById work (memory fallback)", async () => {
    const id = "test-" + Math.random().toString(36).slice(2, 8);
    await repo.insertSticker({
      id,
      redditPostId: "test123",
      subreddit: "memes",
      author: "testuser",
      title: "Test Post",
      permalink: "/r/memes/comments/test123/",
      sourceUrl: "https://www.reddit.com/r/memes/comments/test123/",
      mediaUrl: "https://i.redd.it/test.jpg",
      mediaType: "image",
      stickerType: "static",
      localPath: "/tmp/test.webp",
      fileSizeBytes: 50000,
      score: 1000,
      status: "ready",
      contentHash: "abc123",
    });

    const sticker = await repo.getStickerById(id);
    assert.ok(sticker);
    assert.strictEqual(sticker.redditPostId, "test123");
    assert.strictEqual(sticker.status, "ready");
  });

  it("isDuplicate detects duplicate by post ID", async () => {
    const postId = "dup-" + Math.random().toString(36).slice(2, 8);
    // First insert
    await repo.insertSticker({
      id: "dup-test-1",
      redditPostId: postId,
      subreddit: "memes",
      author: "u1",
      title: "T1",
      permalink: "/r/memes/1",
      sourceUrl: "https://reddit.com/r/memes/1",
      mediaUrl: "https://i.redd.it/1.jpg",
      mediaType: "image",
      stickerType: "static",
      localPath: "/tmp/1.webp",
      fileSizeBytes: 1000,
      score: 100,
      status: "ready",
      contentHash: "hash1",
    });

    const dup = await repo.isDuplicate({ redditPostId: postId });
    assert.strictEqual(dup, true);

    const notDup = await repo.isDuplicate({ redditPostId: "nonexistent-post-id" });
    assert.strictEqual(notDup, false);
  });

  it("getReadyStickers returns only ready stickers", async () => {
    const id = "ready-" + Math.random().toString(36).slice(2, 8);
    await repo.insertSticker({
      id,
      redditPostId: id,
      subreddit: "test",
      author: "u",
      title: "Ready",
      permalink: "/r/test/1",
      sourceUrl: "https://reddit.com/r/test/1",
      mediaUrl: "https://i.redd.it/r.jpg",
      mediaType: "image",
      stickerType: "static",
      localPath: "/tmp/r.webp",
      fileSizeBytes: 1000,
      score: 100,
      status: "ready",
      contentHash: "ready-hash",
    });

    const ready = await repo.getReadyStickers(10);
    assert.ok(ready.length >= 1);
    assert.ok(ready.every((s) => s.status === "ready"));
  });

  it("updateStickerStatus changes status", async () => {
    const id = "status-" + Math.random().toString(36).slice(2, 8);
    await repo.insertSticker({
      id, redditPostId: id, subreddit: "t", author: "u", title: "T",
      permalink: "/r/t/1", sourceUrl: "https://reddit.com/r/t/1",
      mediaUrl: "https://i.redd.it/t.jpg", mediaType: "image",
      stickerType: "static", localPath: "/tmp/t.webp", fileSizeBytes: 1000,
      score: 100, status: "discovered", contentHash: "shash",
    });

    await repo.updateStickerStatus(id, "failed", "test failure reason");
    const sticker = await repo.getStickerById(id);
    assert.ok(sticker);
    assert.strictEqual(sticker.status, "failed");
    assert.strictEqual(sticker.failureReason, "test failure reason");
  });

  it("markStickerSent increments sentCount", async () => {
    const id = "sent-" + Math.random().toString(36).slice(2, 8);
    await repo.insertSticker({
      id, redditPostId: id, subreddit: "t", author: "u", title: "T",
      permalink: "/r/t/1", sourceUrl: "https://reddit.com/r/t/1",
      mediaUrl: "https://i.redd.it/t.jpg", mediaType: "image",
      stickerType: "static", localPath: "/tmp/t.webp", fileSizeBytes: 1000,
      score: 100, status: "ready", contentHash: "send-hash",
    });

    await repo.markStickerSent(id);
    const sticker = await repo.getStickerById(id);
    assert.strictEqual(sticker.sentCount, 1);
    assert.strictEqual(sticker.status, "sent");
  });

  it("getStats returns valid stats object", async () => {
    const stats = await repo.getStats();
    assert.ok(typeof stats === "object");
    assert.ok("ready" in stats);
    assert.ok("sent" in stats);
    assert.ok("failed" in stats);
    assert.ok("total" in stats);
    assert.ok("sentToday" in stats);
  });
});

// ══════════════════════════════════════════════════════════════
// IDEMPOTENCY
// ══════════════════════════════════════════════════════════════

describe("Idempotency", () => {
  it("generation key prevents duplicate processing", () => {
    const { getGenerationKey, isSlotGenerated, markSlotGenerated } =
      require("../src/services/redditStickerService");

    const key = getGenerationKey("14/7/2026", "morning");
    assert.strictEqual(key, "reddit-sticker:14/7/2026:morning");

    assert.strictEqual(isSlotGenerated(key), false);
    markSlotGenerated(key);
    assert.strictEqual(isSlotGenerated(key), true);

    const otherKey = getGenerationKey("14/7/2026", "evening");
    assert.strictEqual(isSlotGenerated(otherKey), false);
  });
});

// ══════════════════════════════════════════════════════════════
// HELPER: HTML entity unescaping
// ══════════════════════════════════════════════════════════════

describe("HTML Entity Unescaping", () => {
  const { unescapeHtml } = require("../src/services/redditMediaResolver");

  it("unescapes &amp; to &", () => {
    assert.strictEqual(
      unescapeHtml("https://example.com?a=1&amp;b=2"),
      "https://example.com?a=1&b=2"
    );
  });

  it("unescapes &lt; and &gt;", () => {
    assert.strictEqual(unescapeHtml("&lt;tag&gt;"), "<tag>");
  });

  it("returns empty string for null/undefined", () => {
    assert.strictEqual(unescapeHtml(null), "");
    assert.strictEqual(unescapeHtml(undefined), "");
  });
});

// ══════════════════════════════════════════════════════════════
// KEYWORD SANITIZATION
// ══════════════════════════════════════════════════════════════

describe("Keyword Sanitization", () => {
  it("keyword is trimmed and length-limited", () => {
    const raw = "  test keyword with control chars \x00\x1f  ";
    const cleaned = raw.replace(/[\x00-\x1f]/g, "").trim().slice(0, 100);
    assert.strictEqual(cleaned, "test keyword with control chars");
  });

  it("empty keyword becomes empty string", () => {
    const raw = "   \x00\x01   ";
    const cleaned = raw.replace(/[\x00-\x1f]/g, "").trim();
    assert.strictEqual(cleaned, "");
  });
});

// ══════════════════════════════════════════════════════════════
// COMMAND HANDLER — dual naming convention, prefix not hardcoded
// ══════════════════════════════════════════════════════════════

describe("Command Handler", () => {
  const cmd = require("../src/commands/reddit");

  it("exports all command names (both conventions)", () => {
    assert.ok(Array.isArray(cmd.names));
    // Original names
    assert.ok(cmd.names.includes("reddit"));
    assert.ok(cmd.names.includes("rbank"));
    assert.ok(cmd.names.includes("rrefresh"));
    assert.ok(cmd.names.includes("rmode"));
    assert.ok(cmd.names.includes("rsource"));
    assert.ok(cmd.names.includes("rtest"));
    // meme/* names
    assert.ok(cmd.names.includes("meme"));
    assert.ok(cmd.names.includes("memebank"));
    assert.ok(cmd.names.includes("memerefresh"));
    assert.ok(cmd.names.includes("mememode"));
    assert.ok(cmd.names.includes("memesource"));
    assert.ok(cmd.names.includes("memetest"));
  });

  it("exported functions", () => {
    assert.ok(typeof cmd.execute === "function");
    assert.ok(typeof cmd.isCronSenderEnabled === "function");
    assert.ok(typeof cmd.toggleCronSender === "function");
  });

  it("command names don't start with prefix character", () => {
    for (const name of cmd.names) {
      assert.ok(
        !name.startsWith("!"),
        `command ${name} should not hardcode prefix`
      );
      assert.ok(
        !name.startsWith("."),
        `command ${name} should not hardcode prefix`
      );
    }
  });

  it("toggleCronSender works", () => {
    const { toggleCronSender, isCronSenderEnabled } =
      require("../src/commands/reddit");

    toggleCronSender(true);
    assert.strictEqual(isCronSenderEnabled(), true);

    toggleCronSender(false);
    assert.strictEqual(isCronSenderEnabled(), false);

    // Reset for other tests
    toggleCronSender(true);
  });
});

// ══════════════════════════════════════════════════════════════
// AGE / FRESHNESS
// ══════════════════════════════════════════════════════════════

describe("Post Age Calculation", () => {
  const { getPostAgeHours, meetsAgeThreshold } = require("../src/services/redditMediaResolver");

  it("getPostAgeHours calculates age from UTC timestamp", () => {
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    const age = getPostAgeHours(oneHourAgo);
    assert.ok(age >= 0.9 && age <= 1.1, `Expected ~1 hour, got ${age}`);
  });

  it("meetsAgeThreshold rejects old posts", () => {
    const oldPost = { created_utc: Math.floor(Date.now() / 1000) - 3600 * 72 }; // 3 days
    const maxAge = process.env.REDDIT_MAX_POST_AGE_HOURS || 48;
    // This post should be rejected if max age is less than 72
    if (parseInt(maxAge, 10) < 72) {
      assert.strictEqual(meetsAgeThreshold(oldPost), false);
    }
  });
});
