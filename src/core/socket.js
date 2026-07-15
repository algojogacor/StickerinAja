// Socket holder — set by connection module, read by schedulers.
// Simple module-level reference avoids circular dependencies.

let _sock = null;

function setSock(sock) {
  _sock = sock;
}

function getSock() {
  return _sock;
}

function clearSock(expectedSock) {
  if (expectedSock && _sock !== expectedSock) return false;
  _sock = null;
  return true;
}

module.exports = { setSock, getSock, clearSock };
