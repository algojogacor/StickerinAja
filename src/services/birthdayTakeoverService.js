// Birthday Takeover Service — checks if cron should be suppressed for birthday.
const bday = require('./birthdayService');

async function shouldSuppressCron(groupJid, jobName) {
    if (!groupJid) return false;
    const active = await bday.isTakeoverActive(groupJid);
    return active;
}

module.exports = { shouldSuppressCron };
