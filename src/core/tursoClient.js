// Shared Turso/libSQL client factory.
// Provides a single connection instance for FX repository.
// Reddit repository continues using its own client (migration deferred).

const { createClient } = require("@libsql/client");

let _client = null;
let _initAttempted = false;

/**
 * Get or create a Turso client instance.
 * Returns null if TURSO_DATABASE_URL is not configured.
 */
function getTursoClient() {
  if (_client) return _client;
  if (_initAttempted) return null;

  _initAttempted = true;

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) return null;

  try {
    _client = createClient({ url, authToken });
    return _client;
  } catch (err) {
    // createClient may throw if URL is malformed
    return null;
  }
}

/**
 * Reset the client (for testing purposes only).
 */
function resetTursoClient() {
  _client = null;
  _initAttempted = false;
}

/**
 * Check whether a Turso client is available.
 */
function hasTursoClient() {
  return getTursoClient() !== null;
}

module.exports = { getTursoClient, resetTursoClient, hasTursoClient };
