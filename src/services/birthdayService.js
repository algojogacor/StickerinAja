// Birthday service — manages birthday data, takeover state, celebration logic.
const repo = require('../repositories/birthdayRepository');
const { BIRTHDAY_TAKEOVER_ENABLED } = require('../config/birthdayConfig');

function getWIBToday() {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    return { day: d.getDate(), month: d.getMonth() + 1, year: d.getFullYear(), dateStr: `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}` };
}

async function getTodayBirthdays(groupJid) { return repo.getTodayBirthdays(groupJid); }
async function getTomorrowBirthdays(groupJid) { return repo.getTomorrowBirthdays(groupJid); }
async function getBirthdaysList(groupJid) { return repo.getBirthdays(groupJid); }

async function addBirthday(groupJid, participantId, name, day, month, year, createdBy) {
    await repo.addBirthday({ groupJid, participantId, name, birthDay: day, birthMonth: month, birthYear: year || null, enabled: true, createdBy });
}

async function removeBirthday(groupJid, pid) { await repo.removeBirthday(groupJid, pid); }
async function updateBirthday(groupJid, pid, updates) { await repo.updateBirthday(groupJid, pid, updates); }
async function markCelebrated(groupJid, pid, year) { await repo.markCelebrated(groupJid, pid, year); }

async function isTakeoverActive(groupJid) {
    if (!BIRTHDAY_TAKEOVER_ENABLED) return false;
    const { dateStr } = getWIBToday();
    const state = await repo.getTakeoverState(groupJid, dateStr);
    return state?.isActive === 1 || state?.isActive === true;
}

async function getTakeoverBirthdayPersons(groupJid) {
    if (!BIRTHDAY_TAKEOVER_ENABLED) return [];
    const { dateStr } = getWIBToday();
    const state = await repo.getTakeoverState(groupJid, dateStr);
    if (!state || !(state.isActive === 1 || state.isActive === true)) return [];
    const ids = (state.birthdayPersonIds || '').split(',').filter(Boolean);
    const names = (state.birthdayPersonNames || '').split('|||').filter(Boolean);
    return ids.map((id, i) => ({ participantId: id, name: names[i] || 'Unknown' }));
}

async function activateTakeover(groupJid, birthdayPersons) {
    const { dateStr } = getWIBToday();
    const ids = birthdayPersons.map(p => p.participantId).join(',');
    const names = birthdayPersons.map(p => p.name).join('|||');
    await repo.setTakeoverState(groupJid, dateStr, {
        birthdayPersonIds: ids, birthdayPersonNames: names, isActive: true,
        sentEvents: [], cronSuppressed: true
    });
}

async function addSentEvent(groupJid, eventName) {
    const { dateStr } = getWIBToday();
    const state = await repo.getTakeoverState(groupJid, dateStr);
    if (!state) return;
    const events = state.sentEvents || [];
    if (!events.includes(eventName)) events.push(eventName);
    await repo.setTakeoverState(groupJid, dateStr, { ...state, sentEvents: events });
}

async function hasSentEvent(groupJid, eventName) {
    const { dateStr } = getWIBToday();
    const state = await repo.getTakeoverState(groupJid, dateStr);
    return (state?.sentEvents || []).includes(eventName);
}

async function deactivateTakeover(groupJid) {
    const { dateStr } = getWIBToday();
    const state = await repo.getTakeoverState(groupJid, dateStr);
    if (state) await repo.setTakeoverState(groupJid, dateStr, { ...state, isActive: false, cronSuppressed: false });
}

async function evaluateAndActivate(groupJid) {
    if (!BIRTHDAY_TAKEOVER_ENABLED) return null;
    const birthdays = await getTodayBirthdays(groupJid);
    if (!birthdays.length) return null;
    const active = await isTakeoverActive(groupJid);
    if (!active) await activateTakeover(groupJid, birthdays);
    return birthdays;
}

module.exports = { getWIBToday, getTodayBirthdays, getTomorrowBirthdays, getBirthdaysList,
    addBirthday, removeBirthday, updateBirthday, markCelebrated,
    isTakeoverActive, getTakeoverBirthdayPersons, activateTakeover, deactivateTakeover,
    addSentEvent, hasSentEvent, evaluateAndActivate };
