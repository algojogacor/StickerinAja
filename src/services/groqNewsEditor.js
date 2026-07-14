// Groq AI News Editor — selects best candidates and writes Indonesian titles/summaries.
//
// Architecture:
//   1. Candidates pass through code-level filters (existing pipeline in newsService).
//   2. Limited to 8 Indonesia + 4 World candidates.
//   3. One Groq request per slot — all candidates in a single call.
//   4. Primary key tried first, secondary only on auth/timeout/5xx.
//   5. Strict JSON Schema ensures valid output structure.
//   6. App-level validation enforces composition (4+1) and URL/source origin.
//   7. Deterministic fallback if Groq fails entirely.
//
// Groq NEVER receives URLs, HTML, phone numbers, API keys, or chat content.
// Groq NEVER produces URLs — all URLs are hydrated from the in-memory articleMap.

const Groq = require("groq-sdk");
const { NEWS_EDITOR_SYSTEM_PROMPT } = require("../prompts/newsEditorPrompt");
const { NEWS_EDITOR_SCHEMA } = require("../schemas/newsEditorSchema");
const {
  deterministicNewsFallback,
  containsUrl,
} = require("../utils/newsEditorFallback");

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

const MAX_INDONESIA_CANDIDATES = 8;
const MAX_WORLD_CANDIDATES = 4;
const MAX_INDONESIA_SELECTED = 4;
const MAX_WORLD_SELECTED = 1;
const MAX_TOTAL_SELECTED = 5;
const MAX_SAME_SOURCE = 2;
const MIN_TITLE_LENGTH = 10;
const MAX_TITLE_LENGTH = 200;
const MIN_SUMMARY_LENGTH = 40;
const MAX_SUMMARY_LENGTH = 600;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_TOKENS = 1400;
const DEFAULT_MODEL = "openai/gpt-oss-120b";

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function truncateText(text, maxLen) {
  if (!text || typeof text !== "string") return "";
  return text.length <= maxLen ? text : text.slice(0, maxLen - 3) + "...";
}

function buildCandidateId(article, index) {
  const prefix = article.type === "world" ? "world" : "indo";
  return `${prefix}-${String(index + 1).padStart(2, "0")}`;
}

function compactCandidate(article) {
  return {
    id: article.id,
    type: article.type,
    title: truncateText(article.title, 220),
    description: truncateText(article.description, 550),
    source: article.source,
    publishedAt: article.publishedAt || "",
    importanceScore: Number(article.importanceScore || 0),
    qualityScore: Number(article.qualityScore || 0),
  };
}

function sanitizeErrorMessage(error) {
  if (!error) return "unknown";
  // Don't log the full error object — it may contain headers/keys
  const status = error?.status || "";
  const code = error?.code || "";
  let message = (error?.message || "").slice(0, 200);
  // Redact any API key patterns from the message
  message = message.replace(/gsk_[A-Za-z0-9]+/g, "gsk_***");
  message = message.replace(/Bearer\s+[A-Za-z0-9\-_.]+/gi, "Bearer ***");
  message = message.replace(/api[_-]?key[=:]\s*[A-Za-z0-9\-_.]+/gi, "api_key=***");
  return { status, code, message };
}

function sanitizeErrorCode(error) {
  if (!error) return "UNKNOWN";
  return String(error?.code || error?.status || "UNKNOWN").slice(0, 100);
}

// ═══════════════════════════════════════════════════════════════
// CLIENT & KEY MANAGEMENT
// ═══════════════════════════════════════════════════════════════

function createGroqClient(apiKey) {
  if (!apiKey) {
    throw new Error("GROQ_API_KEY_MISSING");
  }

  return new Groq({ apiKey });
}

function getGroqKeys() {
  return [
    { slot: "primary", value: process.env.GROQ_API_KEY_PRIMARY },
    { slot: "secondary", value: process.env.GROQ_API_KEY_SECONDARY },
  ].filter((item) => Boolean(item.value));
}

// ═══════════════════════════════════════════════════════════════
// REQUEST
// ═══════════════════════════════════════════════════════════════

function getGroqTimeoutMs() {
  const val = Number(process.env.GROQ_TIMEOUT_MS);
  return Number.isFinite(val) && val > 0 ? val : DEFAULT_TIMEOUT_MS;
}

async function requestGroqNewsEditor({
  apiKey,
  candidates,
  slot,
  currentDateJakarta,
}) {
  const client = createGroqClient(apiKey);
  const timeoutMs = getGroqTimeoutMs();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await client.chat.completions.create(
      {
        model: process.env.GROQ_MODEL || DEFAULT_MODEL,

        messages: [
          { role: "system", content: NEWS_EDITOR_SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              task: "Pilih dan susun briefing berita berdasarkan aturan yang diberikan.",
              slot,
              currentDateJakarta,
              candidates,
            }),
          },
        ],

        response_format: {
          type: "json_schema",
          json_schema: {
            name: "news_editor_result",
            strict: true,
            schema: NEWS_EDITOR_SCHEMA,
          },
        },

        temperature: 0.1,

        max_completion_tokens: Number(
          process.env.GROQ_MAX_COMPLETION_TOKENS || DEFAULT_MAX_TOKENS
        ),
      },
      {
        signal: controller.signal,
      }
    );

    return response;
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════
// RESPONSE PARSING
// ═══════════════════════════════════════════════════════════════

function getGroqResponseContent(response) {
  const message = response?.choices?.[0]?.message;

  if (!message) {
    throw new Error("GROQ_MESSAGE_MISSING");
  }

  if (message.refusal) {
    throw new Error("GROQ_RESPONSE_REFUSED");
  }

  const content = message.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("GROQ_EMPTY_CONTENT");
  }

  return content.trim();
}

function parseGroqEditorResponse(response) {
  const content = getGroqResponseContent(response);

  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error("GROQ_JSON_PARSE_FAILED");
  }
}

// ═══════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════

function isGenericGeneratedSummary(text) {
  const normalized = (text || "").trim().toLowerCase();

  const genericPatterns = [
    /^berita ini membahas/i,
    /^perkembangan terbaru/i,
    /^informasi selengkapnya/i,
    /^berita ini menarik perhatian/i,
    /^kabar terbaru/i,
    /^simak perkembangan/i,
    /^latest updates/i,
    /^read more/i,
    /^live coverage/i,
    /^monday links/i,
  ];

  return genericPatterns.some((pattern) => pattern.test(normalized));
}

function validateGroqSelection(editorResult, articleMap) {
  if (!editorResult || typeof editorResult !== "object") {
    throw new Error("EDITOR_RESULT_INVALID");
  }

  if (!Array.isArray(editorResult.selected)) {
    throw new Error("EDITOR_SELECTED_INVALID");
  }

  if (!Array.isArray(editorResult.rejectedIds)) {
    throw new Error("EDITOR_REJECTED_INVALID");
  }

  const selected = [];
  const seenIds = new Set();

  for (const item of editorResult.selected) {
    // Must reference a real candidate
    if (!articleMap.has(item.id)) {
      continue;
    }

    // No duplicate IDs
    if (seenIds.has(item.id)) {
      continue;
    }

    const rawArticle = articleMap.get(item.id);

    const displayTitle = String(item.displayTitle || "").trim();
    const summary = String(item.summary || "").trim();

    // Length checks
    if (displayTitle.length < MIN_TITLE_LENGTH || displayTitle.length > MAX_TITLE_LENGTH) {
      continue;
    }

    if (summary.length < MIN_SUMMARY_LENGTH || summary.length > MAX_SUMMARY_LENGTH) {
      continue;
    }

    // No URLs in generated content
    if (containsUrl(displayTitle) || containsUrl(summary)) {
      continue;
    }

    // No generic filler summaries
    if (isGenericGeneratedSummary(summary)) {
      continue;
    }

    // Valid importance range
    const importance = Number(item.importance);
    if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
      continue;
    }

    seenIds.add(item.id);

    selected.push({
      id: item.id,
      type: rawArticle.type,
      displayTitle,
      summary,
      category: item.category,
      importance,
    });
  }

  return enforceNewsComposition(selected, articleMap);
}

// ═══════════════════════════════════════════════════════════════
// COMPOSITION ENFORCEMENT
// ═══════════════════════════════════════════════════════════════

function enforceNewsComposition(selected, articleMap) {
  const indonesia = [];
  const world = [];
  const sourceCount = new Map();

  // Sort by importance descending
  const sorted = [...selected].sort((a, b) => b.importance - a.importance);

  for (const item of sorted) {
    const rawArticle = articleMap.get(item.id);
    if (!rawArticle) continue;

    const source = String(rawArticle.source || "").toLowerCase();
    const count = sourceCount.get(source) || 0;

    // Max 2 from same source
    if (count >= MAX_SAME_SOURCE) {
      continue;
    }

    if (rawArticle.type === "indonesia" && indonesia.length < MAX_INDONESIA_SELECTED) {
      indonesia.push(item);
      sourceCount.set(source, count + 1);
      continue;
    }

    if (rawArticle.type === "world" && world.length < MAX_WORLD_SELECTED) {
      world.push(item);
      sourceCount.set(source, count + 1);
    }
  }

  return [...indonesia, ...world].slice(0, MAX_TOTAL_SELECTED);
}

// ═══════════════════════════════════════════════════════════════
// HYDRATION — attach raw URL/source/publishedAt to validated items
// ═══════════════════════════════════════════════════════════════

function hydrateSelectedNews(selected, articleMap) {
  return selected
    .map((item) => {
      const rawArticle = articleMap.get(item.id);
      if (!rawArticle) return null;

      return {
        id: rawArticle.id,
        type: rawArticle.type,
        displayTitle: item.displayTitle,
        summary: item.summary,
        category: item.category,
        importance: item.importance,
        // These three fields MUST come from rawArticle, NEVER from Groq
        source: rawArticle.source,
        url: rawArticle.url,
        publishedAt: rawArticle.publishedAt,
      };
    })
    .filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════
// FALLBACK KEY LOGIC
// ═══════════════════════════════════════════════════════════════

function shouldTrySecondaryKey(error) {
  const status = Number(error?.status || 0);

  // Auth / permission errors — likely key-specific
  if (status === 401 || status === 403 || status === 408 || status === 424 || status === 498) {
    return true;
  }

  // Server errors — may be transient on a different endpoint
  if (status >= 500) {
    return true;
  }

  // Network / DNS errors
  const code = String(error?.code || "").toUpperCase();
  return ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code);
}

// ═══════════════════════════════════════════════════════════════
// FALLBACK ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════

async function callGroqEditorWithFallback(payload) {
  const keys = getGroqKeys();

  if (keys.length === 0) {
    throw new Error("GROQ_KEYS_NOT_CONFIGURED");
  }

  let lastError;

  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];

    try {
      const response = await requestGroqNewsEditor({
        apiKey: key.value,
        ...payload,
      });

      return { response, keySlot: key.slot };
    } catch (error) {
      lastError = error;

      // Log without exposing the key value
      console.warn(
        JSON.stringify({
          provider: "groq",
          keySlot: key.slot,
          status: error?.status,
          code: error?.code,
          message: sanitizeErrorMessage(error),
        })
      );

      const isLastKey = index === keys.length - 1;
      if (isLastKey) break;

      // Don't try secondary for 400/404/422 — those are code bugs
      if (!shouldTrySecondaryKey(error)) break;
    }
  }

  throw lastError || new Error("GROQ_ALL_KEYS_FAILED");
}

// ═══════════════════════════════════════════════════════════════
// CANDIDATE LIMITING
// ═══════════════════════════════════════════════════════════════

function limitNewsCandidates(candidates) {
  const indonesia = [];
  const world = [];

  for (const article of candidates) {
    if (article.type === "world") {
      if (world.length < MAX_WORLD_CANDIDATES) {
        world.push(article);
      }
    } else {
      if (indonesia.length < MAX_INDONESIA_CANDIDATES) {
        indonesia.push(article);
      }
    }
  }

  // Assign stable IDs
  const withIds = [
    ...indonesia.map((a, i) => ({ ...a, id: buildCandidateId({ type: "indonesia" }, i) })),
    ...world.map((a, i) => ({ ...a, id: buildCandidateId({ type: "world" }, i) })),
  ];

  return withIds;
}

// ═══════════════════════════════════════════════════════════════
// MAIN SERVICE
// ═══════════════════════════════════════════════════════════════

async function editNewsWithGroq({ candidates, slot, currentDateJakarta, logger }) {
  if (!Array.isArray(candidates)) {
    throw new TypeError("candidates harus berupa array");
  }

  if (candidates.length === 0) {
    return { articles: [], editorMode: "no_candidates" };
  }

  const limitedCandidates = limitNewsCandidates(candidates);

  const articleMap = new Map(
    limitedCandidates.map((article) => [article.id, article])
  );

  // ── Check if editor is disabled ──
  if (process.env.GROQ_EDITOR_ENABLED === "false") {
    const fallbackResult = deterministicNewsFallback(limitedCandidates);
    logger?.info({
      provider: "groq",
      slot,
      editorMode: "deterministic_disabled",
      candidateCount: limitedCandidates.length,
      selectedCount: fallbackResult.length,
    });
    return { articles: fallbackResult, editorMode: "deterministic_disabled" };
  }

  const compactCandidates = limitedCandidates.map(compactCandidate);
  const startMs = Date.now();

  try {
    const { response, keySlot } = await callGroqEditorWithFallback({
      candidates: compactCandidates,
      slot,
      currentDateJakarta,
    });

    const parsed = parseGroqEditorResponse(response);
    const validated = validateGroqSelection(parsed, articleMap);
    const hydrated = hydrateSelectedNews(validated, articleMap);

    const latencyMs = Date.now() - startMs;

    // ── Log success ──
    logger?.info({
      provider: "groq",
      model: process.env.GROQ_MODEL || DEFAULT_MODEL,
      slot,
      editorMode: "groq_strict",
      keySlot,
      candidateCount: compactCandidates.length,
      selectedCount: hydrated.length,
      latencyMs,
      promptTokens: response?.usage?.prompt_tokens,
      completionTokens: response?.usage?.completion_tokens,
      totalTokens: response?.usage?.total_tokens,
    });

    // ── If Groq selected nothing useful, fallback ──
    if (hydrated.length === 0) {
      const fallbackResult = deterministicNewsFallback(limitedCandidates);
      logger?.warn({
        provider: "groq",
        slot,
        editorMode: "deterministic_empty_selection",
        keySlot,
        candidateCount: compactCandidates.length,
        selectedCount: fallbackResult.length,
      });
      return {
        articles: fallbackResult,
        editorMode: "deterministic_empty_selection",
        keySlot,
      };
    }

    return {
      articles: hydrated,
      editorMode: "groq_strict",
      keySlot,
      usage: response.usage || null,
    };
  } catch (error) {
    // ── Any Groq failure → deterministic fallback ──
    const latencyMs = Date.now() - startMs;

    logger?.warn({
      provider: "groq",
      slot,
      editorMode: "deterministic_fallback",
      reason: sanitizeErrorCode(error),
      latencyMs,
    });

    const fallbackResult = deterministicNewsFallback(limitedCandidates);

    logger?.info({
      provider: "groq",
      slot,
      editorMode: "deterministic_fallback",
      candidateCount: limitedCandidates.length,
      selectedCount: fallbackResult.length,
    });

    return {
      articles: fallbackResult,
      editorMode: "deterministic_fallback",
    };
  }
}

module.exports = {
  editNewsWithGroq,
  createGroqClient,
  getGroqKeys,
  requestGroqNewsEditor,
  getGroqResponseContent,
  parseGroqEditorResponse,
  validateGroqSelection,
  enforceNewsComposition,
  hydrateSelectedNews,
  callGroqEditorWithFallback,
  shouldTrySecondaryKey,
  buildCandidateId,
  compactCandidate,
  truncateText,
  limitNewsCandidates,
  sanitizeErrorMessage,
  sanitizeErrorCode,
};
