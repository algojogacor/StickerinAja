// FX Rate Provider tests — validation, error handling, URL redaction.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  validateRateResponse,
  sanitizeError,
  redactUrl,
} = require("../src/services/fxRateProvider");

describe("FX Rate Provider — Validation", () => {
  it("accepts valid response", () => {
    const data = { timestamp: 1720950000, base: "USD", rates: { IDR: 18125.45 } };
    assert.equal(validateRateResponse(data), true);
  });

  it("rejects null/undefined response", () => {
    assert.throws(
      () => validateRateResponse(null),
      (err) => err.errorCode === "FX_INVALID_RESPONSE"
    );
  });

  it("rejects wrong base currency", () => {
    assert.throws(
      () => validateRateResponse({ base: "EUR", rates: { IDR: 100 } }),
      (err) => err.errorCode === "FX_INVALID_BASE"
    );
  });

  it("rejects missing rates object", () => {
    assert.throws(
      () => validateRateResponse({ timestamp: 1, base: "USD" }),
      (err) => err.errorCode === "FX_MISSING_RATES"
    );
  });

  it("rejects missing rates.IDR", () => {
    assert.throws(
      () => validateRateResponse({ timestamp: 1, base: "USD", rates: {} }),
      (err) => err.errorCode === "FX_MISSING_IDR"
    );
  });

  it("rejects zero rate", () => {
    assert.throws(
      () => validateRateResponse({ timestamp: 1, base: "USD", rates: { IDR: 0 } }),
      (err) => err.errorCode === "FX_INVALID_RATE"
    );
  });

  it("rejects negative rate", () => {
    assert.throws(
      () => validateRateResponse({ timestamp: 1, base: "USD", rates: { IDR: -100 } }),
      (err) => err.errorCode === "FX_INVALID_RATE"
    );
  });

  it("rejects NaN rate", () => {
    assert.throws(
      () => validateRateResponse({ timestamp: 1, base: "USD", rates: { IDR: NaN } }),
      (err) => err.errorCode === "FX_INVALID_RATE"
    );
  });

  it("rejects string rate", () => {
    assert.throws(
      () => validateRateResponse({ timestamp: 1, base: "USD", rates: { IDR: "18125" } }),
      (err) => err.errorCode === "FX_INVALID_RATE"
    );
  });

  it("rejects missing timestamp", () => {
    assert.throws(
      () => validateRateResponse({ base: "USD", rates: { IDR: 100 } }),
      (err) => err.errorCode === "FX_INVALID_TIMESTAMP"
    );
  });

  it("accepts very large rate value", () => {
    const data = { timestamp: 1, base: "USD", rates: { IDR: 999999.99 } };
    assert.equal(validateRateResponse(data), true);
  });
});

describe("FX Rate Provider — URL Redaction", () => {
  it("redacts app_id from URL", () => {
    const url = "https://openexchangerates.org/api/latest.json?app_id=abc123secret&symbols=IDR";
    const redacted = redactUrl(url);
    assert.ok(!redacted.includes("abc123secret"));
    assert.ok(redacted.includes("[REDACTED]"));
  });

  it("redacts api_key from URL", () => {
    const url = "https://api.example.com/data?api_key=mykey123";
    const redacted = redactUrl(url);
    assert.ok(!redacted.includes("mykey123"));
    assert.ok(redacted.includes("[REDACTED]"));
  });

  it("preserves non-credential params", () => {
    const url = "https://openexchangerates.org/api/latest.json?app_id=secret&symbols=IDR";
    const redacted = redactUrl(url);
    assert.ok(redacted.includes("symbols=IDR"));
  });
});

describe("FX Rate Provider — Error Sanitization", () => {
  it("sanitizes error messages with app_id in URL", () => {
    const error = new Error("Failed: https://api.com?app_id=secret123");
    const sanitized = sanitizeError(error);
    assert.ok(!sanitized.errorMessage.includes("secret123"));
    assert.ok(sanitized.errorMessage.includes("[REDACTED]"));
  });

  it("preserves structured errors", () => {
    const error = { errorCode: "FX_TIMEOUT", errorMessage: "Timed out" };
    const sanitized = sanitizeError(error);
    assert.equal(sanitized.errorCode, "FX_TIMEOUT");
  });

  it("handles null error", () => {
    const sanitized = sanitizeError(null);
    assert.equal(sanitized.errorCode, "FX_UNKNOWN_ERROR");
  });

  it("detects timeout errors", () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "AbortError";
    const sanitized = sanitizeError(error);
    assert.equal(sanitized.errorCode, "FX_PROVIDER_TIMEOUT");
  });
});
