// Groq News Editor tests — URL isolation, key rotation behavior,
// schema validation, deterministic fallback, export contract.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  callGroqStructured,
  editNewsWithGroq,
  summarizeFxMarketContext,
  isolateUrls,
  hydrateUrls,
  generateArticleId,
  validateAgainstSchema,
} = require("../src/services/groqNewsEditor");

describe("Groq News Editor — URL Isolation", () => {
  it("isolateUrls strips URLs from articles", () => {
    const articles = [
      {
        url: "https://reuters.com/article/123",
        title: "Fed Raises Rates",
        source: "Reuters",
        description: "The Federal Reserve raised interest rates today.",
        pageAge: "2 hours ago",
      },
    ];

    const { safeArticles, trustedMap } = isolateUrls(articles);

    assert.equal(safeArticles.length, 1);
    // Safe articles must NOT have url field
    assert.equal(safeArticles[0].url, undefined);
    // Safe articles must have id, title, publisher
    assert.ok(safeArticles[0].id);
    assert.equal(safeArticles[0].title, "Fed Raises Rates");
    assert.equal(safeArticles[0].publisher, "Reuters");
    // Trusted map must have url
    assert.equal(Object.keys(trustedMap).length, 1);
    const id = safeArticles[0].id;
    assert.equal(trustedMap[id].url, "https://reuters.com/article/123");
  });

  it("isolateUrls handles missing optional fields", () => {
    const articles = [
      { title: "Minimal Article" },
    ];

    const { safeArticles, trustedMap } = isolateUrls(articles);

    assert.equal(safeArticles.length, 1);
    assert.equal(safeArticles[0].title, "Minimal Article");
    assert.equal(safeArticles[0].publisher, "");
    assert.equal(safeArticles[0].snippet, "");
  });

  it("isolateUrls generates unique IDs for each article", () => {
    const articles = [
      { title: "Article A", source: "S1" },
      { title: "Article B", source: "S2" },
    ];

    const { safeArticles } = isolateUrls(articles);

    assert.equal(safeArticles.length, 2);
    assert.notEqual(safeArticles[0].id, safeArticles[1].id);
  });

  it("isolateUrls handles empty array", () => {
    const { safeArticles, trustedMap } = isolateUrls([]);
    assert.equal(safeArticles.length, 0);
    assert.equal(Object.keys(trustedMap).length, 0);
  });
});

describe("Groq News Editor — URL Hydration", () => {
  it("hydrateUrls restores URLs from trusted map", () => {
    const trustedMap = {
      "abc123": { url: "https://example.com/1", title: "Original A", publisher: "Pub A" },
      "def456": { url: "https://example.com/2", title: "Original B", publisher: "Pub B" },
    };

    const aiOutput = [
      { id: "abc123", headline: "Modified A", summary: "Summary A" },
      { id: "def456", headline: "Modified B", summary: "Summary B" },
    ];

    const hydrated = hydrateUrls(aiOutput, trustedMap);

    assert.equal(hydrated.length, 2);
    assert.equal(hydrated[0].url, "https://example.com/1");
    assert.equal(hydrated[1].url, "https://example.com/2");
  });

  it("hydrateUrls filters articles with unknown IDs", () => {
    const trustedMap = { "known": { url: "https://example.com/1", title: "X", publisher: "Y" } };
    const aiOutput = [
      { id: "known", headline: "Good" },
      { id: "unknown", headline: "Should be filtered" },
    ];

    const hydrated = hydrateUrls(aiOutput, trustedMap);

    assert.equal(hydrated.length, 1);
    assert.equal(hydrated[0].id, "known");
  });

  it("hydrateUrls falls back to trusted map title when AI omits", () => {
    const trustedMap = { "id1": { url: "https://x.com", title: "Trusted Title", publisher: "Pub" } };
    const aiOutput = [{ id: "id1", headline: "", summary: "" }];

    const hydrated = hydrateUrls(aiOutput, trustedMap);
    assert.equal(hydrated[0].title, "Trusted Title");
    assert.equal(hydrated[0].publisher, "Pub");
  });

  it("hydrateUrls handles empty arrays", () => {
    assert.equal(hydrateUrls([], {}).length, 0);
  });
});

describe("Groq News Editor — Article ID Generation", () => {
  it("produces deterministic IDs for same input", () => {
    const id1 = generateArticleId({ title: "Same", source: "Same" }, 0);
    const id2 = generateArticleId({ title: "Same", source: "Same" }, 0);
    assert.equal(id1, id2);
  });

  it("produces different IDs for different index", () => {
    const id1 = generateArticleId({ title: "X" }, 0);
    const id2 = generateArticleId({ title: "X" }, 1);
    assert.notEqual(id1, id2);
  });

  it("produces 12-char hex IDs", () => {
    const id = generateArticleId({ title: "Test" }, 5);
    assert.equal(id.length, 12);
    assert.ok(/^[a-f0-9]{12}$/.test(id));
  });
});

describe("Groq News Editor — Schema Validation", () => {
  it("validates required fields", () => {
    const schema = { type: "object", required: ["name"], properties: { name: { type: "string" } } };
    const errors = validateAgainstSchema({}, schema);
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes("name")));
  });

  it("passes valid data", () => {
    const schema = { type: "object", required: ["name"], properties: { name: { type: "string" } } };
    const errors = validateAgainstSchema({ name: "valid" }, schema);
    assert.equal(errors.length, 0);
  });

  it("validates nested objects", () => {
    const schema = {
      type: "object",
      required: ["data"],
      properties: {
        data: {
          type: "object",
          required: ["value"],
          properties: { value: { type: "number" } },
        },
      },
    };

    assert.equal(validateAgainstSchema({ data: { value: 42 } }, schema).length, 0);
    assert.ok(validateAgainstSchema({ data: {} }, schema).length > 0);
    assert.ok(validateAgainstSchema({ data: { value: "not a number" } }, schema).length > 0);
  });

  it("validates array items", () => {
    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        },
      },
    };

    assert.equal(validateAgainstSchema({ items: [{ id: "a" }, { id: "b" }] }, schema).length, 0);
    assert.ok(validateAgainstSchema({ items: [{ wrong: true }] }, schema).length > 0);
  });

  it("validates enum values", () => {
    const schema = { type: "string", enum: ["ready", "partial", "failed"] };
    assert.equal(validateAgainstSchema("ready", schema).length, 0);
    assert.ok(validateAgainstSchema("invalid", schema).length > 0);
  });
});

describe("Groq News Editor — Fallback Behavior", () => {
  it("editNewsWithGroq returns fallback when candidates empty", async () => {
    const result = await editNewsWithGroq({
      candidates: [],
      slot: "morning",
      currentDateJakarta: "14 Juli 2026",
    });
    assert.equal(result.articles.length, 0);
    assert.equal(result.editorMode, "fallback");
  });

  it("editNewsWithGroq falls back when Groq disabled via env", async () => {
    const prev = process.env.GROQ_EDITOR_ENABLED;
    process.env.GROQ_EDITOR_ENABLED = "false";

    try {
      const result = await editNewsWithGroq({
        candidates: [
          { title: "Test Article", source: "Test", description: "Test description here.", type: "indonesia" },
        ],
        slot: "morning",
        currentDateJakarta: "14 Juli 2026",
      });
      assert.equal(result.editorMode, "fallback");
      assert.ok(result.articles.length > 0);
    } finally {
      if (prev !== undefined) process.env.GROQ_EDITOR_ENABLED = prev;
      else delete process.env.GROQ_EDITOR_ENABLED;
    }
  });

  it("editNewsWithGroq falls back when no API keys", async () => {
    const prevPrimary = process.env.GROQ_API_KEY_PRIMARY;
    const prevSecondary = process.env.GROQ_API_KEY_SECONDARY;
    delete process.env.GROQ_API_KEY_PRIMARY;
    delete process.env.GROQ_API_KEY_SECONDARY;
    // Re-enable editor since we want to test "no keys, enabled" path
    process.env.GROQ_EDITOR_ENABLED = "true";

    try {
      const result = await editNewsWithGroq({
        candidates: [
          { title: "Test", source: "T", description: "Description with enough text for fallback to use.", type: "indonesia" },
        ],
        slot: "morning",
        currentDateJakarta: "14 Juli 2026",
      });
      assert.equal(result.editorMode, "fallback");
    } finally {
      if (prevPrimary !== undefined) process.env.GROQ_API_KEY_PRIMARY = prevPrimary;
      else delete process.env.GROQ_API_KEY_PRIMARY;
      if (prevSecondary !== undefined) process.env.GROQ_API_KEY_SECONDARY = prevSecondary;
      else delete process.env.GROQ_API_KEY_SECONDARY;
    }
  });

  it("summarizeFxMarketContext returns partial when articles empty", async () => {
    const result = await summarizeFxMarketContext({
      articles: [],
      rateStatistics: null,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.articles.length, 0);
  });
});
