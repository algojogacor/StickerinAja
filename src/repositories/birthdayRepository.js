const { getTursoClient } = require("../core/tursoClient");

let initialized = false;
let persistent = false;
let initializationPromise = null;
const birthdayMemory = new Map();
const takeoverMemory = new Map();
const wishMemory = new Map();
const predictionMemory = [];
const memoryPhotos = [];
const flashbackSchedules = new Map();

function groupMap(groupJid) {
  if (!birthdayMemory.has(groupJid)) birthdayMemory.set(groupJid, new Map());
  return birthdayMemory.get(groupJid);
}

function takeoverKey(groupJid, dateStr) {
  return `${groupJid}|${dateStr}`;
}

function mapBirthday(row) {
  return {
    groupJid: row.group_jid ?? row.groupJid,
    participantId: row.participant_id ?? row.participantId,
    name: row.name || "",
    birthDay: Number(row.birth_day ?? row.birthDay),
    birthMonth: Number(row.birth_month ?? row.birthMonth),
    birthYear: row.birth_year ?? row.birthYear ?? null,
    enabled: Boolean(row.enabled ?? true),
    createdBy: row.created_by ?? row.createdBy ?? "",
    lastCelebratedYear: row.last_celebrated_year ?? row.lastCelebratedYear ?? null,
    roastOptIn: Number(row.roast_opt_in ?? row.roastOptIn ?? 0) ? 1 : 0,
  };
}

function mapTakeover(row) {
  if (!row) return null;
  let sentEvents = row.sentEvents;
  if (typeof sentEvents === "string") {
    try { sentEvents = JSON.parse(sentEvents || "[]"); } catch { sentEvents = []; }
  }
  let metadata = row.metadata;
  if (typeof metadata === "string") {
    try { metadata = JSON.parse(metadata || "{}"); } catch { metadata = {}; }
  } else if (!metadata || typeof metadata !== "object") {
    metadata = {};
  }
  return {
    groupJid: row.group_jid ?? row.groupJid,
    takeoverDate: row.takeover_date ?? row.takeoverDate,
    birthdayPersonIds: row.birthday_person_ids ?? row.birthdayPersonIds ?? "",
    birthdayPersonNames: row.birthday_person_names ?? row.birthdayPersonNames ?? "",
    isActive: Boolean(row.is_active ?? row.isActive),
    sentEvents: Array.isArray(sentEvents) ? sentEvents : [],
    cronSuppressed: Boolean(row.cron_suppressed ?? row.cronSuppressed),
    wishMessageId: row.wish_message_id ?? row.wishMessageId ?? null,
    metadata,
  };
}

async function init(logger) {
  if (initialized) return initializationPromise || persistent;
  initialized = true;
  initializationPromise = (async () => {
    const client = getTursoClient();
    if (!client) {
      logger?.warn("[Birthday] Turso unavailable; using memory fallback");
      return false;
    }

    try {
      await client.batch([
      `CREATE TABLE IF NOT EXISTS birthdays (
        group_jid TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        birth_day INTEGER NOT NULL,
        birth_month INTEGER NOT NULL,
        birth_year INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL DEFAULT '',
        last_celebrated_year INTEGER,
        roast_opt_in INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_jid, participant_id)
      )`,
      `CREATE TABLE IF NOT EXISTS birthday_takeover (
        group_jid TEXT NOT NULL,
        takeover_date TEXT NOT NULL,
        birthday_person_ids TEXT NOT NULL DEFAULT '',
        birthday_person_names TEXT NOT NULL DEFAULT '',
        is_active INTEGER NOT NULL DEFAULT 1,
        sent_events TEXT NOT NULL DEFAULT '[]',
        cron_suppressed INTEGER NOT NULL DEFAULT 1,
        wish_message_id TEXT,
        metadata TEXT DEFAULT '{}',
        PRIMARY KEY (group_jid, takeover_date)
      )`,
      `CREATE TABLE IF NOT EXISTS birthday_wishes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_jid TEXT NOT NULL,
        birthday_event_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL DEFAULT '',
        message_text TEXT NOT NULL DEFAULT '',
        message_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (group_jid, birthday_event_id, message_id)
      )`,
      `CREATE TABLE IF NOT EXISTS birthday_predictions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_jid TEXT NOT NULL,
        target_participant_id TEXT NOT NULL,
        target_name TEXT NOT NULL DEFAULT '',
        prediction_year INTEGER NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL DEFAULT '',
        prediction_text TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS group_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_jid TEXT NOT NULL,
        cloudinary_url TEXT NOT NULL,
        cloudinary_public_id TEXT NOT NULL DEFAULT '',
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL DEFAULT '',
        caption TEXT NOT NULL DEFAULT '',
        ai_description TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT 'birthday_story',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS group_flashback_schedules (
        group_jid TEXT PRIMARY KEY,
        last_flashback_at TEXT,
        next_flashback_at TEXT
      )`,
      ], "write");
      // Migrate existing installations safely
      try {
        await client.execute("ALTER TABLE birthday_takeover ADD COLUMN wish_message_id TEXT");
      } catch {}
      try {
        await client.execute("ALTER TABLE birthday_takeover ADD COLUMN metadata TEXT DEFAULT '{}'");
      } catch {}
      try {
        await client.execute("ALTER TABLE birthdays ADD COLUMN roast_opt_in INTEGER DEFAULT 0");
      } catch {}
      persistent = true;
      logger?.info("[Birthday] Turso repository ready");
      return true;
    } catch (error) {
      logger?.warn({ err: error }, "[Birthday] Turso schema unavailable; using memory fallback");
      persistent = false;
      return false;
    }
  })();
  return initializationPromise;
}

async function ensureInit() {
  if (!initialized) await init();
  else if (initializationPromise) await initializationPromise;
}

async function addBirthday(record) {
  await ensureInit();
  const client = getTursoClient();
  const roastOptIn = record.roastOptIn ? 1 : 0;
  if (persistent && client) {
    await client.execute({
      sql: `INSERT INTO birthdays
        (group_jid, participant_id, name, birth_day, birth_month, birth_year, enabled, created_by, roast_opt_in, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(group_jid, participant_id) DO UPDATE SET
          name=excluded.name, birth_day=excluded.birth_day, birth_month=excluded.birth_month,
          birth_year=excluded.birth_year, enabled=1, created_by=excluded.created_by,
          roast_opt_in=excluded.roast_opt_in,
          updated_at=CURRENT_TIMESTAMP`,
      args: [record.groupJid, record.participantId, record.name, record.birthDay, record.birthMonth, record.birthYear || null, record.createdBy || "", roastOptIn],
    });
  }
  groupMap(record.groupJid).set(record.participantId, { ...record, enabled: true, roastOptIn: Boolean(roastOptIn) });
}

async function updateBirthday(groupJid, participantId, updates) {
  await ensureInit();
  const current = groupMap(groupJid).get(participantId) || {};
  const next = { ...current, ...updates, groupJid, participantId, enabled: true };
  const roastOptIn = next.roastOptIn ? 1 : 0;
  const client = getTursoClient();
  if (persistent && client) {
    await client.execute({
      sql: `UPDATE birthdays SET name=?, birth_day=?, birth_month=?, birth_year=?, roast_opt_in=?, updated_at=CURRENT_TIMESTAMP
            WHERE group_jid=? AND participant_id=?`,
      args: [next.name || "", next.birthDay, next.birthMonth, next.birthYear || null, roastOptIn, groupJid, participantId],
    });
  }
  groupMap(groupJid).set(participantId, next);
}

async function removeBirthday(groupJid, participantId) {
  await ensureInit();
  const client = getTursoClient();
  if (persistent && client) {
    await client.execute({ sql: "DELETE FROM birthdays WHERE group_jid=? AND participant_id=?", args: [groupJid, participantId] });
  }
  birthdayMemory.get(groupJid)?.delete(participantId);
}

async function getBirthdays(groupJid) {
  await ensureInit();
  const client = getTursoClient();
  if (persistent && client) {
    const result = await client.execute({ sql: "SELECT * FROM birthdays WHERE group_jid=? AND enabled=1", args: [groupJid] });
    return result.rows.map(mapBirthday);
  }
  return [...(birthdayMemory.get(groupJid)?.values() || [])]
    .filter((record) => record.enabled !== false)
    .map(mapBirthday);
}

async function getGroupsWithBirthdaysOn(day, month) {
  await ensureInit();
  const d = Number(day);
  const m = Number(month);
  const client = getTursoClient();
  if (persistent && client) {
    const result = await client.execute({
      sql: "SELECT DISTINCT group_jid FROM birthdays WHERE birth_day=? AND birth_month=? AND enabled=1",
      args: [d, m],
    });
    return result.rows.map((r) => r.group_jid ?? r.groupJid);
  }
  const groups = new Set();
  for (const [gJid, map] of birthdayMemory.entries()) {
    for (const record of map.values()) {
      if (record.enabled !== false && Number(record.birthDay) === d && Number(record.birthMonth) === m) {
        groups.add(gJid);
      }
    }
  }
  return [...groups];
}

async function markCelebrated(groupJid, participantId, year) {
  await ensureInit();
  const client = getTursoClient();
  if (persistent && client) {
    await client.execute({ sql: "UPDATE birthdays SET last_celebrated_year=?, updated_at=CURRENT_TIMESTAMP WHERE group_jid=? AND participant_id=?", args: [year, groupJid, participantId] });
  }
  const record = birthdayMemory.get(groupJid)?.get(participantId);
  if (record) record.lastCelebratedYear = year;
}

async function getTakeoverState(groupJid, dateStr) {
  await ensureInit();
  const client = getTursoClient();
  if (persistent && client) {
    const result = await client.execute({ sql: "SELECT * FROM birthday_takeover WHERE group_jid=? AND takeover_date=?", args: [groupJid, dateStr] });
    return mapTakeover(result.rows[0]);
  }
  return mapTakeover(takeoverMemory.get(takeoverKey(groupJid, dateStr)));
}

async function setTakeoverState(groupJid, dateStr, state) {
  await ensureInit();
  const next = {
    groupJid, takeoverDate: dateStr,
    birthdayPersonIds: state.birthdayPersonIds || "",
    birthdayPersonNames: state.birthdayPersonNames || "",
    isActive: Boolean(state.isActive),
    sentEvents: Array.isArray(state.sentEvents) ? state.sentEvents : [],
    cronSuppressed: state.cronSuppressed !== false,
    wishMessageId: state.wishMessageId || null,
    metadata: state.metadata || {},
  };
  const client = getTursoClient();
  if (persistent && client) {
    await client.execute({
      sql: `INSERT INTO birthday_takeover
        (group_jid, takeover_date, birthday_person_ids, birthday_person_names, is_active, sent_events, cron_suppressed, wish_message_id, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(group_jid, takeover_date) DO UPDATE SET
          birthday_person_ids=excluded.birthday_person_ids,
          birthday_person_names=excluded.birthday_person_names,
          is_active=excluded.is_active, sent_events=excluded.sent_events,
          cron_suppressed=excluded.cron_suppressed, wish_message_id=excluded.wish_message_id,
          metadata=excluded.metadata`,
      args: [groupJid, dateStr, next.birthdayPersonIds, next.birthdayPersonNames, next.isActive ? 1 : 0, JSON.stringify(next.sentEvents), next.cronSuppressed ? 1 : 0, next.wishMessageId, JSON.stringify(next.metadata)],
    });
  }
  takeoverMemory.set(takeoverKey(groupJid, dateStr), next);
  return next;
}

async function addWish(wish) {
  await ensureInit();
  const client = getTursoClient();
  const record = { ...wish, messageText: wish.messageText || "" };
  if (persistent && client) {
    await client.execute({
      sql: `INSERT OR IGNORE INTO birthday_wishes
        (group_jid, birthday_event_id, sender_id, sender_name, message_text, message_id)
        VALUES (?, ?, ?, ?, ?, ?)`,
      args: [record.groupJid, record.birthdayEventId, record.senderId, record.senderName || "", record.messageText, record.messageId || ""],
    });
  }
  const key = `${record.groupJid}|${record.birthdayEventId}`;
  const rows = wishMemory.get(key) || [];
  if (!rows.some((row) => row.messageId === record.messageId)) rows.push(record);
  wishMemory.set(key, rows);
}

async function getWishes(groupJid, eventId) {
  await ensureInit();
  const client = getTursoClient();
  if (persistent && client) {
    const result = await client.execute({ sql: "SELECT * FROM birthday_wishes WHERE group_jid=? AND birthday_event_id=? ORDER BY id ASC", args: [groupJid, eventId] });
    return result.rows.map((row) => ({
      senderId: row.sender_id,
      senderName: row.sender_name,
      messageText: row.message_text,
      messageId: row.message_id,
    }));
  }
  return [...(wishMemory.get(`${groupJid}|${eventId}`) || [])];
}

async function addPrediction(prediction) {
  await ensureInit();
  const client = getTursoClient();
  const record = {
    groupJid: prediction.groupJid,
    targetParticipantId: prediction.targetParticipantId,
    targetName: prediction.targetName || "",
    predictionYear: Number(prediction.predictionYear),
    senderId: prediction.senderId,
    senderName: prediction.senderName || "",
    predictionText: prediction.predictionText || "",
  };
  if (persistent && client) {
    await client.execute({
      sql: `INSERT INTO birthday_predictions
        (group_jid, target_participant_id, target_name, prediction_year, sender_id, sender_name, prediction_text)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [record.groupJid, record.targetParticipantId, record.targetName, record.predictionYear, record.senderId, record.senderName, record.predictionText],
    });
  }
  predictionMemory.push({ ...record, id: predictionMemory.length + 1, createdAt: new Date().toISOString() });
  return record;
}

async function getPredictionsByYear(groupJid, targetParticipantId, predictionYear) {
  await ensureInit();
  const client = getTursoClient();
  const y = Number(predictionYear);
  if (persistent && client) {
    const result = await client.execute({
      sql: "SELECT * FROM birthday_predictions WHERE group_jid=? AND target_participant_id=? AND prediction_year=? ORDER BY id ASC",
      args: [groupJid, targetParticipantId, y],
    });
    return result.rows.map((row) => ({
      id: row.id,
      groupJid: row.group_jid,
      targetParticipantId: row.target_participant_id,
      targetName: row.target_name,
      predictionYear: row.prediction_year,
      senderId: row.sender_id,
      senderName: row.sender_name,
      predictionText: row.prediction_text,
      createdAt: row.created_at,
    }));
  }
  return predictionMemory.filter((p) => p.groupJid === groupJid && p.targetParticipantId === targetParticipantId && p.predictionYear === y);
}

async function getLastYearPredictions(groupJid, targetParticipantId, currentYear) {
  return getPredictionsByYear(groupJid, targetParticipantId, Number(currentYear) - 1);
}

async function addMemoryPhoto(record) {
  await ensureInit();
  const client = getTursoClient();
  const data = {
    groupJid: record.groupJid,
    cloudinaryUrl: record.cloudinaryUrl,
    cloudinaryPublicId: record.cloudinaryPublicId || "",
    senderId: record.senderId,
    senderName: record.senderName || "",
    caption: record.caption || "",
    aiDescription: record.aiDescription || "",
    sourceType: record.sourceType || "birthday_story",
  };
  if (persistent && client) {
    const res = await client.execute({
      sql: `INSERT INTO group_memories
        (group_jid, cloudinary_url, cloudinary_public_id, sender_id, sender_name, caption, ai_description, source_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [data.groupJid, data.cloudinaryUrl, data.cloudinaryPublicId, data.senderId, data.senderName, data.caption, data.aiDescription, data.sourceType],
    });
    return { ...data, id: Number(res.lastInsertRowid || 0) };
  }
  const item = { ...data, id: memoryPhotos.length + 1, createdAt: new Date().toISOString() };
  memoryPhotos.push(item);
  return item;
}

async function getMemoriesForGroup(groupJid, limit = 20) {
  await ensureInit();
  const client = getTursoClient();
  if (persistent && client) {
    const result = await client.execute({
      sql: "SELECT * FROM group_memories WHERE group_jid=? ORDER BY id DESC LIMIT ?",
      args: [groupJid, limit],
    });
    return result.rows.map((row) => ({
      id: row.id,
      groupJid: row.group_jid,
      cloudinaryUrl: row.cloudinary_url,
      cloudinaryPublicId: row.cloudinary_public_id,
      senderId: row.sender_id,
      senderName: row.sender_name,
      caption: row.caption,
      aiDescription: row.ai_description,
      sourceType: row.source_type,
      createdAt: row.created_at,
    }));
  }
  return memoryPhotos.filter((m) => m.groupJid === groupJid).slice(-limit).reverse();
}

async function getRandomMemoryPhoto(groupJid) {
  const all = await getMemoriesForGroup(groupJid, 100);
  if (!all.length) return null;
  const idx = Math.floor(Math.random() * all.length);
  return all[idx];
}

async function getFlashbackSchedule(groupJid) {
  await ensureInit();
  const client = getTursoClient();
  if (persistent && client) {
    const result = await client.execute({
      sql: "SELECT * FROM group_flashback_schedules WHERE group_jid=?",
      args: [groupJid],
    });
    if (result.rows.length) {
      return {
        groupJid: result.rows[0].group_jid,
        lastFlashbackAt: result.rows[0].last_flashback_at,
        nextFlashbackAt: result.rows[0].next_flashback_at,
      };
    }
    return null;
  }
  return flashbackSchedules.get(groupJid) || null;
}

async function setFlashbackSchedule(groupJid, lastFlashbackAt, nextFlashbackAt) {
  await ensureInit();
  const client = getTursoClient();
  if (persistent && client) {
    await client.execute({
      sql: `INSERT INTO group_flashback_schedules (group_jid, last_flashback_at, next_flashback_at)
        VALUES (?, ?, ?)
        ON CONFLICT(group_jid) DO UPDATE SET
          last_flashback_at=excluded.last_flashback_at,
          next_flashback_at=excluded.next_flashback_at`,
      args: [groupJid, lastFlashbackAt, nextFlashbackAt],
    });
  }
  const sched = { groupJid, lastFlashbackAt, nextFlashbackAt };
  flashbackSchedules.set(groupJid, sched);
  return sched;
}

async function resetForTests() {
  birthdayMemory.clear();
  takeoverMemory.clear();
  wishMemory.clear();
  predictionMemory.length = 0;
  memoryPhotos.length = 0;
  flashbackSchedules.clear();
  initialized = false;
  persistent = false;
  initializationPromise = null;
}

module.exports = {
  init,
  addBirthday,
  updateBirthday,
  removeBirthday,
  getBirthdays,
  getGroupsWithBirthdaysOn,
  markCelebrated,
  getTakeoverState,
  setTakeoverState,
  addWish,
  getWishes,
  addPrediction,
  getPredictionsByYear,
  getLastYearPredictions,
  addMemoryPhoto,
  getMemoriesForGroup,
  getRandomMemoryPhoto,
  getFlashbackSchedule,
  setFlashbackSchedule,
  resetForTests,
};
