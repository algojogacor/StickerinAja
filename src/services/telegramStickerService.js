const sharp = require('sharp');
const { addExifToWebp } = require('../utils/exifHelper');

const TELEGRAM_BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || '';

const POPULAR_TELEGRAM_PACKS = [
  'wunkus',
  'catmemes',
  'spongebob',
  'pepe',
  'Doge',
  'CatReactions',
  'flightreacts',
  'indomeme',
];

function extractPackName(input) {
  if (!input) return null;
  const str = String(input).trim();
  const urlMatch = str.match(/(?:t\.me|telegram\.me)\/addstickers\/([a-zA-Z0-9_]+)/i)
    || str.match(/tg:\/\/addstickers\?set=([a-zA-Z0-9_]+)/i);
  if (urlMatch) return urlMatch[1];
  if (/^[a-zA-Z0-9_]+$/.test(str)) return str;
  return null;
}

async function getTelegramStickerSet(packName, { logger } = {}) {
  const token = TELEGRAM_BOT_TOKEN();
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN belum diset di environment. Buat bot gratis di @BotFather di Telegram lalu pasang tokennya.');
  }

  const cleanPack = extractPackName(packName);
  if (!cleanPack) throw new Error('Nama atau tautan pack stiker Telegram tidak valid.');

  const res = await fetch(`https://api.telegram.org/bot${token}/getStickerSet?name=${encodeURIComponent(cleanPack)}`);
  const data = await res.json();

  if (!data.ok || !data.result) {
    throw new Error(`Gagal mengambil pack Telegram: ${data.description || 'Pack tidak ditemukan'}`);
  }

  return data.result;
}

async function downloadTelegramSticker(fileId, { logger } = {}) {
  const token = TELEGRAM_BOT_TOKEN();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN belum diset.');

  const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const fileData = await fileRes.json();

  if (!fileData.ok || !fileData.result?.file_path) {
    throw new Error('File stiker Telegram tidak ditemukan.');
  }

  const downloadUrl = `https://api.telegram.org/file/bot${token}/${fileData.result.file_path}`;
  const imgRes = await fetch(downloadUrl);
  if (!imgRes.ok) throw new Error(`Gagal mendownload stiker Telegram (${imgRes.status})`);

  const rawBuffer = Buffer.from(await imgRes.arrayBuffer());

  // Convert or resize to 512x512 WebP (transparent)
  const webpBuffer = await sharp(rawBuffer)
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 85 })
    .toBuffer();

  const finalSticker = addExifToWebp(
    webpBuffer,
    process.env.STICKERIN_BOT_NAME || 'Telegram Memes',
    process.env.STICKERIN_AUTHOR || 'StickerinAja'
  );

  return finalSticker;
}

async function getRandomTelegramSticker({ packName, logger } = {}) {
  const targetPack = packName || POPULAR_TELEGRAM_PACKS[Math.floor(Math.random() * POPULAR_TELEGRAM_PACKS.length)];
  const set = await getTelegramStickerSet(targetPack, { logger });

  if (!set.stickers || set.stickers.length === 0) {
    throw new Error('Pack stiker Telegram kosong.');
  }

  // Pick non-animated / static webp stickers preferentially
  const staticStickers = set.stickers.filter((s) => !s.is_animated && !s.is_video);
  const candidates = staticStickers.length > 0 ? staticStickers : set.stickers;
  const picked = candidates[Math.floor(Math.random() * candidates.length)];

  return downloadTelegramSticker(picked.file_id, { logger });
}

module.exports = {
  extractPackName,
  getTelegramStickerSet,
  downloadTelegramSticker,
  getRandomTelegramSticker,
  POPULAR_TELEGRAM_PACKS,
};
