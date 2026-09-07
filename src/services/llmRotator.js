/**
 * Universal Multi-Provider LLM Rotator
 * Seamless failover & key rotation across:
 * 1. Groq (qwen/qwen3.8-27b)
 * 2. Alibaba Cloud DashScope (qwen3.8-27b, qwen-vl-plus)
 * 3. ByteDance Volcano Engine Ark / Doubao (doubao-seed-1-6-flash-250615, doubao-1-5-pro-32k-250115)
 */

function getGroqKeys() {
  const keys = [
    process.env.GROQ_API_KEY_PRIMARY,
    process.env.GROQ_API_KEY_SECONDARY,
    process.env.GROQ_API_KEY_1,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY,
  ].filter(Boolean);
  return [...new Set(keys)];
}

function getDashScopeKeys() {
  const keys = [
    process.env.DASHSCOPE_API_KEY_1,
    process.env.DASHSCOPE_API_KEY_2,
    process.env.DASHSCOPE_API_KEY,
    process.env.QWEN_API_KEY,
  ].filter(Boolean);
  return [...new Set(keys)];
}

function getDoubaoKeys() {
  const keys = [
    process.env.DOUBAO_API_KEY_1,
    process.env.DOUBAO_API_KEY_2,
    process.env.DOUBAO_API_KEY_3,
    process.env.DOUBAO_API_KEY_4,
    process.env.DOUBAO_API_KEY_5,
    process.env.DOUBAO_API_KEY,
    process.env.VOLC_ARK_API_KEY,
  ].filter(Boolean);
  return [...new Set(keys)];
}

/**
 * Resolves available providers in order of priority
 */
function getActiveProviders() {
  const providers = [];

  const groqKeys = getGroqKeys();
  if (groqKeys.length > 0) {
    providers.push({
      name: 'groq',
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      keys: groqKeys,
      textModel: process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
      visionModel: process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b',
    });
  }

  const dashscopeKeys = getDashScopeKeys();
  if (dashscopeKeys.length > 0) {
    providers.push({
      name: 'dashscope',
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      keys: dashscopeKeys,
      textModel: process.env.DASHSCOPE_MODEL || 'qwen3.8-flash',
      visionModel: process.env.DASHSCOPE_VISION_MODEL || 'qwen3.8-flash',
    });
  }

  const doubaoKeys = getDoubaoKeys();
  if (doubaoKeys.length > 0) {
    providers.push({
      name: 'doubao',
      endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      keys: doubaoKeys,
      textModel: process.env.DOUBAO_MODEL || 'doubao-seed-1-6-flash-250615',
      visionModel: process.env.DOUBAO_VISION_MODEL || 'doubao-seed-1-6-flash-250615',
    });
  }

  return providers;
}

/**
 * Universal call with multi-provider failover and key rotation
 * @param {Object} params
 * @param {Array} params.messages - OpenAI format messages
 * @param {number} [params.max_tokens=1200]
 * @param {number} [params.temperature=0.7]
 * @param {boolean} [params.isVision=false]
 * @param {string} [params.preferredModel]
 * @param {Object} [params.logger]
 * @returns {Promise<{ success: boolean, text?: string, provider?: string, model?: string, error?: string }>}
 */
async function callLlmWithRotation({
  messages,
  max_tokens = 1200,
  temperature = 0.7,
  isVision = false,
  preferredModel,
  logger,
}) {
  const providers = getActiveProviders();
  if (providers.length === 0) {
    return {
      success: false,
      error: 'Tidak ada API key LLM yang terkonfigurasi (Groq, DashScope, atau Doubao).',
    };
  }

  let lastError = null;

  for (const provider of providers) {
    // If vision is required but provider doesn't support vision, skip
    if (isVision && !provider.visionModel) {
      continue;
    }

    const selectedModel = preferredModel || (isVision ? provider.visionModel : provider.textModel);

    for (const key of provider.keys) {
      try {
        const payload = {
          model: selectedModel,
          messages,
          max_tokens,
          temperature,
        };

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45000);

        const res = await fetch(provider.endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        const data = await res.json();
        if (res.ok && data.choices?.[0]?.message?.content) {
          const content = data.choices[0].message.content.trim();
          logger?.info?.(
            { provider: provider.name, model: selectedModel },
            '[LLM Rotator] Request succeeded'
          );
          return {
            success: true,
            text: content,
            provider: provider.name,
            model: selectedModel,
          };
        }

        const errMsg = data.error?.message || data.message || `HTTP ${res.status}`;
        lastError = `[${provider.name}] ${errMsg}`;
        logger?.warn?.(
          { provider: provider.name, key: key.slice(0, 8), err: errMsg },
          '[LLM Rotator] Key failed, rotating to next...'
        );
      } catch (err) {
        lastError = `[${provider.name}] ${err.message}`;
        logger?.warn?.(
          { provider: provider.name, key: key.slice(0, 8), err: err.message },
          '[LLM Rotator] Connection error, rotating to next...'
        );
      }
    }
  }

  logger?.error?.({ err: lastError }, '[LLM Rotator] All providers and keys failed');
  return {
    success: false,
    error: lastError || 'Semua provider LLM gagal merespons.',
  };
}

module.exports = {
  PROVIDERS: {
    GROQ: 'groq',
    DASHSCOPE: 'dashscope',
    DOUBAO: 'doubao',
  },
  getGroqKeys,
  getDashScopeKeys,
  getDoubaoKeys,
  getActiveProviders,
  callLlmWithRotation,
};
