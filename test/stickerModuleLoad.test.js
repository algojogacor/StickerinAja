const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

describe("Sticker command native module loading", () => {
  it("loads in a fresh Windows process without a canvas DLL ordering failure", () => {
    const repoRoot = path.resolve(__dirname, "..");
    const result = spawnSync(
      process.execPath,
      ["-e", "require('./src/commands/sticker')"],
      { cwd: repoRoot, encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
});
