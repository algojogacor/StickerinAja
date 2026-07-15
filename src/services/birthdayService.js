const repository = require("../repositories/birthdayRepository");
const { getConfig } = require("../config/birthdayConfig");

function getWIBToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: getConfig().BOT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return { year, month, day, dateStr: `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}` };
}

function normalizeGroupJid(groupJid) {
  const value = String(groupJid || "").trim();
  if (!value.endsWith("@g.us")) throw new Error("Birthday data hanya boleh disimpan untuk group");
  return value;
}

function validateDate(day, month) {
  const d = Number(day);
  const m = Number(month);
  if (!Number.isInteger(d) || !Number.isInteger(m) || m < 1 || m > 12 || d < 1 || d > 31) {
    throw new Error("Tanggal ulang tahun tidak valid");
  }
  const maxDay = new Date(Date.UTC(2000, m, 0)).getUTCDate();
  if (d > maxDay) throw new Error("Tanggal ulang tahun tidak valid untuk bulan tersebut");
  return { day: d, month: m };
}

function sanitizeName(name, participantId) {
  const value = String(name || participantId?.split("@")[0] || "Unknown")
    .replace(/[\r\n]/g, " ")
    .replace(/[^\p{L}\p{N} _.-]/gu, "")
    .trim()
    .slice(0, 80);
  return value || "Unknown";
}

function isEnabled() {
  const config = getConfig();
  return config.BIRTHDAY_FEATURE_ENABLED && config.BIRTHDAY_TAKEOVER_ENABLED;
}

async function addBirthday(groupJid, participantId, name, day, month, year, createdBy) {
  const group = normalizeGroupJid(groupJid);
  const participant = String(participantId || "").trim();
  if (!participant.includes("@s.whatsapp.net")) throw new Error("Participant ulang tahun tidak valid");
  const date = validateDate(day, month);
  const birthYear = year === undefined || year === null || year === "" ? null : Number(year);
  if (birthYear !== null && (!Number.isInteger(birthYear) || birthYear < 1900 || birthYear > new Date().getFullYear())) {
    throw new Error("Tahun lahir tidak valid");
  }
  const record = {
    groupJid: group,
    participantId: participant,
    name: sanitizeName(name, participant),
    birthDay: date.day,
    birthMonth: date.month,
    birthYear,
    createdBy: String(createdBy || "").slice(0, 120),
  };
  await repository.addBirthday(record);
  return record;
}

async function updateBirthday(groupJid, participantId, updates) {
  const group = normalizeGroupJid(groupJid);
  const participant = String(participantId || "").trim();
  if (!participant.includes("@s.whatsapp.net")) throw new Error("Participant ulang tahun tidak valid");
  const current = (await repository.getBirthdays(group)).find((row) => row.participantId === participant);
  if (!current) throw new Error("Data ulang tahun tidak ditemukan");
  const date = validateDate(updates.birthDay ?? current.birthDay, updates.birthMonth ?? current.birthMonth);
  await repository.updateBirthday(group, participant, {
    name: updates.name === undefined ? current.name : sanitizeName(updates.name, participant),
    birthDay: date.day,
    birthMonth: date.month,
    birthYear: updates.birthYear === undefined ? current.birthYear : (updates.birthYear || null),
  });
}

async function removeBirthday(groupJid, participantId) {
  await repository.removeBirthday(normalizeGroupJid(groupJid), participantId);
}

async function getBirthdaysList(groupJid) {
  return repository.getBirthdays(normalizeGroupJid(groupJid));
}

async function getTodayBirthdays(groupJid) {
  const today = getWIBToday();
  const rows = await getBirthdaysList(groupJid);
  return rows.filter((row) => row.birthDay === today.day && row.birthMonth === today.month && row.lastCelebratedYear !== today.year);
}

async function getTomorrowBirthdays(groupJid) {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const target = getWIBToday(tomorrow);
  const rows = await getBirthdaysList(groupJid);
  return rows.filter((row) => row.birthDay === target.day && row.birthMonth === target.month);
}

function personsFromState(state) {
  if (!state) return [];
  const ids = String(state.birthdayPersonIds || "").split(",").filter(Boolean);
  const names = String(state.birthdayPersonNames || "").split("|||");
  return ids.map((participantId, index) => ({ participantId, name: names[index] || "Unknown" }));
}

async function getState(groupJid) {
  const today = getWIBToday();
  return repository.getTakeoverState(normalizeGroupJid(groupJid), today.dateStr);
}

async function activateTakeover(groupJid, birthdayPersons) {
  const group = normalizeGroupJid(groupJid);
  const people = Array.isArray(birthdayPersons) ? birthdayPersons : [];
  if (people.length === 0) throw new Error("Tidak ada birthday person untuk takeover");
  const today = getWIBToday();
  const existing = await repository.getTakeoverState(group, today.dateStr);
  if (existing?.isActive) return existing;
  const state = {
    birthdayPersonIds: people.map((person) => person.participantId).join(","),
    birthdayPersonNames: people.map((person) => sanitizeName(person.name, person.participantId)).join("|||"),
    isActive: true,
    cronSuppressed: true,
    sentEvents: existing?.sentEvents || [],
    wishMessageId: existing?.wishMessageId || null,
  };
  return repository.setTakeoverState(group, today.dateStr, state);
}

async function evaluateAndActivate(groupJid) {
  if (!isEnabled()) return null;
  const group = normalizeGroupJid(groupJid);
  const today = getWIBToday();
  const existing = await repository.getTakeoverState(group, today.dateStr);
  if (existing) return existing.isActive ? personsFromState(existing) : null;
  const birthdays = await getTodayBirthdays(group);
  if (!birthdays.length) return null;
  await activateTakeover(group, birthdays);
  return birthdays;
}

async function isTakeoverActive(groupJid) {
  if (!isEnabled()) return false;
  const state = await getState(groupJid);
  return Boolean(state?.isActive && state.cronSuppressed);
}

async function getTakeoverBirthdayPersons(groupJid) {
  if (!isEnabled()) return [];
  return personsFromState(await getState(groupJid));
}

async function shouldSuppressCron(groupJid) {
  if (!groupJid || !isEnabled()) return false;
  await evaluateAndActivate(groupJid);
  return isTakeoverActive(groupJid);
}

async function addSentEvent(groupJid, eventName) {
  const group = normalizeGroupJid(groupJid);
  const today = getWIBToday();
  const state = await repository.getTakeoverState(group, today.dateStr);
  if (!state || !state.isActive) return false;
  if (state.sentEvents.includes(eventName)) return false;
  state.sentEvents = [...state.sentEvents, String(eventName).slice(0, 80)];
  await repository.setTakeoverState(group, today.dateStr, state);
  return true;
}

async function hasSentEvent(groupJid, eventName) {
  const state = await getState(groupJid);
  return Boolean(state?.sentEvents?.includes(eventName));
}

async function deactivateTakeover(groupJid) {
  const group = normalizeGroupJid(groupJid);
  const today = getWIBToday();
  const state = await repository.getTakeoverState(group, today.dateStr);
  if (!state) return false;
  await repository.setTakeoverState(group, today.dateStr, { ...state, isActive: false, cronSuppressed: false });
  return true;
}

async function markCelebrated(groupJid, participantId, year = getWIBToday().year) {
  return repository.markCelebrated(normalizeGroupJid(groupJid), participantId, year);
}

async function addWish(wish) {
  const config = getConfig();
  const group = normalizeGroupJid(wish.groupJid);
  const messageText = String(wish.messageText || "").trim().slice(0, config.BIRTHDAY_WISH_MAX_LENGTH);
  if (!messageText) return false;
  await repository.addWish({ ...wish, groupJid: group, messageText });
  return true;
}

async function getWishes(groupJid, eventId) {
  return repository.getWishes(normalizeGroupJid(groupJid), eventId);
}

async function setWishMessageId(groupJid, messageId) {
  const group = normalizeGroupJid(groupJid);
  const today = getWIBToday();
  const state = await repository.getTakeoverState(group, today.dateStr);
  if (!state) return false;
  await repository.setTakeoverState(group, today.dateStr, { ...state, wishMessageId: String(messageId || "").slice(0, 200) });
  return true;
}

async function getWishMessageId(groupJid) {
  return (await getState(groupJid))?.wishMessageId || null;
}

async function recordWishFromMessage(msg) {
  const groupJid = msg?.key?.remoteJid;
  if (!groupJid?.endsWith("@g.us") || !isEnabled()) return false;
  const wishMessageId = await getWishMessageId(groupJid);
  const context = msg.message?.extendedTextMessage?.contextInfo;
  if (!wishMessageId || context?.stanzaId !== wishMessageId) return false;
  const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
  if (!text.trim()) return false;
  return addWish({
    groupJid,
    birthdayEventId: wishMessageId,
    senderId: msg.key.participant || msg.key.remoteJid,
    senderName: msg.pushName || "",
    messageText: text,
    messageId: msg.key.id || `${Date.now()}`,
  });
}

module.exports = {
  getWIBToday,
  addBirthday,
  updateBirthday,
  removeBirthday,
  getBirthdaysList,
  getTodayBirthdays,
  getTomorrowBirthdays,
  activateTakeover,
  evaluateAndActivate,
  isTakeoverActive,
  getTakeoverBirthdayPersons,
  shouldSuppressCron,
  addSentEvent,
  hasSentEvent,
  deactivateTakeover,
  markCelebrated,
  addWish,
  getWishes,
  setWishMessageId,
  recordWishFromMessage,
};
