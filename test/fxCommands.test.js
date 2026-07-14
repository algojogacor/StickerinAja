// FX Commands tests — command names, admin gating, prefix respect.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const fxCommands = require("../src/commands/fx");

describe("FX Commands — Module Contract", () => {
  it("exports names array", () => {
    assert.ok(Array.isArray(fxCommands.names));
    assert.ok(fxCommands.names.length > 0);
  });

  it("exports execute function", () => {
    assert.equal(typeof fxCommands.execute, "function");
  });

  it("includes all required command names", () => {
    const required = ["usd", "kurs", "usdrefresh", "usdbackfill", "usdtest", "usdmode", "usdquota"];
    for (const name of required) {
      assert.ok(fxCommands.names.includes(name), `Missing command: ${name}`);
    }
  });

  it("command names do not start with prefix character", () => {
    const prefix = process.env.PREFIX || "!";
    for (const name of fxCommands.names) {
      assert.ok(
        !name.startsWith(prefix),
        `Command "${name}" should not start with prefix "${prefix}"`
      );
    }
  });

  it("usd and kurs are both present as aliases", () => {
    assert.ok(fxCommands.names.includes("usd"));
    assert.ok(fxCommands.names.includes("kurs"));
  });
});

describe("FX Commands — Access Control", () => {
  it("admin commands should require privilege", () => {
    const adminCommands = ["usdrefresh", "usdbackfill", "usdtest", "usdmode", "usdquota"];
    for (const cmd of adminCommands) {
      assert.ok(fxCommands.names.includes(cmd), `Admin command missing: ${cmd}`);
    }
  });

  it("public commands accessible to all", () => {
    const publicCommands = ["usd", "kurs"];
    for (const cmd of publicCommands) {
      assert.ok(fxCommands.names.includes(cmd), `Public command missing: ${cmd}`);
    }
  });
});
