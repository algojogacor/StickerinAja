// FX Rate Provider — Open Exchange Rates HTTP client.
// Fetches latest rates, historical rates, and API usage.
// Redacts credentials from all logged output.

const crypto = require("crypto");

// ── Configuration ─────────────────────────────────────────

const OER_BASE_URL = "https://openexchangerates.org/api";

function getConfig() {
  return {
    appId: process.env.OPEN_EXCHANGE_RATES_APP_ID || "",
    timeoutMs: parseInt(process.env.FX_API_TIMEOUT_MS || "15000", 10),
    maxRetries: parseInt(process.env.FX_API_MAX_RETRIES || "1", 10),
  };
}

// ── Helpers ───────────────────────────────────────────────

function redactUrl(urlStr) {
  try {
    // Don't use URL class for redaction — it encodes brackets in [REDACTED]
    let result = urlStr;
    result = result.replace(/([?&]app_id=)[^&\s]+/gi, "$1[REDACTED]");
    result = result.replace(/([?&]api_key=)[^&\s]+/gi, "$1[REDACTED]");
    result = result.replace(/([?&]key=)[^&\s]+/gi, "$1[REDACTED]");
    result = result.replace(/([?&]token=)[^&\s]+/gi, "$1[REDACTED]");
    result = result.replace(/([?&]auth=)[^&\s]+/gi, "$1[REDACTED]");
    return result;
  } catch {
    return urlStr.replace(/([?&]app_id=)[^&\s]+/gi, "$1[REDACTED]");
  }
}

function sanitizeError(error) {
  if (!error) return { errorCode: "FX_UNKNOWN_ERROR", errorMessage: "Unknown error" };

  // If already structured, return as-is
  if (error.errorCode) return error;

  let message = error.message || String(error);

  // Redact any credential in error messages
  message = message
    .replace(/app_id=[^&\s]+/gi, "app_id=[REDACTED]")
    .replace(/api[_-]?key=[^&\s]+/gi, "api_key=[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");

  let code = "FX_PROVIDER_ERROR";
  if (error.name === "AbortError" || message.includes("timeout")) {
    code = "FX_PROVIDER_TIMEOUT";
  } else if (message.includes("fetch") && message.includes("fail")) {
    code = "FX_PROVIDER_NETWORK";
  } else if (message.includes("401") || message.includes("403")) {
    code = "FX_PROVIDER_AUTH";
  } else if (message.includes("429")) {
    code = "FX_PROVIDER_RATE_LIMITED";
  }

  return { errorCode: code, errorMessage: message.slice(0, 500) };
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// ── Validation ────────────────────────────────────────────

function validateRateResponse(data) {
  if (!data) {
    throw { errorCode: "FX_INVALID_RESPONSE", errorMessage: "Empty response body" };
  }

  if (data.base !== "USD") {
    throw {
      errorCode: "FX_INVALID_BASE",
      errorMessage: `Expected base USD, got ${data.base || "undefined"}`,
    };
  }

  if (!data.rates || typeof data.rates !== "object") {
    throw {
      errorCode: "FX_MISSING_RATES",
      errorMessage: "Response missing rates object",
    };
  }

  const idr = data.rates.IDR;
  if (idr === undefined || idr === null) {
    throw {
      errorCode: "FX_MISSING_IDR",
      errorMessage: "Response missing rates.IDR",
    };
  }

  if (typeof idr !== "number" || !Number.isFinite(idr) || idr <= 0) {
    throw {
      errorCode: "FX_INVALID_RATE",
      errorMessage: `rates.IDR is not a valid positive number: ${JSON.stringify(idr)}`,
    };
  }

  if (!data.timestamp || typeof data.timestamp !== "number") {
    throw {
      errorCode: "FX_INVALID_TIMESTAMP",
      errorMessage: "Missing or invalid provider timestamp",
    };
  }

  return true;
}

// ── API Methods ───────────────────────────────────────────

/**
 * Fetch the latest USD/IDR exchange rate.
 * @param {Object} [logger]
 * @returns {Object} { timestamp, base, rates: { IDR } }
 */
async function fetchLatest(logger) {
  const config = getConfig();

  if (!config.appId) {
    throw { errorCode: "FX_NO_APP_ID", errorMessage: "OPEN_EXCHANGE_RATES_APP_ID is not set" };
  }

  const url = `${OER_BASE_URL}/latest.json?app_id=${config.appId}&symbols=IDR`;
  const redacted = redactUrl(url);

  logger?.info("[OER] Fetching latest USD/IDR rate...");

  let lastError = null;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, config.timeoutMs);

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const redactedBody = body.slice(0, 300);

        logger?.warn(
          { status: response.status, body: redactedBody, attempt },
          `[OER] HTTP ${response.status}`
        );

        if (response.status === 401 || response.status === 403) {
          throw {
            errorCode: "FX_PROVIDER_AUTH",
            errorMessage: `Open Exchange Rates auth rejected: ${response.status}`,
          };
        }
        if (response.status === 429) {
          throw {
            errorCode: "FX_PROVIDER_RATE_LIMITED",
            errorMessage: "Open Exchange Rates monthly quota exceeded",
          };
        }

        throw {
          errorCode: "FX_PROVIDER_HTTP_ERROR",
          errorMessage: `Open Exchange Rates HTTP ${response.status}`,
        };
      }

      const data = await response.json();
      validateRateResponse(data);

      logger?.info(
        { rate: data.rates.IDR, timestamp: data.timestamp },
        `[OER] Latest rate: 1 USD = ${data.rates.IDR} IDR`
      );

      return {
        timestamp: data.timestamp,
        base: data.base,
        rates: { IDR: data.rates.IDR },
      };
    } catch (error) {
      lastError = error;
      // Don't retry on validation errors or auth errors
      if (error.errorCode && !error.errorCode.startsWith("FX_PROVIDER_")) {
        throw error;
      }
      if (attempt < config.maxRetries) {
        const delay = 2000 * (attempt + 1);
        logger?.info({ attempt, delay }, "[OER] Retrying...");
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw sanitizeError(lastError);
}

/**
 * Fetch historical USD/IDR rate for a specific date.
 * @param {string} date - YYYY-MM-DD format
 * @param {Object} [logger]
 * @returns {Object} { timestamp, base, rates: { IDR } }
 */
async function fetchHistorical(date, logger) {
  const config = getConfig();

  if (!config.appId) {
    throw { errorCode: "FX_NO_APP_ID", errorMessage: "OPEN_EXCHANGE_RATES_APP_ID is not set" };
  }

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw {
      errorCode: "FX_INVALID_DATE",
      errorMessage: `Invalid date format: ${date}, expected YYYY-MM-DD`,
    };
  }

  const url = `${OER_BASE_URL}/historical/${date}.json?app_id=${config.appId}`;
  const redacted = redactUrl(url);

  logger?.info({ date }, "[OER] Fetching historical rate...");

  let lastError = null;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, config.timeoutMs);

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const redactedBody = body.slice(0, 300);

        logger?.warn(
          { status: response.status, date, body: redactedBody },
          `[OER] Historical HTTP ${response.status}`
        );

        if (response.status === 404) {
          return null; // Date not available (weekend, holiday)
        }
        if (response.status === 401 || response.status === 403) {
          throw {
            errorCode: "FX_PROVIDER_AUTH",
            errorMessage: "Open Exchange Rates auth rejected",
          };
        }
        if (response.status === 429) {
          throw {
            errorCode: "FX_PROVIDER_RATE_LIMITED",
            errorMessage: "Monthly quota exceeded during historical fetch",
          };
        }

        throw {
          errorCode: "FX_PROVIDER_HTTP_ERROR",
          errorMessage: `Historical HTTP ${response.status}`,
        };
      }

      const data = await response.json();

      // Historical endpoint may return full rates; extract IDR
      if (data.rates && typeof data.rates.IDR === "number" && data.rates.IDR > 0) {
        return {
          timestamp: data.timestamp || Math.floor(new Date(date + "T00:00:00Z").getTime() / 1000),
          base: data.base || "USD",
          rates: { IDR: data.rates.IDR },
        };
      }

      logger?.warn({ date }, "[OER] Historical response missing IDR rate");
      return null;
    } catch (error) {
      lastError = error;
      if (error.errorCode && !error.errorCode.startsWith("FX_PROVIDER_")) {
        throw error;
      }
      if (attempt < config.maxRetries) {
        const delay = 2000 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw sanitizeError(lastError);
}

/**
 * Fetch API usage statistics.
 * @param {Object} [logger]
 * @returns {Object} { usage: { requests, requests_quota, requests_remaining, days_remaining }, plan: { update_frequency } }
 */
async function fetchUsage(logger) {
  const config = getConfig();

  if (!config.appId) {
    throw { errorCode: "FX_NO_APP_ID", errorMessage: "OPEN_EXCHANGE_RATES_APP_ID is not set" };
  }

  const url = `${OER_BASE_URL}/usage.json?app_id=${config.appId}`;
  const redacted = redactUrl(url);

  logger?.info("[OER] Fetching usage stats...");

  try {
    const response = await fetchWithTimeout(url, config.timeoutMs);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger?.warn(
        { status: response.status, body: body.slice(0, 200) },
        `[OER] Usage HTTP ${response.status}`
      );
      return null;
    }

    const data = await response.json();

    return {
      usage: {
        requests: data?.data?.usage?.requests ?? 0,
        requestsQuota: data?.data?.usage?.requests_quota ?? 0,
        requestsRemaining: data?.data?.usage?.requests_remaining ?? 0,
        daysRemaining: data?.data?.usage?.days_remaining ?? 0,
      },
      plan: {
        name: data?.data?.plan?.name || "unknown",
        updateFrequency: data?.data?.plan?.update_frequency || "unknown",
      },
    };
  } catch (error) {
    logger?.warn({ error: error.message }, "[OER] Usage fetch failed");
    return null;
  }
}

// ── Exports ───────────────────────────────────────────────

module.exports = {
  fetchLatest,
  fetchHistorical,
  fetchUsage,
  validateRateResponse,
  sanitizeError,
  redactUrl,
  // Re-export for testing
  OER_BASE_URL,
};
