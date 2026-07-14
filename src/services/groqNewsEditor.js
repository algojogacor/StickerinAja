// Groq News Editor — shared AI module for news summarization and market context.
// Used by newsService.js (Morning/Evening news) and fxMarketContextService.js (FX context).
//
// Architecture:
//   Native fetch (no groq-sdk) → Groq Chat Completions API
//   Primary key → secondary key fallback
//   URL isolation: AI never receives article URLs
//   Deterministic fallback when Groq fails
//   Schema-validated JSON output
//   Redacted logging (no API keys)

const crypto = require("crypto");

// ── Configuration ─────────────────────────────────────────

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

function getConfig() {
  return {
    primaryKey: process.env.GROQ_API_KEY_PRIMARY || "",
    secondaryKey: process.env.GROQ_API_KEY_SECONDARY || "",
    model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
    timeoutMs: parseInt(process.env.GROQ_TIMEOUT_MS || "30000", 10),
    maxTokens: parseInt(process.env.GROQ_MAX_COMPLETION_TOKENS || "1400", 10),
    enabled: process.env.GROQ_EDITOR_ENABLED !== "false",
  };
}

// ── Helpers ───────────────────────────────────────────────

function redactKey(key) {
  if (!key || key.length < 12) return "[REDACTED]";
  return key.slice(0, 6) + "..." + key.slice(-4);
}

function generateArticleId(article, index) {
  const raw = `${article.source || "unknown"}:${article.title || "untitled"}:${index}`;
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
}

/**
 * Strip URLs and sensitive fields from articles before sending to AI.
 * Returns { safeArticles, trustedMap } where trustedMap maps articleId → { url, title, publisher, publishedAt }
 */
function isolateUrls(articles) {
  const safeArticles = [];
  const trustedMap = {};

  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const id = generateArticleId(a, i);

    trustedMap[id] = {
      url: a.url || null,
      title: a.title || "",
      publisher: a.source || a.publisher || a._hostname || "",
      publishedAt: a.pageAge || a.publishedAt || null,
    };

    safeArticles.push({
      id,
      title: a.title || "",
      publisher: a.source || a.publisher || a._hostname || "",
      publishedAt: a.pageAge || a.publishedAt || null,
      snippet: (a.description || a.snippet || a.displaySummary || "").slice(0, 300),
      type: a.type || a._category || "general",
      importanceScore: a.importanceScore || a._score || 0,
    });
  }

  return { safeArticles, trustedMap };
}

/**
 * Hydrate article URLs back from the trusted map after AI processing.
 * Validates that each article ID returned by AI actually exists in the map.
 */
function hydrateUrls(aiArticles, trustedMap) {
  return aiArticles
    .filter((a) => a && trustedMap[a.id])
    .map((a) => ({
      ...a,
      url: trustedMap[a.id].url,
      title: a.title || trustedMap[a.id].title,
      publisher: a.publisher || trustedMap[a.id].publisher,
      publishedAt: a.publishedAt || trustedMap[a.id].publishedAt,
    }));
}

// ── Core API Call ─────────────────────────────────────────

/**
 * Call Groq Chat Completions API with structured output validation.
 *
 * @param {Object} options
 * @param {string} options.systemPrompt
 * @param {Object} options.userPayload - Will be JSON-stringified
 * @param {Object} options.schema - JSON Schema for response validation
 * @param {string} [options.primaryApiKey]
 * @param {string} [options.secondaryApiKey]
 * @param {Object} [options.logger]
 * @returns {Object|null} Parsed and validated response, or null on failure
 */
async function callGroqStructured({
  systemPrompt,
  userPayload,
  schema,
  primaryApiKey,
  secondaryApiKey,
  logger,
}) {
  const config = getConfig();
  const primary = primaryApiKey || config.primaryKey;
  const secondary = secondaryApiKey || config.secondaryKey;

  if (!config.enabled) {
    logger?.info("[Groq] Editor disabled via GROQ_EDITOR_ENABLED");
    return null;
  }

  const keys = [primary, secondary].filter(Boolean);
  if (keys.length === 0) {
    logger?.warn("[Groq] No API keys configured");
    return null;
  }

  let lastError = null;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const apiKey = keys[attempt];
    const keyLabel = attempt === 0 ? "primary" : "secondary";

    try {
      logger?.info({ keyLabel, model: config.model }, "[Groq] Calling API...");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);

      let response;
      try {
        response = await fetch(GROQ_API_URL, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: "system", content: systemPrompt },
              {
                role: "user",
                content:
                  typeof userPayload === "string"
                    ? userPayload
                    : JSON.stringify(userPayload, null, 2),
              },
            ],
            max_completion_tokens: config.maxTokens,
            temperature: 0.3,
            response_format: { type: "json_object" },
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const redactedBody = body.slice(0, 300);

        // Auth errors → try next key
        if (response.status === 401 || response.status === 403) {
          logger?.warn(
            { keyLabel, status: response.status, body: redactedBody },
            `[Groq] Auth rejected on ${keyLabel} key`
          );
          lastError = new Error(`Groq auth rejected: ${response.status}`);
          continue;
        }

        // Rate limit → try next key if available
        if (response.status === 429) {
          logger?.warn({ keyLabel }, "[Groq] Rate limited on primary key");
          lastError = new Error("Groq rate limited");
          continue;
        }

        // Server error → try next key
        if (response.status >= 500) {
          logger?.warn({ keyLabel, status: response.status }, "[Groq] Server error");
          lastError = new Error(`Groq server error: ${response.status}`);
          continue;
        }

        throw new Error(`Groq HTTP ${response.status}: ${redactedBody}`);
      }

      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;

      if (!content) {
        logger?.warn({ keyLabel }, "[Groq] Empty response content");
        lastError = new Error("Empty Groq response");
        continue;
      }

      // Parse and validate against schema
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (parseErr) {
        logger?.warn({ keyLabel, content: content.slice(0, 200) }, "[Groq] JSON parse failed");
        lastError = parseErr;
        continue;
      }

      if (schema) {
        const validationErrors = validateAgainstSchema(parsed, schema, logger);
        if (validationErrors.length > 0) {
          logger?.warn(
            { keyLabel, errors: validationErrors.slice(0, 5) },
            "[Groq] Schema validation failed"
          );
          lastError = new Error(`Schema validation: ${validationErrors[0]}`);
          continue;
        }
      }

      logger?.info({ keyLabel, model: config.model }, "[Groq] API call successful");
      return parsed;
    } catch (err) {
      if (err.name === "AbortError") {
        logger?.warn({ keyLabel }, "[Groq] Request timed out");
        lastError = new Error("Groq timeout");
        continue;
      }
      lastError = err;
    }
  }

  logger?.warn({ error: lastError?.message }, "[Groq] All keys exhausted — returning null");
  return null;
}

/**
 * Simple JSON Schema validator.
 * Supports: type, required, properties (nested objects), items (arrays), enum.
 */
function validateAgainstSchema(data, schema, logger) {
  const errors = [];

  function validate(value, schemaPart, path) {
    if (!schemaPart) return;

    if (schemaPart.type) {
      const actualType = Array.isArray(value) ? "array" : typeof value;
      if (actualType !== schemaPart.type && !(schemaPart.type === "number" && actualType === "number")) {
        // Allow integer for number type
        if (!(schemaPart.type === "number" && Number.isFinite(value))) {
          errors.push(`${path}: expected ${schemaPart.type}, got ${actualType}`);
          return;
        }
      }
    }

    if (schemaPart.enum && !schemaPart.enum.includes(value)) {
      errors.push(`${path}: expected one of [${schemaPart.enum.join(", ")}], got ${JSON.stringify(value)}`);
    }

    if (schemaPart.properties && typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [key, propSchema] of Object.entries(schemaPart.properties)) {
        validate(value[key], propSchema, `${path}.${key}`);
      }
    }

    if (schemaPart.required && Array.isArray(schemaPart.required)) {
      if (typeof value === "object" && value !== null) {
        for (const req of schemaPart.required) {
          if (!(req in value)) {
            errors.push(`${path}: missing required field "${req}"`);
          }
        }
      }
    }

    if (schemaPart.items && Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        validate(value[i], schemaPart.items, `${path}[${i}]`);
      }
    }
  }

  validate(data, schema, "root");
  return errors;
}

// ── News Editor (for newsService.js) ──────────────────────

const NEWS_EDITOR_SCHEMA = {
  type: "object",
  required: ["articles", "editorNote"],
  properties: {
    articles: {
      type: "array",
      items: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          displayTitle: { type: "string" },
          summary: { type: "string" },
          type: { type: "string" },
        },
      },
    },
    editorNote: { type: "string" },
  },
};

const NEWS_SYSTEM_PROMPT = `You are a news editor for an Indonesian WhatsApp group.

Your task: select and polish the most important news articles from candidates.

Rules:
1. Select 4-5 articles maximum (mix of Indonesia and world news).
2. For each article, provide:
   - "id": the article ID (exactly as given)
   - "displayTitle": a clean Indonesian title (if the original is English, translate concisely to Indonesian)
   - "summary": 1-2 sentence Indonesian summary based ONLY on the snippet provided. Do NOT invent facts.
   - "type": "indonesia" or "world"
3. Prioritize articles with high importanceScore.
4. Diversify: avoid picking all from the same topic or publisher.
5. Write a brief "editorNote" (1 sentence in Indonesian) summarizing the overall theme.
6. Output valid JSON only — no markdown, no extra text.

CRITICAL: Do NOT invent URLs, facts, quotes, events, or details not present in the article data.`;

/**
 * Edit news articles for the Morning/Midday/Evening/Nightcap news service.
 * Contract with newsService.js: receives candidates, returns { articles, editorMode, keySlot }.
 */
async function editNewsWithGroq({ candidates, slot, currentDateJakarta, logger }) {
  if (!candidates || candidates.length === 0) {
    logger?.info("[Groq] No candidates — returning fallback");
    return { articles: [], editorMode: "fallback", keySlot: slot };
  }

  const config = getConfig();
  if (!config.enabled) {
    logger?.info("[Groq] Editor disabled — returning candidates as-is");
    return {
      articles: candidates.slice(0, 5).map((a, i) => ({
        ...a,
        id: generateArticleId(a, i),
        displayTitle: a.displayTitle || a.title || "",
        summary: a.displaySummary || a.description || "",
      })),
      editorMode: "fallback",
      keySlot: slot,
    };
  }

  // URL isolation
  const { safeArticles, trustedMap } = isolateUrls(candidates);

  const userPayload = {
    date: currentDateJakarta,
    slot,
    candidates: safeArticles,
  };

  const result = await callGroqStructured({
    systemPrompt: NEWS_SYSTEM_PROMPT,
    userPayload,
    schema: NEWS_EDITOR_SCHEMA,
    primaryApiKey: config.primaryKey,
    secondaryApiKey: config.secondaryKey,
    logger,
  });

  if (!result || !result.articles || result.articles.length === 0) {
    logger?.info("[Groq] AI call failed or returned empty — using fallback");
    return {
      articles: candidates.slice(0, 5).map((a, i) => ({
        ...a,
        id: generateArticleId(a, i),
        displayTitle: a.displayTitle || a.title || "",
        summary: a.displaySummary || a.description || "",
      })),
      editorMode: "fallback",
      keySlot: slot,
    };
  }

  // Hydrate URLs from trusted map
  const hydratedArticles = hydrateUrls(result.articles, trustedMap);

  logger?.info(
    { count: hydratedArticles.length, slot },
    `[Groq] News editing complete: ${hydratedArticles.length} articles`
  );

  return {
    articles: hydratedArticles,
    editorMode: "groq",
    keySlot: slot,
  };
}

// ── FX Market Context Editor (for fxMarketContextService.js) ──

const FX_CONTEXT_SCHEMA = {
  type: "object",
  required: ["articles", "narrative"],
  properties: {
    articles: {
      type: "array",
      items: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          headline: { type: "string" },
          summary: { type: "string" },
        },
      },
    },
    narrative: { type: "string" },
  },
};

const FX_CONTEXT_SYSTEM_PROMPT = `You are a financial markets editor for an Indonesian WhatsApp group.

Your task: produce concise market context from economic news articles about USD/IDR exchange rates.

Rules:
1. Select 2-3 most relevant articles about USD/IDR, rupiah, Bank Indonesia, or Federal Reserve policy.
2. For each article, provide:
   - "id": the article ID (exactly as given)
   - "headline": a short Indonesian headline (max 80 chars)
   - "summary": 1-sentence Indonesian context (max 200 chars)
3. Write a brief "narrative" (max 2 sentences in Indonesian) connecting the articles to possible rupiah movement context. Use cautious language ("kemungkinan", "dapat memengaruhi", "pasar mencermati"). NEVER state that an event caused a rate movement unless the source explicitly confirms causation.
4. Output valid JSON only — no markdown, no extra text.

CRITICAL:
- Do NOT invent URLs, rate numbers, percentages, or economic data.
- Do NOT make financial predictions or give trading advice.
- Use "Konteks yang mungkin relevan" tone — speculative, not definitive.
- Never claim "rupiah melemah karena..." unless sourced.`;

/**
 * Summarize economic news for the USD/IDR market context section.
 * Used by fxMarketContextService.js every 3 hours.
 *
 * @param {Object} options
 * @param {Array} options.articles - Filtered economic news articles (without URLs in safe form)
 * @param {Object} [options.rateStatistics] - Current rate stats for context (not for AI to modify)
 * @param {Object} [options.logger]
 * @returns {Object} { articles, narrative, status: 'ready'|'partial'|'failed' }
 */
async function summarizeFxMarketContext({ articles, rateStatistics, logger }) {
  if (!articles || articles.length === 0) {
    return { articles: [], narrative: "", status: "failed" };
  }

  const config = getConfig();
  if (!config.enabled) {
    logger?.info("[Groq FX] Editor disabled — returning verified headlines as partial");
    return {
      articles: articles.slice(0, 3).map((a) => ({
        ...a,
        headline: a.title || "",
        summary: (a.description || a.snippet || "").slice(0, 200),
      })),
      narrative: "",
      status: "partial",
    };
  }

  // URL isolation
  const { safeArticles, trustedMap } = isolateUrls(articles);

  const userPayload = {
    context: "USD/IDR market intelligence",
    currentRate: rateStatistics
      ? {
          rate: rateStatistics.currentRate,
          change1D: rateStatistics.periods?.["1D"]?.percentageChange,
          change7D: rateStatistics.periods?.["7D"]?.percentageChange,
        }
      : undefined,
    candidates: safeArticles,
  };

  const result = await callGroqStructured({
    systemPrompt: FX_CONTEXT_SYSTEM_PROMPT,
    userPayload,
    schema: FX_CONTEXT_SCHEMA,
    primaryApiKey: config.primaryKey,
    secondaryApiKey: config.secondaryKey,
    logger,
  });

  if (!result || !result.articles || result.articles.length === 0) {
    logger?.info("[Groq FX] AI call failed — using verified headline fallback");
    return {
      articles: articles.slice(0, 3).map((a) => ({
        ...a,
        headline: a.title || "",
        summary: (a.description || a.snippet || "").slice(0, 200),
      })),
      narrative: "",
      status: "partial",
    };
  }

  // Hydrate URLs from trusted map
  const hydratedArticles = hydrateUrls(result.articles, trustedMap);

  return {
    articles: hydratedArticles,
    narrative: result.narrative || "",
    status: "ready",
  };
}

// ── Exports ───────────────────────────────────────────────

module.exports = {
  // Core
  callGroqStructured,

  // News service integration (contract with newsService.js)
  editNewsWithGroq,

  // FX market context integration (for Phase 2)
  summarizeFxMarketContext,

  // URL isolation utilities (for testing)
  isolateUrls,
  hydrateUrls,
  generateArticleId,
  validateAgainstSchema,
};
