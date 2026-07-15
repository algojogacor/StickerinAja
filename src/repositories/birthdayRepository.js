const { getTursoClient } = require("../core/tursoClient");

let initialized = false;
let persistent = false;
let initializationPromise = null;
const birthdayMemory = new Map();
const takeoverMemory = new Map();
const wishMemory = new Map();

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
  };
}

function mapTakeover(row) {
  if (!row) return null;
  let sentEvents = row.sentEvents;
  if (typeof sentEvents === "string") {
    try { sentEvents = JSON.parse(sentEvents || "[]"); } catch { sentEvents = []; }
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
      ], "write");
      // Existing installations may have the table without this newer column.
      try {
        await client.execute("ALTER TABLE birthday_takeover ADD COLUMN wish_message_id TEXT");
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
  if (persistent && client) {
    await client.execute({
      sql: `INSERT INTO birthdays
        (group_jid, participant_id, name, birth_day, birth_month, birth_year, enabled, created_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(group_jid, participant_id) DO UPDATE SET
          name=excluded.name, birth_day=excluded.birth_day, birth_month=excluded.birth_month,
          birth_year=excluded.birth_year, enabled=1, created_by=excluded.created_by,
          updated_at=CURRENT_TIMESTAMP`,
      args: [record.groupJid, record.participantId, record.name, record.birthDay, record.birthMonth, record.birthYear || null, record.createdBy || ""],
    });
  }
  groupMap(record.groupJid).set(record.participantId, { ...record, enabled: true });
}

async function updateBirthday(groupJid, participantId, updates) {
  await ensureInit();
  const current = groupMap(groupJid).get(participantId) || {};
  const next = { ...current, ...updates, groupJid, participantId, enabled: true };
  const client = getTursoClient();
  if (persistent && client) {
    await client.execute({
      sql: `UPDATE birthdays SET name=?, birth_day=?, birth_month=?, birth_year=?, updated_at=CURRENT_TIMESTAMP
            WHERE group_jid=? AND participant_id=?`,
      args: [next.name || "", next.birthDay, next.birthMonth, next.birthYear || null, groupJid, participantId],
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
  };
  const client = getTursoClient();
  if (persistent && client) {
    await client.execute({
      sql: `INSERT INTO birthday_takeover
        (group_jid, takeover_date, birthday_person_ids, birthday_person_names, is_active, sent_events, cron_suppressed, wish_message_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(group_jid, takeover_date) DO UPDATE SET
          birthday_person_ids=excluded.birthday_person_ids,
          birthday_person_names=excluded.birthday_person_names,
          is_active=excluded.is_active, sent_events=excluded.sent_events,
          cron_suppressed=excluded.cron_suppressed, wish_message_id=excluded.wish_message_id`,
      args: [groupJid, dateStr, next.birthdayPersonIds, next.birthdayPersonNames, next.isActive ? 1 : 0, JSON.stringify(next.sentEvents), next.cronSuppressed ? 1 : 0, next.wishMessageId],
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

async function resetForTests() {
  birthdayMemory.clear();
  takeoverMemory.clear();
  wishMemory.clear();
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
  markCelebrated,
  getTakeoverState,
  setTakeoverState,
  addWish,
  getWishes,
  resetForTests,
};
