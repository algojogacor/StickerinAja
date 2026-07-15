const BOT_TIMEZONE = process.env.BOT_TIMEZONE || "Asia/Jakarta";

const EVENT_SCHEDULES = [
  { id: "opening", time: "07:00" },
  { id: "song", time: "09:00" },
  { id: "card", time: "12:00" },
  { id: "spotlight", time: "15:00" },
  { id: "reminder", time: "18:00" },
  { id: "recap", time: "21:00" },
  { id: "closing", time: "22:00" },
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
    BIRTHDAY_SONG_URL: process.env.BIRTHDAY_SONG_URL || "",
    BIRTHDAY_AUDIO_PATH: process.env.BIRTHDAY_AUDIO_PATH || "",
    BIRTHDAY_CARD_PATH: process.env.BIRTHDAY_CARD_PATH || "",
    BIRTHDAY_STICKER_PATH: process.env.BIRTHDAY_STICKER_PATH || "",
    BIRTHDAY_WISH_MAX_LENGTH: Math.max(
      50,
      Math.min(2000, Number.parseInt(process.env.BIRTHDAY_WISH_MAX_LENGTH || "500", 10) || 500)
    ),
    EVENT_SCHEDULES,
  };
}

module.exports = {
  BOT_TIMEZONE,
  EVENT_SCHEDULES,
  getConfig,
};
