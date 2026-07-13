// Registry scheduler. Saat ini belum ada job — fungsi ini no-op.
// Saat menambah job pertama: tambahkan node-cron ke dependencies,
// buat file job di folder ini, lalu daftarkan di sini.
function registerSchedulers({ logger }) {
    logger.info('🕒 Scheduler registry ready (no jobs registered)');
}

module.exports = { registerSchedulers };
