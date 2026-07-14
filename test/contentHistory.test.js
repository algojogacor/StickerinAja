// Content History tests — hash determinism, namespace isolation,
// TTL expiry, memory bounds, import contract compatibility.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  hashContent,
  hasSent,
  markSent,
  clearNamespace,
  getEntryCount,
} = require("../src/utils/contentHistory");

describe("Content History — Hashing", () => {
  it("should produce deterministic hash for same string", () => {
    const h1 = hashContent("test content");
    const h2 = hashContent("test content");
    assert.equal(h1, h2);
  });

  it("should produce different hash for different content", () => {
    const h1 = hashContent("content A");
    const h2 = hashContent("content B");
    assert.notEqual(h1, h2);
  });

  it("should produce 32-char hex hash", () => {
    const h = hashContent("some data");
    assert.equal(h.length, 32);
    assert.ok(/^[a-f0-9]{32}$/.test(h));
  });

  it("should hash Buffer content", () => {
    const buf = Buffer.from("binary data");
    const h = hashContent(buf);
    assert.equal(h.length, 32);
  });

  it("should hash object content via JSON.stringify", () => {
    const h = hashContent({ key: "value" });
    assert.equal(h.length, 32);
  });
});

describe("Content History — Send Tracking", () => {
  beforeEach(() => {
    clearNamespace("test");
  });

  afterEach(() => {
    clearNamespace("test");
  });

  it("hasSent returns false for unknown hash", () => {
    assert.equal(hasSent("test", "abc123"), false);
  });

  it("hasSent returns true after markSent", () => {
    markSent("test", "xyz789");
    assert.equal(hasSent("test", "xyz789"), true);
  });

  it("hasSent returns false for different namespace", () => {
    markSent("test", "hash1");
    assert.equal(hasSent("other", "hash1"), false);
  });

  it("markSent then hasSent in same namespace returns true", () => {
    const h = hashContent("article content here");
    markSent("news", h);
    assert.equal(hasSent("news", h), true);
  });

  it("multiple marks in same namespace all tracked", () => {
    markSent("test", "h1");
    markSent("test", "h2");
    markSent("test", "h3");
    assert.equal(hasSent("test", "h1"), true);
    assert.equal(hasSent("test", "h2"), true);
    assert.equal(hasSent("test", "h3"), true);
  });
});

describe("Content History — TTL Expiry", () => {
  beforeEach(() => {
    clearNamespace("ttl-test");
  });

  afterEach(() => {
    clearNamespace("ttl-test");
  });

  it("entry with short TTL expires", async () => {
    markSent("ttl-test", "expires-fast", 50);

    // Should be true immediately
    assert.equal(hasSent("ttl-test", "expires-fast"), true);

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(hasSent("ttl-test", "expires-fast"), false);
  });

  it("entry with longer TTL survives", () => {
    markSent("ttl-test", "stays", 5000);
    assert.equal(hasSent("ttl-test", "stays"), true);
  });

  it("default TTL is 24 hours (entry survives short check)", () => {
    markSent("ttl-test", "default-ttl");
    assert.equal(hasSent("ttl-test", "default-ttl"), true);
  });
});

describe("Content History — Namespace Isolation", () => {
  beforeEach(() => {
    clearNamespace("ns-a");
    clearNamespace("ns-b");
  });

  afterEach(() => {
    clearNamespace("ns-a");
    clearNamespace("ns-b");
  });

  it("namespaces are independent", () => {
    markSent("ns-a", "shared-hash");
    assert.equal(hasSent("ns-a", "shared-hash"), true);
    assert.equal(hasSent("ns-b", "shared-hash"), false);
  });

  it("clearNamespace only clears targeted namespace", () => {
    markSent("ns-a", "h1");
    markSent("ns-b", "h2");
    clearNamespace("ns-a");
    assert.equal(hasSent("ns-a", "h1"), false);
    assert.equal(hasSent("ns-b", "h2"), true);
  });
});

describe("Content History — Entry Count", () => {
  beforeEach(() => {
    clearNamespace("count-test");
  });

  afterEach(() => {
    clearNamespace("count-test");
  });

  it("getEntryCount reflects marks", () => {
    const before = getEntryCount();
    markSent("count-test", "c1");
    markSent("count-test", "c2");
    assert.equal(getEntryCount(), before + 2);
  });

  it("re-marking same entry does not double count", () => {
    markSent("count-test", "same");
    const afterFirst = getEntryCount();
    markSent("count-test", "same"); // re-mark
    assert.equal(getEntryCount(), afterFirst);
  });
});
