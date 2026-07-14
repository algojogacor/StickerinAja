// Scheduler registry — manages all group scheduler lifecycles.
const { GroupScheduler } = require('../scheduler/groupScheduler');
const { FootballScheduler } = require('../scheduler/footballScheduler');
const { BirthdayScheduler } = require('../scheduler/birthdayScheduler');

let scheduler = null, footballScheduler = null, birthdayScheduler = null;

function registerSchedulers({ logger }) {
    const groupJid = process.env.GROUP_JID || '';
    if (!groupJid) {
        logger.warn('⚠️ GROUP_JID not set — all schedulers disabled');
        return { onConnectionChange: () => {} };
    }

    scheduler = new GroupScheduler({
        logger, groupJid,
        entertainmentCount: parseInt(process.env.ENTERTAINMENT_COUNT || '8', 10),
        startHour: parseInt(process.env.ENTERTAINMENT_START_HOUR || '8', 10),
        endHour: parseInt(process.env.ENTERTAINMENT_END_HOUR || '22', 10),
        includeYoMama: process.env.INCLUDE_YO_MAMA === 'true'
    });

    footballScheduler = new FootballScheduler({ logger, groupJid });
    birthdayScheduler = new BirthdayScheduler({ logger, groupJid });

    logger.info('🕒 Scheduler registry ready (news + entertainment + football + birthday)');

    return {
        onConnectionChange: ({ status, sock }) => {
            if (status === 'connected') {
                logger.info('🔌 Connection detected — starting all schedulers');
                scheduler.start();
                footballScheduler.start();
                birthdayScheduler.start();
            } else if (status === 'disconnected') {
                logger.info('🔌 Disconnection detected — stopping all schedulers');
                scheduler.stop();
                footballScheduler.stop();
                birthdayScheduler.stop();
            }
        }
    };
}

module.exports = { registerSchedulers };
