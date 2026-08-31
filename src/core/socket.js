// Socket holder — set by connection module, read by schedulers.
// Simple module-level reference avoids circular dependencies.
// Supports both single-session and multi-session architectures.

let _defaultSock = null;
const _socks = new Map();

function setSock(sock, sessionId = 'default') {
  _socks.set(sessionId, sock);
  const preferredId = process.env.SCHEDULER_SESSION_ID || 'bot';
  if (sessionId === preferredId || sessionId === 'default' || !_defaultSock) {
    _defaultSock = sock;
  }
}

function getSock(sessionId = null) {
  if (sessionId) {
    return _socks.get(sessionId) || null;
  }
  const preferredId = process.env.SCHEDULER_SESSION_ID || 'bot';
  if (_socks.has(preferredId)) {
    return _socks.get(preferredId);
  }
  if (_defaultSock) return _defaultSock;
  // Fallback to any connected socket
  for (const sock of _socks.values()) {
    if (sock) return sock;
  }
  return null;
}

function clearSock(expectedSock, sessionId = null) {
  if (sessionId && _socks.has(sessionId)) {
    const existing = _socks.get(sessionId);
    if (!expectedSock || existing === expectedSock) {
      _socks.delete(sessionId);
      if (_defaultSock === expectedSock) {
        _defaultSock = _socks.values().next().value || null;
      }
      return true;
    }
    return false;
  }

  if (expectedSock) {
    let removed = false;
    for (const [id, sock] of _socks.entries()) {
      if (sock === expectedSock) {
        _socks.delete(id);
        removed = true;
      }
    }
    if (_defaultSock === expectedSock) {
      _defaultSock = _socks.values().next().value || null;
      removed = true;
    }
    return removed;
  }

  _socks.clear();
  _defaultSock = null;
  return true;
}

function getAllSocks() {
  return Array.from(_socks.values());
}

module.exports = { setSock, getSock, clearSock, getAllSocks };
