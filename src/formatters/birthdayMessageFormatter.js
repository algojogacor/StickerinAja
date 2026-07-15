const { getConfig } = require("../config/birthdayConfig");

function mentionText(persons) {
  return persons.map((person) => `@${String(person.name || "Unknown").replace(/[^\p{L}\p{N} _.-]/gu, "")}`).join(", ");
}

function mentions(persons) {
  return persons.map((person) => person.participantId).filter(Boolean);
}

function result(text, persons) {
  return { text, mentions: mentions(persons) };
}

function formatOpening(persons) {
  return result(`🚨🎉 *BIRTHDAY TAKEOVER AKTIF!* 🎉🚨\n\nHari ini grup merayakan ${mentionText(persons)} 🎂\n\nSelamat ulang tahun! Semoga hari ini penuh kabar baik, tawa, dan traktiran.`, persons);
}

function formatSong(persons) {
  const url = getConfig().BIRTHDAY_SONG_URL;
  return result(`🎵 *LAGU ULANG TAHUN*\n\nSelamat ulang tahun untuk ${mentionText(persons)}!\n${url ? `\n🎶 ${url}` : ""}`, persons);
}

function formatCard(persons) {
  return result(`🎁 *BIRTHDAY CARD*\n\nKartu spesial untuk ${mentionText(persons)} dari seluruh warga grup 💐\n\nSemoga tahun baru kehidupanmu membawa lebih banyak bahagia dan hal baik.\n\n📢 Reply pesan ini dengan ucapan atau doa; nanti dirangkum malam hari.`, persons);
}

function formatSpotlight(persons) {
  return result(`🌟 *BIRTHDAY SPOTLIGHT*\n\nTokoh utama grup hari ini: ${mentionText(persons)}\n\nMisi hari ini:\n✅ Bahagia\n✅ Makan enak\n✅ Dapat kabar baik\n✅ Traktir opsional 😄`, persons);
}

function formatReminder(persons) {
  return result(`🎊 *PENGINGAT ULANG TAHUN*\n\nYang belum mengucapkan selamat kepada ${mentionText(persons)}, masih ada waktu sampai malam 🎂`, persons);
}

function formatWishesOpen(persons) {
  return result(`📢 *SESI UCAPAN DIBUKA!*\n\nReply pesan ini dengan ucapan, doa, atau cerita lucu untuk ${mentionText(persons)}. Ucapan akan dirangkum malam nanti 💌`, persons);
}

function formatRecap(persons, wishes) {
  const lines = [`💌 *BIRTHDAY RECAP*`, `\nUntuk ${mentionText(persons)}:`, ""];
  if (!wishes?.length) lines.push("Belum ada ucapan yang tercatat — tapi doa baik tetap terkirim 🎂");
  else {
    for (const wish of wishes.slice(0, 30)) {
      lines.push(`• ${wish.senderName || "Warga grup"}: “${String(wish.messageText || "").slice(0, 300)}”`);
    }
  }
  return result(lines.join("\n"), persons);
}

function formatClosing(persons) {
  return result(`🌙 *BIRTHDAY TAKEOVER SELESAI*\n\nTerima kasih sudah ikut merayakan ${mentionText(persons)}. Selamat ulang tahun sekali lagi 🎂✨`, persons);
}

module.exports = {
  formatOpening,
  formatSong,
  formatCard,
  formatSpotlight,
  formatReminder,
  formatWishesOpen,
  formatRecap,
  formatClosing,
};
