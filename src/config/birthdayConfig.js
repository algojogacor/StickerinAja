const BOT_TIMEZONE = process.env.BOT_TIMEZONE || "Asia/Jakarta";

const EVENT_SCHEDULES = [
  { id: "opening_quest", time: "07:00" },
  { id: "song", time: "09:00" },
  { id: "memory_wall", time: "12:00" },
  { id: "truth_questions", time: "14:00" },
  { id: "photo_story", time: "15:00" },
  { id: "roast_session", time: "16:00" },
  { id: "dm_outreach", time: "17:00" },
  { id: "confess_reveal", time: "18:00" },
  { id: "wish_jar", time: "20:00" },
  { id: "grand_recap", time: "21:00" },
  { id: "closing_quest", time: "23:00" },
  { id: "midnight_letter", time: "00:00" },
  { id: "narrator_letter", time: "02:00" },
];

const BIRTHDAY_QUESTS = [
  "Kirim foto makan siang atau sarapan spesial lo hari ini ke grup!",
  "Kirim 1 foto selfie muka paling bahagia hari ini ke grup!",
  "Kirim Voice Note (VN) nyanyi 1 bait lagu favorit lo ke grup!",
  "Share 1 hal atau momen yang paling lo syukuri hari ini ke grup!",
  "Kirim 1 foto pose gaya bebas paling ikonik hari ini!",
];

const BIRTHDAY_PENALTIES = [
  "Traktir es teh / kopi virtual untuk seluruh warga grup di mimpi masing-masing malam ini!",
  "Wajib mendoakan semua warga grup cepet kaya dan bahagia sebelum lo tidur nanti!",
  "Kena denda menyanyikan lagu selamat ulang tahun dalam hati sebanyak 3 kali berturut-turut!",
  "Wajib tersenyum lebar ke kaca selama 10 detik saat bangun besok pagi!",
];

function isEnabled(name, fallback = true) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value !== "false";
}

function getConfig() {
  return {
    BOT_TIMEZONE,
    BIRTHDAY_FEATURE_ENABLED: isEnabled("BIRTHDAY_FEATURE_ENABLED"),
    BIRTHDAY_TAKEOVER_ENABLED: isEnabled("BIRTHDAY_TAKEOVER_ENABLED"),
    BIRTHDAY_TARGET_JID: process.env.BIRTHDAY_TARGET_JID || "",
    BIRTHDAY_SONG_URL: process.env.BIRTHDAY_SONG_URL || "",
    BIRTHDAY_AUDIO_PATH: process.env.BIRTHDAY_AUDIO_PATH || "./assets/birthday/selamat_ulang_tahun.mp3",
    BIRTHDAY_CARD_PATH: process.env.BIRTHDAY_CARD_PATH || "",
    BIRTHDAY_STICKER_PATH: process.env.BIRTHDAY_STICKER_PATH || "",
    BIRTHDAY_WISH_MAX_LENGTH: Math.max(
      50,
      Math.min(2000, Number.parseInt(process.env.BIRTHDAY_WISH_MAX_LENGTH || "500", 10) || 500)
    ),
    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || "",
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || "",
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || "",
    BIRTHDAY_TRUTH_MAX_QUESTIONS: Math.max(
      1,
      Number.parseInt(process.env.BIRTHDAY_TRUTH_MAX_QUESTIONS || "5", 10) || 5
    ),
    EVENT_SCHEDULES,
    BIRTHDAY_QUESTS,
    BIRTHDAY_PENALTIES,
  };
}

module.exports = {
  BOT_TIMEZONE,
  EVENT_SCHEDULES,
  getConfig,
};
