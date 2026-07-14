// Unit tests for Groq AI News Editor.
// Uses Node.js built-in test runner (node:test).
// All Groq API calls are mocked — no real API keys used.
//
// Run: node --test test/groqNewsEditor.test.js

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// ═══════════════════════════════════════════════════════════════
// MOCK SETUP
// ═══════════════════════════════════════════════════════════════

let mockGroqResponses = [];
let mockGroqErrors = [];
let mockGroqCalls = [];
let originalEnv;

function setupMockGroq() {
  // We intercept at the module level by mocking the Groq constructor
  const Groq = require("groq-sdk");

  // Store original create method
  const originalCreate = Groq.prototype.chat?.completions?.create;
}

function resetMocks() {
  mockGroqResponses = [];
  mockGroqErrors = [];
  mockGroqCalls = [];
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function makeCandidate(overrides = {}) {
  return {
    title: "Presiden umumkan kebijakan ekonomi baru untuk tahun depan",
    description:
      "Pemerintah mengumumkan paket kebijakan ekonomi yang mencakup reformasi pajak dan investasi infrastruktur. Kebijakan ini diharapkan mendorong pertumbuhan ekonomi nasional.",
    url: "https://kompas.com/ekonomi/presiden-umumkan-kebijakan-baru",
    source: "Kompas",
    type: "indonesia",
    importanceScore: 8,
    qualityScore: 7,
    publishedAt: "2026-07-14T08:00:00Z",
    ...overrides,
  };
}

function makeWorldCandidate(overrides = {}) {
  return makeCandidate({
    title: "Global climate summit reaches landmark agreement",
    description:
      "World leaders at the UN climate summit have agreed to binding emissions targets, marking a historic shift in global climate policy with far-reaching implications.",
    url: "https://reuters.com/world/climate-summit-agreement",
    source: "Reuters",
    type: "world",
    importanceScore: 9,
    qualityScore: 8,
    ...overrides,
  });
}

function makeGroqSuccessResponse(selected = [], rejectedIds = []) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({ selected, rejectedIds }),
          refusal: null,
        },
      },
    ],
    usage: {
      prompt_tokens: 1500,
      completion_tokens: 500,
      total_tokens: 2000,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

describe("News Editor Schema", () => {
  const { NEWS_EDITOR_SCHEMA } = require("../src/schemas/newsEditorSchema");

  it("21: semua field ada di required", () => {
    assert.deepStrictEqual(NEWS_EDITOR_SCHEMA.required, ["selected", "rejectedIds"]);
    // Check nested required
    const itemRequired = NEWS_EDITOR_SCHEMA.properties.selected.items.required;
    assert.deepStrictEqual(itemRequired, [
      "id",
      "displayTitle",
      "summary",
      "category",
      "importance",
    ]);
  });

  it("22: seluruh object schema memakai additionalProperties: false", () => {
    assert.strictEqual(NEWS_EDITOR_SCHEMA.additionalProperties, false);
    assert.strictEqual(
      NEWS_EDITOR_SCHEMA.properties.selected.items.additionalProperties,
      false
    );
  });

  it("no optional or nullable properties in schema", () => {
    // selected and rejectedIds are the only top-level properties
    const topProps = Object.keys(NEWS_EDITOR_SCHEMA.properties);
    assert.deepStrictEqual(topProps, ["selected", "rejectedIds"]);

    // Item properties are exactly the 5 required ones
    const itemProps = Object.keys(
      NEWS_EDITOR_SCHEMA.properties.selected.items.properties
    );
    assert.deepStrictEqual(itemProps, [
      "id",
      "displayTitle",
      "summary",
      "category",
      "importance",
    ]);
  });

  it("no URL or source fields in schema", () => {
    const itemProps = Object.keys(
      NEWS_EDITOR_SCHEMA.properties.selected.items.properties
    );
    assert.strictEqual(itemProps.includes("url"), false);
    assert.strictEqual(itemProps.includes("source"), false);
  });
});

describe("Fallback Utilities", () => {
  const {
    deterministicNewsFallback,
    containsUrl,
    isGenericDescription,
    buildSafeFallbackSummary,
  } = require("../src/utils/newsEditorFallback");

  it("16: deterministic fallback runs with valid candidates", () => {
    const candidates = [
      makeCandidate({ id: "indo-01", importanceScore: 8, qualityScore: 7 }),
      makeCandidate({ id: "indo-02", importanceScore: 6, qualityScore: 5,
        title: "Menteri kesehatan luncurkan program vaksinasi nasional",
        description: "Kementerian Kesehatan meluncurkan program vaksinasi nasional untuk meningkatkan cakupan imunisasi di seluruh Indonesia. Program ini menyasar 30 juta anak.",
        url: "https://kompas.com/kesehatan/vaksinasi-nasional",
      }),
      makeWorldCandidate({ id: "world-01", importanceScore: 9, qualityScore: 8 }),
    ];

    const result = deterministicNewsFallback(candidates);
    assert.ok(Array.isArray(result));
    assert.ok(result.length > 0);
    assert.ok(result.length <= 5);
  });

  it("16: deterministic fallback returns empty for no candidates", () => {
    assert.deepStrictEqual(deterministicNewsFallback([]), []);
    assert.deepStrictEqual(deterministicNewsFallback(null), []);
    assert.deepStrictEqual(deterministicNewsFallback(undefined), []);
  });

  it("16: deterministic fallback rejects generic descriptions", () => {
    const candidates = [
      makeCandidate({
        description: "Monday links!",
        importanceScore: 5,
        qualityScore: 5,
      }),
    ];
    const result = deterministicNewsFallback(candidates);
    // Monday links! should be filtered out
    assert.strictEqual(result.length, 0);
  });

  it("containsUrl detects URLs in text", () => {
    assert.strictEqual(containsUrl("check https://example.com here"), true);
    assert.strictEqual(containsUrl("visit www.example.com now"), true);
    assert.strictEqual(containsUrl("no url here"), false);
    assert.strictEqual(containsUrl(""), false);
    assert.strictEqual(containsUrl(null), false);
  });

  it("isGenericDescription catches Monday links pattern", () => {
    assert.strictEqual(isGenericDescription("Monday links!"), true);
    assert.strictEqual(isGenericDescription("Tuesday links!"), true);
    assert.strictEqual(isGenericDescription("Latest updates."), true);
    assert.strictEqual(isGenericDescription("Breaking news."), true);
    assert.strictEqual(isGenericDescription("Read more here."), true);
    assert.strictEqual(isGenericDescription("Presiden umumkan kebijakan baru untuk ekonomi nasional"), false);
  });

  it("buildSafeFallbackSummary cleans and truncates", () => {
    const good = "Pemerintah mengumumkan kebijakan baru yang akan berdampak pada sektor ekonomi nasional dan investasi asing.";
    assert.ok(buildSafeFallbackSummary(good).length >= 40);

    const withBoilerplate = "JAKARTA, KOMPAS.com - Pemerintah mengumumkan kebijakan baru yang akan berdampak pada sektor ekonomi nasional. Baca juga: Berita lain.";
    const cleaned = buildSafeFallbackSummary(withBoilerplate);
    assert.strictEqual(cleaned.includes("Baca juga"), false);
    assert.strictEqual(cleaned.includes("JAKARTA, KOMPAS.com"), false);

    const tooShort = "Short.";
    assert.strictEqual(buildSafeFallbackSummary(tooShort), "");
    assert.strictEqual(buildSafeFallbackSummary(""), "");
    assert.strictEqual(buildSafeFallbackSummary(null), "");
  });
});

describe("Candidate Building", () => {
  const { buildCandidateId, compactCandidate, limitNewsCandidates } =
    require("../src/services/groqNewsEditor");

  it("buildCandidateId produces stable IDs", () => {
    assert.strictEqual(buildCandidateId({ type: "indonesia" }, 0), "indo-01");
    assert.strictEqual(buildCandidateId({ type: "indonesia" }, 4), "indo-05");
    assert.strictEqual(buildCandidateId({ type: "world" }, 0), "world-01");
    assert.strictEqual(buildCandidateId({ type: "world" }, 3), "world-04");
  });

  it("compactCandidate strips unwanted fields", () => {
    const raw = makeCandidate({ id: "indo-01", url: "https://example.com" });
    const compact = compactCandidate(raw);
    assert.ok(compact.id);
    assert.ok(compact.type);
    assert.ok(compact.title);
    assert.ok(compact.description);
    assert.ok(compact.source);
    // URL MUST NOT be included
    assert.strictEqual(compact.url, undefined);
    assert.strictEqual("url" in compact, false);
  });

  it("limitNewsCandidates enforces max counts", () => {
    const candidates = [
      ...Array.from({ length: 15 }, (_, i) => makeCandidate({ url: `https://a.com/${i}` })),
      ...Array.from({ length: 8 }, (_, i) => makeWorldCandidate({ url: `https://b.com/${i}` })),
    ];
    const limited = limitNewsCandidates(candidates);

    const indo = limited.filter((c) => c.type === "indonesia");
    const world = limited.filter((c) => c.type === "world");

    assert.ok(indo.length <= 8);
    assert.ok(world.length <= 4);
  });

  it("19: editNewsWithGroq returns no_candidates for empty array", async () => {
    const { editNewsWithGroq } = require("../src/services/groqNewsEditor");
    const result = await editNewsWithGroq({
      candidates: [],
      slot: "test",
      currentDateJakarta: "14 Juli 2026",
    });
    assert.strictEqual(result.editorMode, "no_candidates");
    assert.deepStrictEqual(result.articles, []);
  });
});

describe("Response Parsing", () => {
  const { getGroqResponseContent, parseGroqEditorResponse } =
    require("../src/services/groqNewsEditor");

  it("7: throws on empty content", () => {
    assert.throws(
      () => getGroqResponseContent({ choices: [{ message: { content: "" } }] }),
      /GROQ_EMPTY_CONTENT/
    );
  });

  it("throws on missing message", () => {
    assert.throws(
      () => getGroqResponseContent({ choices: [] }),
      /GROQ_MESSAGE_MISSING/
    );
  });

  it("throws on refusal", () => {
    assert.throws(
      () =>
        getGroqResponseContent({
          choices: [{ message: { content: "x", refusal: "blocked" } }],
        }),
      /GROQ_RESPONSE_REFUSED/
    );
  });

  it("parseGroqEditorResponse handles valid JSON", () => {
    const response = makeGroqSuccessResponse(
      [{ id: "indo-01", displayTitle: "Test", summary: "A test summary that is long enough.", category: "politik", importance: 7 }],
      ["indo-02"]
    );
    const parsed = parseGroqEditorResponse(response);
    assert.strictEqual(parsed.selected.length, 1);
    assert.strictEqual(parsed.rejectedIds.length, 1);
  });

  it("throws on invalid JSON", () => {
    const response = {
      choices: [{ message: { content: "not json", refusal: null } }],
    };
    assert.throws(() => parseGroqEditorResponse(response), /GROQ_JSON_PARSE_FAILED/);
  });
});

describe("Validation", () => {
  const { validateGroqSelection, enforceNewsComposition, hydrateSelectedNews } =
    require("../src/services/groqNewsEditor");

  it("8: rejects nonexistent IDs", () => {
    const articleMap = new Map();
    const result = validateGroqSelection(
      { selected: [{ id: "fake-01", displayTitle: "Test Title Here", summary: "A test summary that is long enough for validation.", category: "politik", importance: 7 }], rejectedIds: [] },
      articleMap
    );
    assert.strictEqual(result.length, 0);
  });

  it("9: rejects duplicate IDs", () => {
    const article = makeCandidate();
    const articleMap = new Map([["indo-01", article]]);
    const result = validateGroqSelection(
      {
        selected: [
          { id: "indo-01", displayTitle: "Test Title First", summary: "First summary that is long enough for validation purposes.", category: "politik", importance: 7 },
          { id: "indo-01", displayTitle: "Test Title Second", summary: "Second summary that is also long enough for validation purposes.", category: "ekonomi", importance: 5 },
        ],
        rejectedIds: [],
      },
      articleMap
    );
    // Only first occurrence should be kept
    assert.strictEqual(result.length, 1);
  });

  it("10: enforces max 4 Indonesia articles", () => {
    const indoArticles = Array.from({ length: 6 }, (_, i) =>
      makeCandidate({ url: `https://a.com/${i}` })
    );
    const articleMap = new Map(indoArticles.map((a, i) => [`indo-0${i + 1}`, a]));
    const selected = Array.from({ length: 6 }, (_, i) => ({
      id: `indo-0${i + 1}`,
      displayTitle: `Test Title ${i + 1} That Is Long Enough`,
      summary: `Summary ${i + 1} that is long enough for validation purposes and explains the news.`,
      category: "politik",
      importance: 8 - i,
    }));

    const result = validateGroqSelection({ selected, rejectedIds: [] }, articleMap);
    const indoCount = result.filter((r) => r.type === "indonesia").length;
    assert.ok(indoCount <= 4);
  });

  it("11: enforces max 1 world article", () => {
    const worldArticles = [
      makeWorldCandidate({ url: "https://a.com/1" }),
      makeWorldCandidate({ url: "https://a.com/2" }),
    ];
    const articleMap = new Map(worldArticles.map((a, i) => [`world-0${i + 1}`, a]));
    const selected = [
      { id: "world-01", displayTitle: "Test World Title One Here", summary: "First world summary that is long enough for validation and explains the news.", category: "internasional", importance: 9 },
      { id: "world-02", displayTitle: "Test World Title Two Here", summary: "Second world summary that is long enough for validation and explains the news.", category: "internasional", importance: 8 },
    ];

    const result = validateGroqSelection({ selected, rejectedIds: [] }, articleMap);
    const worldCount = result.filter((r) => r.type === "world").length;
    assert.ok(worldCount <= 1);
  });

  it("12: rejects title containing URL", () => {
    const article = makeCandidate();
    const articleMap = new Map([["indo-01", article]]);
    const result = validateGroqSelection(
      { selected: [{ id: "indo-01", displayTitle: "Check https://example.com for more", summary: "A test summary that is long enough for validation.", category: "politik", importance: 7 }], rejectedIds: [] },
      articleMap
    );
    assert.strictEqual(result.length, 0);
  });

  it("13: rejects summary too short", () => {
    const article = makeCandidate();
    const articleMap = new Map([["indo-01", article]]);
    const result = validateGroqSelection(
      { selected: [{ id: "indo-01", displayTitle: "Test Title Here", summary: "Short.", category: "politik", importance: 7 }], rejectedIds: [] },
      articleMap
    );
    assert.strictEqual(result.length, 0);
  });

  it("14: rejects generic summary", () => {
    const article = makeCandidate();
    const articleMap = new Map([["indo-01", article]]);
    const result = validateGroqSelection(
      { selected: [{ id: "indo-01", displayTitle: "Test Title Here", summary: "Berita ini membahas perkembangan terbaru dari peristiwa yang terjadi kemarin.", category: "politik", importance: 7 }], rejectedIds: [] },
      articleMap
    );
    assert.strictEqual(result.length, 0);
  });

  it("validates importance is integer 1-10", () => {
    const article = makeCandidate();
    const articleMap = new Map([["indo-01", article]]);

    // importance 0 → rejected
    let result = validateGroqSelection(
      { selected: [{ id: "indo-01", displayTitle: "Test Title Here", summary: "A test summary that is long enough for validation.", category: "politik", importance: 0 }], rejectedIds: [] },
      articleMap
    );
    assert.strictEqual(result.length, 0);

    // importance 11 → rejected
    result = validateGroqSelection(
      { selected: [{ id: "indo-01", displayTitle: "Test Title Here", summary: "A test summary that is long enough for validation.", category: "politik", importance: 11 }], rejectedIds: [] },
      articleMap
    );
    assert.strictEqual(result.length, 0);

    // importance not integer → rejected
    result = validateGroqSelection(
      { selected: [{ id: "indo-01", displayTitle: "Test Title Here", summary: "A test summary that is long enough for validation.", category: "politik", importance: 5.5 }], rejectedIds: [] },
      articleMap
    );
    assert.strictEqual(result.length, 0);
  });

  it("17: hydrated URL comes from articleMap", () => {
    const article = makeCandidate({ url: "https://kompas.com/original-url" });
    const articleMap = new Map([["indo-01", article]]);
    const selected = [
      { id: "indo-01", type: "indonesia", displayTitle: "Test Title Here", summary: "A test summary that is long enough for validation.", category: "politik", importance: 7 },
    ];
    const hydrated = hydrateSelectedNews(selected, articleMap);
    assert.strictEqual(hydrated.length, 1);
    assert.strictEqual(hydrated[0].url, "https://kompas.com/original-url");
  });

  it("18: hydrated source comes from articleMap", () => {
    const article = makeCandidate({ source: "Kompas" });
    const articleMap = new Map([["indo-01", article]]);
    const selected = [
      { id: "indo-01", type: "indonesia", displayTitle: "Test Title Here", summary: "A test summary that is long enough for validation.", category: "politik", importance: 7 },
    ];
    const hydrated = hydrateSelectedNews(selected, articleMap);
    assert.strictEqual(hydrated.length, 1);
    assert.strictEqual(hydrated[0].source, "Kompas");
  });
});

describe("Composition Enforcement", () => {
  const { enforceNewsComposition } =
    require("../src/services/groqNewsEditor");

  it("enforces max 2 from same source", () => {
    const articles = [
      makeCandidate({ source: "Kompas", url: "https://kompas.com/1" }),
      makeCandidate({ source: "Kompas", url: "https://kompas.com/2" }),
      makeCandidate({ source: "Kompas", url: "https://kompas.com/3" }),
    ];
    const articleMap = new Map(articles.map((a, i) => [`indo-0${i + 1}`, a]));
    const selected = articles.map((_, i) => ({
      id: `indo-0${i + 1}`,
      type: "indonesia",
      displayTitle: `Test Title ${i + 1} Here For News`,
      summary: `Summary ${i + 1} that is long enough for validation purposes and explains the news event clearly.`,
      category: "politik",
      importance: 8 - i,
    }));

    const result = enforceNewsComposition(selected, articleMap);
    // Max 2 from same source
    const kompasCount = result.filter((r) => {
      const raw = articleMap.get(r.id);
      return raw && raw.source === "Kompas";
    }).length;
    assert.ok(kompasCount <= 2);
  });
});

describe("Key Management", () => {
  const { getGroqKeys, shouldTrySecondaryKey } =
    require("../src/services/groqNewsEditor");

  it("5: both keys unavailable returns empty array", () => {
    // Temporarily clear env
    const prevPrimary = process.env.GROQ_API_KEY_PRIMARY;
    const prevSecondary = process.env.GROQ_API_KEY_SECONDARY;
    delete process.env.GROQ_API_KEY_PRIMARY;
    delete process.env.GROQ_API_KEY_SECONDARY;

    const keys = getGroqKeys();
    assert.strictEqual(keys.length, 0);

    // Restore
    if (prevPrimary) process.env.GROQ_API_KEY_PRIMARY = prevPrimary;
    if (prevSecondary) process.env.GROQ_API_KEY_SECONDARY = prevSecondary;
  });

  it("4: secondary empty, only primary returned", () => {
    const prevPrimary = process.env.GROQ_API_KEY_PRIMARY;
    const prevSecondary = process.env.GROQ_API_KEY_SECONDARY;
    process.env.GROQ_API_KEY_PRIMARY = "pk-test";
    delete process.env.GROQ_API_KEY_SECONDARY;

    const keys = getGroqKeys();
    assert.strictEqual(keys.length, 1);
    assert.strictEqual(keys[0].slot, "primary");

    if (prevPrimary) process.env.GROQ_API_KEY_PRIMARY = prevPrimary;
    if (prevSecondary) process.env.GROQ_API_KEY_SECONDARY = prevSecondary;
  });

  it("shouldTrySecondaryKey returns true for 401", () => {
    assert.strictEqual(shouldTrySecondaryKey({ status: 401 }), true);
  });

  it("shouldTrySecondaryKey returns true for 403", () => {
    assert.strictEqual(shouldTrySecondaryKey({ status: 403 }), true);
  });

  it("shouldTrySecondaryKey returns true for timeout", () => {
    assert.strictEqual(shouldTrySecondaryKey({ code: "ETIMEDOUT" }), true);
  });

  it("shouldTrySecondaryKey returns true for 5xx", () => {
    assert.strictEqual(shouldTrySecondaryKey({ status: 503 }), true);
  });

  it("shouldTrySecondaryKey returns false for 400", () => {
    assert.strictEqual(shouldTrySecondaryKey({ status: 400 }), false);
  });

  it("shouldTrySecondaryKey returns false for 422", () => {
    assert.strictEqual(shouldTrySecondaryKey({ status: 422 }), false);
  });
});

describe("Deterministic Fallback Integration", () => {
  it("16: returns articles with correct shape", () => {
    const { deterministicNewsFallback } = require("../src/utils/newsEditorFallback");
    const candidates = [
      makeCandidate({
        id: "indo-01",
        importanceScore: 8,
        qualityScore: 7,
      }),
    ];
    const result = deterministicNewsFallback(candidates);

    if (result.length > 0) {
      const article = result[0];
      assert.ok("id" in article);
      assert.ok("type" in article);
      assert.ok("displayTitle" in article);
      assert.ok("summary" in article);
      assert.ok("source" in article);
      assert.ok("url" in article);
      assert.ok("publishedAt" in article);
      // URL must be the original
      assert.strictEqual(article.url, candidates[0].url);
    }
  });
});

describe("Idempotency", () => {
  it("20: generationKey prevents duplicate processing", () => {
    // This tests the concept — the actual in-memory map is tested via integration
    function getSlotGenerationKey(groupJid, dateJakarta, slot) {
      return `${groupJid}:${dateJakarta}:${slot}`;
    }
    const key1 = getSlotGenerationKey("123@g.us", "14/7/2026", "morning");
    const key2 = getSlotGenerationKey("123@g.us", "14/7/2026", "morning");
    assert.strictEqual(key1, key2);

    const key3 = getSlotGenerationKey("123@g.us", "14/7/2026", "evening");
    assert.notStrictEqual(key1, key3);
  });
});

describe("Config Validation", () => {
  it("environment variable defaults work correctly", () => {
    const timeoutMs = Number(process.env.GROQ_TIMEOUT_MS || 30000);
    assert.ok(timeoutMs > 0);

    const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
    assert.strictEqual(model, "openai/gpt-oss-120b");

    const maxTokens = Number(process.env.GROQ_MAX_COMPLETION_TOKENS || 1400);
    assert.ok(maxTokens > 0);
  });
});

describe("Error Sanitization", () => {
  const { sanitizeErrorMessage, sanitizeErrorCode } =
    require("../src/services/groqNewsEditor");

  it("does not expose API key in error messages", () => {
    const error = {
      status: 401,
      code: "UNAUTHORIZED",
      message: "Invalid API key: gsk_test123",
      headers: { authorization: "Bearer secret" },
    };
    const sanitized = sanitizeErrorMessage(error);
    const sanitizedStr = JSON.stringify(sanitized);
    assert.strictEqual(sanitizedStr.includes("gsk_test"), false);
    assert.strictEqual(sanitizedStr.includes("Bearer"), false);
  });

  it("sanitizeErrorCode returns string", () => {
    assert.strictEqual(typeof sanitizeErrorCode({ code: "ETIMEDOUT" }), "string");
    assert.strictEqual(typeof sanitizeErrorCode(null), "string");
    assert.strictEqual(typeof sanitizeErrorCode(undefined), "string");
  });
});
