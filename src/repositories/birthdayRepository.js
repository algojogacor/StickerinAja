// Birthday repository — Turso/fallback persistence for birthday data + takeover state.
const { createClient } = require('@libsql/client');

let client = null, ready = false;
const memory = new Map(); // groupJid → Map of participantId → record
const takeoverMemory = new Map(); // groupJid → takeoverState

function getClient() {
    if (!client) {
        const url = process.env.TURSO_DATABASE_URL;
        const token = process.env.TURSO_AUTH_TOKEN;
        if (url) client = createClient({ url, authToken: token });
    }
    return client;
}

async function init(logger) {
    const c = getClient();
    if (!c) { logger?.warn('Birthday repo: no Turso — memory fallback'); return; }
    try {
        await c.execute(`CREATE TABLE IF NOT EXISTS birthdays (
            group_jid TEXT NOT NULL, participant_id TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '', birth_day INTEGER NOT NULL,
            birth_month INTEGER NOT NULL, birth_year INTEGER,
            enabled INTEGER DEFAULT 1, created_by TEXT,
            last_celebrated_year INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (group_jid, participant_id))`);
        await c.execute(`CREATE TABLE IF NOT EXISTS birthday_takeover (
            group_jid TEXT NOT NULL, takeover_date TEXT NOT NULL,
            birthday_person_ids TEXT NOT NULL, birthday_person_names TEXT NOT NULL,
            is_active INTEGER DEFAULT 1, sent_events TEXT DEFAULT '[]',
            cron_suppressed INTEGER DEFAULT 1,
            PRIMARY KEY (group_jid, takeover_date))`);
        await c.execute(`CREATE TABLE IF NOT EXISTS birthday_wishes (
            id INTEGER PRIMARY KEY AUTOINCREMENT, group_jid TEXT NOT NULL,
            birthday_event_id TEXT NOT NULL, sender_id TEXT NOT NULL,
            sender_name TEXT, message_text TEXT, message_id TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
        ready = true; logger?.info('✅ Birthday repository ready');
    } catch (err) { logger?.warn({ err }, 'Birthday repo init failed — memory fallback'); }
}

// ── Birthday CRUD ───────────────────────────────────

async function addBirthday(rec) {
    const c = getClient();
    if (ready && c) {
        await c.execute({ sql: `INSERT OR REPLACE INTO birthdays (group_jid,participant_id,name,birth_day,birth_month,birth_year,enabled,created_by,updated_at)
            VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
            args: [rec.groupJid, rec.participantId, rec.name, rec.birthDay, rec.birthMonth, rec.birthYear||null, rec.enabled?1:0, rec.createdBy||''] });
    }
    if (!memory.has(rec.groupJid)) memory.set(rec.groupJid, new Map());
    memory.get(rec.groupJid).set(rec.participantId, { ...rec });
}

async function updateBirthday(groupJid, pid, updates) {
    const c = getClient();
    if (ready && c) {
        if (updates.birthDay !== undefined) {
            await c.execute({ sql: `UPDATE birthdays SET birth_day=?,birth_month=?,birth_year=?,updated_at=CURRENT_TIMESTAMP WHERE group_jid=? AND participant_id=?`,
                args: [updates.birthDay, updates.birthMonth, updates.birthYear||null, groupJid, pid] });
        }
        if (updates.name !== undefined) {
            await c.execute({ sql: `UPDATE birthdays SET name=?,updated_at=CURRENT_TIMESTAMP WHERE group_jid=? AND participant_id=?`,
                args: [updates.name, groupJid, pid] });
        }
    }
    const gm = memory.get(groupJid);
    if (gm?.has(pid)) Object.assign(gm.get(pid), updates);
}

async function removeBirthday(groupJid, pid) {
    const c = getClient();
    if (ready && c) {
        await c.execute({ sql: `DELETE FROM birthdays WHERE group_jid=? AND participant_id=?`, args: [groupJid, pid] });
    }
    memory.get(groupJid)?.delete(pid);
}

async function getBirthdays(groupJid) {
    const c = getClient();
    if (ready && c) {
        const r = await c.execute({ sql: `SELECT * FROM birthdays WHERE group_jid=? AND enabled=1`, args: [groupJid] });
        return r.rows.map(row => ({
            groupJid: row.group_jid, participantId: row.participant_id,
            name: row.name, birthDay: row.birth_day, birthMonth: row.birth_month,
            birthYear: row.birth_year, enabled: !!row.enabled,
            createdBy: row.created_by, lastCelebratedYear: row.last_celebrated_year
        }));
    }
    return Array.from(memory.get(groupJid)?.values() || []).filter(r => r.enabled !== false);
}

async function getTodayBirthdays(groupJid) { // WIB today
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const day = d.getDate(), month = d.getMonth() + 1, year = d.getFullYear();
    const all = await getBirthdays(groupJid);
    return all.filter(r => r.birthDay === day && r.birthMonth === month && r.lastCelebratedYear !== year);
}

async function getTomorrowBirthdays(groupJid) {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    d.setDate(d.getDate() + 1);
    const day = d.getDate(), month = d.getMonth() + 1;
    const all = await getBirthdays(groupJid);
    return all.filter(r => r.birthDay === day && r.birthMonth === month);
}

async function markCelebrated(groupJid, pid, year) {
    const c = getClient();
    if (ready && c) {
        await c.execute({ sql: `UPDATE birthdays SET last_celebrated_year=? WHERE group_jid=? AND participant_id=?`,
            args: [year, groupJid, pid] });
    }
    const gm = memory.get(groupJid);
    if (gm?.has(pid)) gm.get(pid).lastCelebratedYear = year;
}

// ── Takeover state ──────────────────────────────────

async function getTakeoverState(groupJid, dateStr) {
    const c = getClient();
    if (ready && c) {
        const r = await c.execute({ sql: `SELECT * FROM birthday_takeover WHERE group_jid=? AND takeover_date=?`, args: [groupJid, dateStr] });
        if (r.rows[0]) return { ...r.rows[0], sentEvents: JSON.parse(r.rows[0].sent_events || '[]') };
    }
    return takeoverMemory.get(`${groupJid}|${dateStr}`) || null;
}

async function setTakeoverState(groupJid, dateStr, state) {
    const c = getClient();
    if (ready && c) {
        await c.execute({ sql: `INSERT OR REPLACE INTO birthday_takeover (group_jid,takeover_date,birthday_person_ids,birthday_person_names,is_active,sent_events,cron_suppressed)
            VALUES (?,?,?,?,?,?,?)`,
            args: [groupJid, dateStr, state.birthdayPersonIds||'', state.birthdayPersonNames||'', state.isActive?1:0, JSON.stringify(state.sentEvents||[]), state.cronSuppressed?1:0] });
    }
    takeoverMemory.set(`${groupJid}|${dateStr}`, state);
}

// ── Wishes ──────────────────────────────────────────

async function addWish(wish) {
    const c = getClient();
    if (ready && c) {
        await c.execute({ sql: `INSERT INTO birthday_wishes (group_jid,birthday_event_id,sender_id,sender_name,message_text,message_id) VALUES (?,?,?,?,?,?)`,
            args: [wish.groupJid, wish.birthdayEventId, wish.senderId, wish.senderName, wish.messageText?.slice(0, 1000) || '', wish.messageId||''] });
    }
}

async function getWishes(groupJid, eventId) {
    const c = getClient();
    if (ready && c) {
        const r = await c.execute({ sql: `SELECT * FROM birthday_wishes WHERE group_jid=? AND birthday_event_id=? ORDER BY created_at`, args: [groupJid, eventId] });
        return r.rows;
    }
    return [];
}

async function getWishReactions(groupJid, eventId) {
    // Reactions are memory-only for simplicity (Baileys reaction events)
    return wishReactionCache.get(`${groupJid}|${eventId}`) || {};
}

const wishReactionCache = new Map();

function addWishReaction(groupJid, eventId, emoji) {
    const key = `${groupJid}|${eventId}`;
    const cur = wishReactionCache.get(key) || {};
    cur[emoji] = (cur[emoji] || 0) + 1;
    wishReactionCache.set(key, cur);
}

module.exports = { init, addBirthday, updateBirthday, removeBirthday, getBirthdays, getTodayBirthdays, getTomorrowBirthdays,
    markCelebrated, getTakeoverState, setTakeoverState, addWish, getWishes, getWishReactions, addWishReaction };
