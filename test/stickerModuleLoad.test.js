const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("Sticker command module loading", () => {
  it("loads sticker command and services directly without failure", () => {
    const stickerCmd = require("../src/commands/sticker");
    const svgRenderer = require("../src/services/sticker/svgRenderer");
    const imageProcessor = require("../src/services/sticker/imageProcessor");
    const animatedProcessor = require("../src/services/sticker/animatedProcessor");
    const converterService = require("../src/services/sticker/converterService");

    assert.ok(stickerCmd.names.includes("s"));
    assert.ok(stickerCmd.names.includes("sticker"));
    assert.ok(typeof svgRenderer.renderTextToWebP === "function");
    assert.ok(typeof imageProcessor.preprocessImage === "function");
    assert.ok(typeof animatedProcessor.createAnimated === "function");
    assert.ok(typeof converterService.toImage === "function");
  });
});
