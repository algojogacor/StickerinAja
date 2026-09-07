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

function bareJid(value) {
  return String(value || "").trim().replace(/:\d+(?=@)/, "");
}

function isValidParticipant(participant) {
  const p = bareJid(participant);
  return p.endsWith("@s.whatsapp.net") || p.endsWith("@lid");
}

function isEnabled() {
  const config = getConfig();
  return config.BIRTHDAY_FEATURE_ENABLED && config.BIRTHDAY_TAKEOVER_ENABLED;
}

async function addBirthday(groupJid, participantId, name, day, month, year, createdBy, roastOptIn = 0) {
  const group = normalizeGroupJid(groupJid);
  const participant = bareJid(participantId);
  if (!isValidParticipant(participant)) throw new Error("Participant ulang tahun tidak valid");
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
    roastOptIn: roastOptIn ? 1 : 0,
  };
  await repository.addBirthday(record);
  return record;
}

async function updateBirthday(groupJid, participantId, updates) {
  const group = normalizeGroupJid(groupJid);
  const participant = bareJid(participantId);
  if (!isValidParticipant(participant)) throw new Error("Participant ulang tahun tidak valid");
  const current = (await repository.getBirthdays(group)).find((row) => bareJid(row.participantId) === participant);
  if (!current) throw new Error("Data ulang tahun tidak ditemukan");
  const date = validateDate(updates.birthDay ?? current.birthDay, updates.birthMonth ?? current.birthMonth);
  await repository.updateBirthday(group, current.participantId, {
    name: updates.name === undefined ? current.name : sanitizeName(updates.name, participant),
    birthDay: date.day,
    birthMonth: date.month,
    birthYear: updates.birthYear === undefined ? current.birthYear : (updates.birthYear || null),
    roastOptIn: updates.roastOptIn !== undefined ? (updates.roastOptIn ? 1 : 0) : current.roastOptIn,
  });
}

async function removeBirthday(groupJid, participantId) {
  const group = normalizeGroupJid(groupJid);
  const participant = bareJid(participantId);
  const current = (await repository.getBirthdays(group)).find((row) => bareJid(row.participantId) === participant);
  await repository.removeBirthday(group, current ? current.participantId : participant);
}

async function getBirthdaysList(groupJid) {
  return repository.getBirthdays(normalizeGroupJid(groupJid));
}

async function getTodayBirthdays(groupJid) {
  const today = getWIBToday();
  const rows = await getBirthdaysList(groupJid);
  return rows.filter((row) => row.birthDay === today.day && row.birthMonth === today.month && row.lastCelebratedYear !== today.year);
}

async function getTodayBirthdayGroups() {
  const today = getWIBToday();
  return repository.getGroupsWithBirthdaysOn(today.day, today.month);
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
  return repository.markCelebrated(normalizeGroupJid(groupJid), bareJid(participantId), year);
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
    senderId: bareJid(msg?.key?.participant || msg?.key?.remoteJid),
    senderName: msg.pushName || "",
    messageText: text,
    messageId: msg.key.id || `${Date.now()}`,
  });
}

// In-memory caches for active sessions and daily chat logs
const dmSessions = new Map();
const dayChatLogs = new Map();

function parseDmResponse(text) {
  let confess = "";
  let prediction = "";
  const clean = String(text || "").trim();

  const confessMatch = clean.match(/(?:confess|pengakuan|rahasia)[:\s]+([\s\S]*?)(?=(?:prediksi|prediction|harapan|$))/i);
  const predMatch = clean.match(/(?:prediksi|prediction|harapan)[:\s]+([\s\S]*?)$/i);

  if (confessMatch && predMatch) {
    confess = confessMatch[1].trim();
    prediction = predMatch[1].trim();
  } else {
    const parts = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      confess = parts[0];
      prediction = parts.slice(1).join("\n");
    } else {
      confess = clean;
      prediction = clean;
    }
  }
  return { confess, prediction };
}

async function getTakeoverMetadata(groupJid) {
  const state = await getState(groupJid);
  return state?.metadata || {};
}

async function updateTakeoverMetadata(groupJid, updater) {
  const group = normalizeGroupJid(groupJid);
  const today = getWIBToday();
  const state = await repository.getTakeoverState(group, today.dateStr);
  if (!state) return null;
  const currentMeta = state.metadata || {};
  const nextMeta = typeof updater === "function" ? updater(currentMeta) : { ...currentMeta, ...updater };
  state.metadata = nextMeta;
  await repository.setTakeoverState(group, today.dateStr, state);
  return nextMeta;
}

function recordGroupChatMessage(groupJid, senderName, text, timestamp = new Date()) {
  const group = normalizeGroupJid(groupJid);
  const clean = String(text || "").trim();
  if (!clean) return;

  const timeStr = new Intl.DateTimeFormat("id-ID", {
    timeZone: getConfig().BOT_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);

  const logs = dayChatLogs.get(group) || [];
  logs.push(`[${timeStr}] ${senderName || "Member"}: ${clean.slice(0, 400)}`);
  if (logs.length > 500) logs.shift();
  dayChatLogs.set(group, logs);
}

function getGroupChatLog(groupJid) {
  const group = normalizeGroupJid(groupJid);
  return (dayChatLogs.get(group) || []).join("\n");
}

function clearGroupChatLog(groupJid) {
  const group = normalizeGroupJid(groupJid);
  dayChatLogs.delete(group);
}

function startDmSession(participantId, sessionData) {
  const pid = bareJid(participantId);
  const now = Date.now();
  dmSessions.set(pid, {
    groupJid: sessionData.groupJid,
    participantId: pid,
    participantName: sessionData.participantName || "Teman",
    birthdayPersons: sessionData.birthdayPersons || [],
    openedAt: now,
    expiresAt: now + (sessionData.timeoutMs || 5 * 60 * 60 * 1000),
    promptSent: Boolean(sessionData.promptSent),
    completed: false,
  });
  return dmSessions.get(pid);
}

function getDmSession(participantId) {
  const pid = bareJid(participantId);
  const session = dmSessions.get(pid);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    dmSessions.delete(pid);
    return null;
  }
  return session;
}

function clearDmSession(participantId) {
  dmSessions.delete(bareJid(participantId));
}

async function recordDmAnswer(participantId, text) {
  const session = getDmSession(participantId);
  if (!session || session.completed) return false;

  const parsed = parseDmResponse(text);
  const today = getWIBToday();

  // 1. Save Confession (100% anonymous, sender identity stripped)
  if (parsed.confess) {
    await updateTakeoverMetadata(session.groupJid, (meta) => {
      const confessions = Array.isArray(meta.confessions) ? meta.confessions : [];
      confessions.push({
        text: parsed.confess,
        timestamp: Date.now(),
      });
      return { ...meta, confessions };
    });
  }

  // 2. Save Prediction (non-anonymous, sender name included)
  if (parsed.prediction) {
    for (const target of session.birthdayPersons) {
      await repository.addPrediction({
        groupJid: session.groupJid,
        targetParticipantId: target.participantId,
        targetName: target.name,
        predictionYear: today.year + 1,
        senderId: session.participantId,
        senderName: session.participantName,
        predictionText: parsed.prediction,
      });
    }
    await updateTakeoverMetadata(session.groupJid, (meta) => {
      const predictions = Array.isArray(meta.predictions) ? meta.predictions : [];
      predictions.push({
        senderId: session.participantId,
        senderName: session.participantName,
        predictionText: parsed.prediction,
        timestamp: Date.now(),
      });
      return { ...meta, predictions };
    });
  }

  session.completed = true;
  return true;
}

async function recordTruthQuestion(groupJid, fromId, fromName, toId, toName, question, questionMsgId) {
  const group = normalizeGroupJid(groupJid);
  const fid = bareJid(fromId);
  const tid = bareJid(toId);
  let result = null;

  await updateTakeoverMetadata(group, (meta) => {
    const truthData = meta.truthData || { questions: [], quotas: {} };
    const currentQuota = truthData.quotas[fid] || 0;
    if (currentQuota >= 3) {
      result = { error: "quota_exceeded", count: currentQuota };
      return meta;
    }

    truthData.quotas[fid] = currentQuota + 1;
    const qObj = {
      id: questionMsgId || `${Date.now()}`,
      fromId: fid,
      fromName: fromName || "Anggota",
      toId: tid,
      toName: toName || "Target",
      question: String(question || "").trim(),
      answer: null,
      isHonest: false,
      askedAt: Date.now(),
    };
    truthData.questions.push(qObj);
    result = { success: true, question: qObj, quotaRemaining: 3 - truthData.quotas[fid] };
    return { ...meta, truthData };
  });

  return result;
}

async function recordTruthAnswer(groupJid, fromId, text, quotedStanzaId) {
  const group = normalizeGroupJid(groupJid);
  let result = null;
  const clean = String(text || "").trim();
  const isHonest = clean.startsWith("!");
  const answer = isHonest ? clean.slice(1).trim() : clean;

  await updateTakeoverMetadata(group, (meta) => {
    const truthData = meta.truthData || { questions: [], quotas: {} };
    const question = truthData.questions.find((q) => q.id === quotedStanzaId);
    if (!question) {
      result = null;
      return meta;
    }

    question.answer = answer;
    question.isHonest = isHonest;
    question.answeredAt = Date.now();
    result = { success: true, question, isHonest };
    return { ...meta, truthData };
  });

  return result;
}

async function getTruthInteractions(groupJid) {
  const meta = await getTakeoverMetadata(groupJid);
  return meta.truthData?.questions || [];
}

async function recordMemoryWallItem(groupJid, senderId, senderName, text) {
  return updateTakeoverMetadata(groupJid, (meta) => {
    const items = Array.isArray(meta.memoryWall) ? meta.memoryWall : [];
    items.push({
      senderId: bareJid(senderId),
      senderName: senderName || "Teman",
      text: String(text || "").trim(),
      timestamp: Date.now(),
    });
    return { ...meta, memoryWall: items };
  });
}

async function recordWishJarItem(groupJid, senderId, senderName, text) {
  return updateTakeoverMetadata(groupJid, (meta) => {
    const items = Array.isArray(meta.wishJar) ? meta.wishJar : [];
    items.push({
      senderId: bareJid(senderId),
      senderName: senderName || "Teman",
      text: String(text || "").trim(),
      timestamp: Date.now(),
    });
    return { ...meta, wishJar: items };
  });
}

async function recordRoast(groupJid, senderId, senderName, text) {
  return updateTakeoverMetadata(groupJid, (meta) => {
    const items = Array.isArray(meta.roasts) ? meta.roasts : [];
    items.push({
      senderId: bareJid(senderId),
      senderName: senderName || "Teman",
      text: String(text || "").trim(),
      timestamp: Date.now(),
      score: 1,
    });
    return { ...meta, roasts: items };
  });
}

async function recordQuestReply(groupJid, senderId, text) {
  return updateTakeoverMetadata(groupJid, (meta) => {
    return {
      ...meta,
      questReply: {
        senderId: bareJid(senderId),
        text: String(text || "").trim(),
        answeredAt: Date.now(),
      },
    };
  });
}

async function recordPhotoStory(groupJid, storyItem) {
  return updateTakeoverMetadata(groupJid, (meta) => {
    const items = Array.isArray(meta.photoStories) ? meta.photoStories : [];
    items.push(storyItem);
    return { ...meta, photoStories: items };
  });
}

async function checkFlashbackDue(groupJid) {
  const schedule = await repository.getFlashbackSchedule(normalizeGroupJid(groupJid));
  const nextAt = schedule?.nextFlashbackAt || schedule?.next_flashback_at;
  if (!schedule || !nextAt) return true;
  return Date.now() >= new Date(nextAt).getTime();
}

async function advanceFlashbackSchedule(groupJid) {
  const group = normalizeGroupJid(groupJid);
  const now = new Date();
  // Random 3 to 8 weeks (21 to 56 days)
  const randomDays = 21 + Math.floor(Math.random() * 36);
  const nextDate = new Date(now.getTime() + randomDays * 24 * 60 * 60 * 1000);
  await repository.setFlashbackSchedule(group, now.toISOString(), nextDate.toISOString());
  return nextDate;
}

module.exports = {
  bareJid,
  isValidParticipant,
  getWIBToday,
  addBirthday,
  updateBirthday,
  removeBirthday,
  getBirthdaysList,
  getTodayBirthdays,
  getTodayBirthdayGroups,
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
  // New features:
  getTakeoverMetadata,
  updateTakeoverMetadata,
  recordGroupChatMessage,
  getGroupChatLog,
  clearGroupChatLog,
  startDmSession,
  getDmSession,
  clearDmSession,
  recordDmAnswer,
  parseDmResponse,
  recordTruthQuestion,
  recordTruthAnswer,
  getTruthInteractions,
  recordMemoryWallItem,
  recordWishJarItem,
  recordRoast,
  recordQuestReply,
  recordPhotoStory,
  checkFlashbackDue,
  advanceFlashbackSchedule,
};
