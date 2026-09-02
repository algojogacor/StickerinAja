const {
  extractPackName,
  getTelegramStickerSet,
  downloadTelegramSticker,
  POPULAR_TELEGRAM_PACKS,
} = require('../services/telegramStickerService');

module.exports = {
  names: ['tg', 'telegram', 'tgpack'],

  async execute({ sock, msg, args, remoteJid, ctx, PREFIX }) {
    const logger = ctx?.logger;
    const input = args[0] ? args[0].trim() : '';

    if (!input) {
      const popularList = POPULAR_TELEGRAM_PACKS.map((p) => `• *${PREFIX || '!'}tg ${p}*`).join('\n');
      return sock.sendMessage(
        remoteJid,
        {
          text: `🎭 *TELEGRAM STICKER IMPORTER*\n\n` +
            `Gunakan perintah ini untuk mengambil stiker lucu/absurd dari Telegram langsung ke WhatsApp!\n\n` +
            `📌 *Format:* \`${PREFIX || '!'}tg <nama_pack atau link t.me>\`\n\n` +
            `💡 *Contoh:* \n` +
            `• \`${PREFIX || '!'}tg wunkus\`\n` +
            `• \`${PREFIX || '!'}tg https://t.me/addstickers/spongebob\`\n\n` +
            `🔥 *Rekomendasi Pack Populer:*\n${popularList}\n\n` +
            `_Catatan: Membutuhkan TELEGRAM_BOT_TOKEN di .env (bisa dibuat gratis dalam 10 detik via @BotFather)._`,
        },
        { quoted: msg }
      );
    }

    try {
      const packName = extractPackName(input);
      if (!packName) {
        return sock.sendMessage(
          remoteJid,
          { text: `⚠️ Link atau nama pack stiker Telegram tidak valid.` },
          { quoted: msg }
        );
      }

      await sock.sendMessage(
        remoteJid,
        { text: `⏳ *Mengambil stiker dari Telegram pack "${packName}"...*` },
        { quoted: msg }
      );

      const set = await getTelegramStickerSet(packName, { logger });
      if (!set.stickers || set.stickers.length === 0) {
        return sock.sendMessage(
          remoteJid,
          { text: `❌ Pack Telegram "${packName}" tidak memiliki stiker.` },
          { quoted: msg }
        );
      }

      // Pick up to 2 random stickers from the pack to send
      const staticStickers = set.stickers.filter((s) => !s.is_animated && !s.is_video);
      const pool = staticStickers.length > 0 ? staticStickers : set.stickers;
      const shuffled = [...pool].sort(() => Math.random() - 0.5);
      const toSend = shuffled.slice(0, 2);

      for (const stickerItem of toSend) {
        const buffer = await downloadTelegramSticker(stickerItem.file_id, { logger });
        await sock.sendMessage(remoteJid, { sticker: buffer }, { quoted: msg });
        await new Promise((r) => setTimeout(r, 600));
      }

      logger?.info({ packName, sent: toSend.length }, '[Telegram Sticker] Sent stickers successfully');
    } catch (err) {
      logger?.error({ err: err.message }, '[Telegram Sticker] Error');
      return sock.sendMessage(
        remoteJid,
        { text: `❌ *Gagal mengambil stiker Telegram*\n\nAlasan: ${err.message}` },
        { quoted: msg }
      );
    }
  },
};
