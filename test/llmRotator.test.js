const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const llmRotator = require("../src/services/llmRotator");

describe("LLM Rotator Multi-Provider Service", () => {
  it("resolves configured providers in order of priority", () => {
    const prevGroq = process.env.GROQ_API_KEY_1;
    const prevDash = process.env.DASHSCOPE_API_KEY_1;
    const prevDoubao = process.env.DOUBAO_API_KEY_1;

    try {
      process.env.GROQ_API_KEY_1 = "gsk_test123";
      process.env.DASHSCOPE_API_KEY_1 = "sk-dashscope123";
      process.env.DOUBAO_API_KEY_1 = "doubao-key-123";

      const providers = llmRotator.getActiveProviders();
      assert.ok(providers.length >= 3);
      assert.equal(providers[0].name, "groq");
      assert.equal(providers[1].name, "dashscope");
      assert.equal(providers[2].name, "doubao");

      // Verify default models
      assert.ok(providers[1].textModel.includes("qwen3.8") || providers[1].textModel.includes("qwen"));
      assert.ok(providers[1].visionModel.includes("qwen3.8") || providers[1].visionModel.includes("qwen"));
      assert.ok(providers[2].textModel.includes("doubao"));
      assert.ok(providers[2].visionModel.includes("doubao"));
    } finally {
      process.env.GROQ_API_KEY_1 = prevGroq;
      process.env.DASHSCOPE_API_KEY_1 = prevDash;
      process.env.DOUBAO_API_KEY_1 = prevDoubao;
    }
  });

  it("handles missing keys gracefully", async () => {
    const prevGroq = process.env.GROQ_API_KEY_1;
    const prevDash = process.env.DASHSCOPE_API_KEY_1;
    const prevDoubao = process.env.DOUBAO_API_KEY_1;

    try {
      delete process.env.GROQ_API_KEY;
      delete process.env.GROQ_API_KEY_1;
      delete process.env.GROQ_API_KEY_2;
      delete process.env.GROQ_API_KEY_PRIMARY;
      delete process.env.GROQ_API_KEY_SECONDARY;
      delete process.env.DASHSCOPE_API_KEY;
      delete process.env.DASHSCOPE_API_KEY_1;
      delete process.env.DASHSCOPE_API_KEY_2;
      delete process.env.QWEN_API_KEY;
      delete process.env.DOUBAO_API_KEY;
      delete process.env.DOUBAO_API_KEY_1;
      delete process.env.DOUBAO_API_KEY_2;
      delete process.env.DOUBAO_API_KEY_3;
      delete process.env.DOUBAO_API_KEY_4;
      delete process.env.DOUBAO_API_KEY_5;
      delete process.env.VOLC_ARK_API_KEY;

      const res = await llmRotator.callLlmWithRotation({
        messages: [{ role: "user", content: "test" }],
      });
      assert.equal(res.success, false);
      assert.ok(res.error.includes("Tidak ada API key"));
    } finally {
      process.env.GROQ_API_KEY_1 = prevGroq;
      process.env.DASHSCOPE_API_KEY_1 = prevDash;
      process.env.DOUBAO_API_KEY_1 = prevDoubao;
    }
  });
});
