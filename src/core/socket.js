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

function isSocketOpen(sock) {
  if (!sock) return false;
  if (typeof sock.ws?.isOpen === 'boolean') return sock.ws.isOpen;
  if (sock.ws?.socket?.readyState === 1) return true;
  return true;
}

function getBotSock() {
  const preferredId = process.env.SCHEDULER_SESSION_ID || 'bot';
  if (_socks.has(preferredId) && isSocketOpen(_socks.get(preferredId))) return _socks.get(preferredId);
  if (_socks.has('bot') && isSocketOpen(_socks.get('bot'))) return _socks.get('bot');
  if (_socks.has('default') && isSocketOpen(_socks.get('default'))) return _socks.get('default');
  return null;
}

function getBirthdaySock() {
  const preferredId = process.env.SCHEDULER_SESSION_ID || 'bot';
  const preferred = _socks.get(preferredId);
  if (preferred && isSocketOpen(preferred)) return preferred;

  const bot = _socks.get('bot');
  if (bot && isSocketOpen(bot)) return bot;

  // Explicit fallback to personal session (pribadi) if bot session is unavailable
  const pribadi = _socks.get('pribadi');
  if (pribadi && isSocketOpen(pribadi)) return pribadi;

  const def = _socks.get('default');
  if (def && isSocketOpen(def)) return def;

  for (const sock of _socks.values()) {
    if (sock && isSocketOpen(sock)) return sock;
  }
  return null;
}

module.exports = { setSock, getSock, getBotSock, getBirthdaySock, isSocketOpen, clearSock, getAllSocks };
