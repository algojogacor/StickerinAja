// Deterministic news fallback — runs when Groq is disabled, keys unavailable,
// all keys fail, response empty, or validation fails.
//
// Uses score-based sorting and source/topic diversity rules.
// NEVER invents facts, creates URLs, or fabricates summaries.

const MAX_INDONESIA = 4;
const MAX_WORLD = 1;
const MAX_SAME_SOURCE = 2;
const MIN_DESCRIPTION_LENGTH = 40;

// ── Helpers ─────────────────────────────────────────────────

function containsUrl(text) {
  return /https?:\/\/|www\./i.test(text || "");
}

function isGenericDescription(text) {
  const normalized = (text || "").trim().toLowerCase();

  const genericPatterns = [
    /^monday links!?$/i, /^tuesday links!?$/i, /^wednesday links!?$/i,
    /^thursday links!?$/i, /^friday links!?$/i,
    /^saturday links!?$/i, /^sunday links!?$/i,
    /^latest updates?\.?$/i,
    /^read more here\.?$/i,
    /^click here to read more\.?$/i,
    /^live updates?\.?$/i,
    /^breaking news\.?$/i,
    /^news roundup\.?$/i,
    /^today'?s top stories\.?$/i,
    /^top stories\.?$/i,
    /^daily news\.?$/i,
    /^berita ini membahas/i,
    /^perkembangan terbaru/i,
    /^informasi selengkapnya/i,
    /^berita ini menarik perhatian/i,
    /^kabar terbaru/i,
    /^simak perkembangan/i,
    /^mariners news:/i,
  ];

  return genericPatterns.some((pattern) => pattern.test(normalized));
}

// ── Topic keywords for diversity ────────────────────────────

const TOPIC_KEYWORDS = {
  government_politics: [
    "presiden", "pemerintah", "kementerian", "menteri", "dpr", "kebijakan",
    "uu ", "undang-undang", "pilpres", "pemilu", "politik", "parlemen",
  ],
  economy: [
    "ekonomi", "rupiah", "harga", "inflasi", "subsidi", "pajak", "anggaran",
    "investasi", "perdagangan", "ekspor", "bunga", "kredit", "perbankan",
    "ojk", "apbn",
  ],
  social_welfare: [
    "kesehatan", "pendidikan", "sekolah", "universitas", "rumah sakit",
    "bansos", "bantuan sosial", "vaksin", "obat", "guru", "siswa", "mahasiswa",
  ],
  disaster_environment: [
    "bencana", "gempa", "banjir", "tsunami", "erupsi", "longsor",
    "kebakaran", "cuaca", "iklim", "lingkungan", "polusi", "konservasi",
  ],
  tech_science: [
    "teknologi", "digital", "startup", "satelit", "riset", "penelitian",
    "sains", "inovasi", "ai ", "artificial intelligence", "energi",
    "internet", "data",
  ],
  law_security: [
    "hukum", "pengadilan", "kpk", "korupsi", "keamanan", "polri", "tni",
    "ham", "kriminal", "pidana", "peradilan",
  ],
  international: [
    "war", "conflict", "invasion", "ceasefire", "military", "nato",
    "president", "prime minister", "election", "summit", "treaty",
    "united nations", "global economy", "recession", "federal reserve",
    "trade war", "tariff", "earthquake", "hurricane", "pandemic",
    "breakthrough", "discovery", "nasa", "space",
  ],
};

function classifyTopicFallback(article) {
  const text = `${article.title || ""} ${article.description || ""}`.toLowerCase();
  for (const [category, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    const matchCount = keywords.filter((kw) => text.includes(kw)).length;
    if (matchCount >= 2) return category;
  }
  return "general";
}

// ── Build safe fallback summary ──────────────────────────────

function buildSafeFallbackSummary(description) {
  if (!description || typeof description !== "string") return "";

  // Clean boilerplate
  let cleaned = description
    .replace(/^(Jakarta|JAKARTA),\s*(KOMPAS\.com|CNN Indonesia|TEMPO\.CO|ANTARA)\s*[-–—]\s*/i, "")
    .replace(/\b(Baca juga|Simak juga|Baca selengkapnya|Read more|Click here).*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (cleaned.length < MIN_DESCRIPTION_LENGTH) return "";

  // Truncate to ~2 sentences
  const sentences = cleaned.split(/(?<=[.!?])\s+/);
  const short = sentences.slice(0, 2).join(" ").trim();

  if (short.length >= MIN_DESCRIPTION_LENGTH) return short;
  return cleaned.length >= MIN_DESCRIPTION_LENGTH ? cleaned : "";
}

// ── Diversity-based selection ────────────────────────────────

function selectDiverseArticles(sorted) {
  const selected = [];
  const usedSources = new Map();
  const usedTopics = new Map();

  // Pass 1: pick one article per distinct topic
  const topicsSeen = new Set();
  for (const article of sorted) {
    if (selected.length >= (MAX_INDONESIA + MAX_WORLD)) break;

    const topic = article._fallbackTopic || classifyTopicFallback(article);
    const source = String(article.source || "").toLowerCase();

    if (topicsSeen.has(topic)) continue;
    if ((usedSources.get(source) || 0) >= MAX_SAME_SOURCE) continue;

    selected.push(article);
    topicsSeen.add(topic);
    usedSources.set(source, (usedSources.get(source) || 0) + 1);
    usedTopics.set(topic, (usedTopics.get(topic) || 0) + 1);
  }

  // Pass 2: fill remaining from best remaining
  for (const article of sorted) {
    if (selected.length >= (MAX_INDONESIA + MAX_WORLD)) break;
    if (selected.includes(article)) continue;

    const topic = article._fallbackTopic || classifyTopicFallback(article);
    const source = String(article.source || "").toLowerCase();

    if ((usedSources.get(source) || 0) >= MAX_SAME_SOURCE) continue;
    if ((usedTopics.get(topic) || 0) >= 2) continue;

    selected.push(article);
    usedSources.set(source, (usedSources.get(source) || 0) + 1);
    usedTopics.set(topic, (usedTopics.get(topic) || 0) + 1);
  }

  return selected;
}

// ── Main fallback function ───────────────────────────────────

function deterministicNewsFallback(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return [];
  }

  // Filter out clearly unusable candidates
  const usable = candidates.filter((a) => {
    // Must have a valid URL
    if (!a.url) return false;

    // Reject articles with generic/non-informative descriptions
    if (isGenericDescription(a.description)) return false;

    // Description must be long enough to use as summary
    if (!a.description || a.description.trim().length < MIN_DESCRIPTION_LENGTH) return false;

    return true;
  });

  if (usable.length === 0) return [];

  // Score: importanceScore + qualityScore, sort descending
  const scored = usable.map((a) => ({
    ...a,
    _fallbackScore: (Number(a.importanceScore || 0)) + (Number(a.qualityScore || 0)),
    _fallbackTopic: classifyTopicFallback(a),
  }));

  scored.sort((a, b) => b._fallbackScore - a._fallbackScore);

  // Select with diversity
  const selected = selectDiverseArticles(scored);

  // Build final output
  const indonesia = [];
  const world = [];
  const sourceCount = new Map();

  for (const article of selected) {
    const source = String(article.source || "").toLowerCase();
    const count = sourceCount.get(source) || 0;

    if (count >= MAX_SAME_SOURCE) continue;

    const summary = buildSafeFallbackSummary(article.description);

    if (!summary) continue;

    const item = {
      id: article.id,
      type: article.type || "indonesia",
      displayTitle: article.title || "",
      summary,
      category: article.category || article._fallbackTopic || "lainnya",
      importance: Math.max(1, Math.min(10, Math.round((Number(article.importanceScore) || 5)))),
      source: article.source || "",
      url: article.url,
      publishedAt: article.publishedAt || "",
    };

    if (article.type === "world" && world.length < MAX_WORLD) {
      world.push(item);
      sourceCount.set(source, count + 1);
    } else if (article.type !== "world" && indonesia.length < MAX_INDONESIA) {
      indonesia.push(item);
      sourceCount.set(source, count + 1);
    }
  }

  return [...indonesia, ...world].slice(0, MAX_INDONESIA + MAX_WORLD);
}

module.exports = {
  deterministicNewsFallback,
  containsUrl,
  isGenericDescription,
  buildSafeFallbackSummary,
  selectDiverseArticles,
};
