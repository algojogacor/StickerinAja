// Socket holder — set by connection module, read by schedulers.
// Simple module-level reference avoids circular dependencies.

let _sock = null;

function setSock(sock) {
  _sock = sock;
}

function getSock() {
  return _sock;
}

module.exports = { setSock, getSock };
