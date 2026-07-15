const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { setSock, getSock, clearSock } = require("../src/core/socket");

describe("active WhatsApp socket lifecycle", () => {
  afterEach(() => clearSock());

  it("does not let a late close event clear a newer reconnect socket", () => {
    const oldSocket = { id: "old" };
    const newSocket = { id: "new" };

    setSock(oldSocket);
    setSock(newSocket);
    assert.equal(clearSock(oldSocket), false);
    assert.equal(getSock(), newSocket);

    assert.equal(clearSock(newSocket), true);
    assert.equal(getSock(), null);
  });

  it("supports an unconditional clear for shutdown and tests", () => {
    setSock({ id: "active" });
    assert.equal(clearSock(), true);
    assert.equal(getSock(), null);
  });
});
