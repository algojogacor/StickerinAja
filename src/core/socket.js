// Menyimpan satu referensi socket Baileys aktif.
// Satu pintu bagi kode non-command (scheduler) untuk mengambil socket
// yang sedang tersambung, tanpa bergantung pada variabel global.
let currentSock = null;

/** Simpan socket aktif. Panggil setSock(null) saat koneksi tertutup. */
function setSock(sock) {
    currentSock = sock;
}

/** Ambil socket aktif, atau null bila belum/sedang tidak tersambung. */
function getSock() {
    return currentSock;
}

module.exports = { getSock, setSock };
