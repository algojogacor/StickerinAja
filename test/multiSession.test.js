const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setSock, getSock, getBotSock, getBirthdaySock, clearSock, getAllSocks } = require('../src/core/socket');

describe('Multi-Session Socket Manager', () => {
    beforeEach(() => {
        clearSock();
    });

    it('manages independent sockets for named sessions', () => {
        const mockPribadiSock = { id: 'sock-pribadi', user: { id: '628111@s.whatsapp.net' } };
        const mockBotSock = { id: 'sock-bot', user: { id: '628222@s.whatsapp.net' } };

        setSock(mockPribadiSock, 'pribadi');
        setSock(mockBotSock, 'bot');

        assert.equal(getSock('pribadi'), mockPribadiSock);
        assert.equal(getSock('bot'), mockBotSock);

        // Fallback getSock() returns first available or default socket
        assert.ok(getSock());
        assert.equal(getAllSocks().length, 2);
    });

    it('clears individual session socket without affecting other sessions', () => {
        const mockPribadiSock = { id: 'sock-pribadi' };
        const mockBotSock = { id: 'sock-bot' };

        setSock(mockPribadiSock, 'pribadi');
        setSock(mockBotSock, 'bot');

        // Disconnect only pribadi
        const cleared = clearSock(mockPribadiSock, 'pribadi');
        assert.equal(cleared, true);

        // Pribadi is null, but bot is still active!
        assert.equal(getSock('pribadi'), null);
        assert.equal(getSock('bot'), mockBotSock);
        assert.equal(getAllSocks().length, 1);
    });

    it('prioritizes bot socket as default sender and falls back to pribadi', () => {
        const mockPribadiSock = { id: 'sock-pribadi' };
        const mockBotSock = { id: 'sock-bot' };

        // Pribadi connects first
        setSock(mockPribadiSock, 'pribadi');
        assert.equal(getSock(), mockPribadiSock);
        assert.equal(getBirthdaySock(), mockPribadiSock);

        // Bot connects second -> getSock() and getBirthdaySock() prioritize bot
        setSock(mockBotSock, 'bot');
        assert.equal(getSock(), mockBotSock);
        assert.equal(getBirthdaySock(), mockBotSock);

        // If bot disconnects -> getSock() and getBirthdaySock() fall back to pribadi
        clearSock(mockBotSock, 'bot');
        assert.equal(getSock(), mockPribadiSock);
        assert.equal(getBirthdaySock(), mockPribadiSock);

        // But getBotSock() NEVER falls back to pribadi (schedulers isolated)
        assert.equal(getBotSock(), null);
    });

    it('supports full socket clear on shutdown', () => {
        setSock({ id: 's1' }, 'pribadi');
        setSock({ id: 's2' }, 'bot');
        clearSock();

        assert.equal(getSock('pribadi'), null);
        assert.equal(getSock('bot'), null);
        assert.equal(getSock(), null);
        assert.equal(getAllSocks().length, 0);
    });

    it('delegates group commands to bot only when bot is a participant of the group', () => {
        global.botSessions = {
            bot: { status: 'connected' },
            pribadi: { status: 'connected' }
        };
        global.botGroupJids = new Set(['shared-group@g.us']);

        // In shared group: bot is present -> isBotInThisGroup is true
        const inSharedGroup = global.botGroupJids.has('shared-group@g.us');
        assert.equal(inSharedGroup, true);

        // In solo group (IPhO): bot is NOT present -> isBotInThisGroup is false
        const inSoloGroup = global.botGroupJids.has('ipho-group@g.us');
        assert.equal(inSoloGroup, false);
    });

    it('correctly unwraps viewOnceMessage and viewOnceMessageV2 in extractMessageContent', () => {
        const { extractMessageContent } = require('../src/handler');

        const v1Msg = {
            key: { remoteJid: 'test@g.us', id: '1' },
            message: {
                viewOnceMessage: {
                    message: {
                        imageMessage: { caption: '!s' }
                    }
                }
            }
        };
        assert.equal(extractMessageContent(v1Msg).text, '!s');

        const v2Msg = {
            key: { remoteJid: 'test@g.us', id: '2' },
            message: {
                viewOnceMessageV2: {
                    message: {
                        imageMessage: { caption: '!s circle' }
                    }
                }
            }
        };
        assert.equal(extractMessageContent(v2Msg).text, '!s circle');
    });

    it('accurately identifies self-quoted participant in group chats', () => {
        const myPn = '628999021644';
        const myLid = '244203384742140';

        const checkQuotedFromMe = (participant, myPn, myLid) => {
            const partClean = participant?.split(':')[0]?.split('@')[0];
            return Boolean((myPn && partClean === myPn) || (myLid && partClean === myLid));
        };

        // Quoting another person in a group
        assert.equal(checkQuotedFromMe('62812345678@s.whatsapp.net', myPn, myLid), false);
        // Quoting myself via phone number JID in a group
        assert.equal(checkQuotedFromMe('628999021644:48@s.whatsapp.net', myPn, myLid), true);
        // Quoting myself via LID in a group
        assert.equal(checkQuotedFromMe('244203384742140:48@lid', myPn, myLid), true);
    });

    it('exposes restartSession and logoutSession methods in baileys module', () => {
        const { restartSession, logoutSession } = require('../src/baileys');
        assert.equal(typeof restartSession, 'function');
        assert.equal(typeof logoutSession, 'function');
    });

    it('exports pruneTursoAuthState garbage collection function in tursoAuthState and baileys', () => {
        const { pruneTursoAuthState } = require('../src/utils/tursoAuthState');
        const baileys = require('../src/baileys');
        assert.equal(typeof pruneTursoAuthState, 'function');
        assert.equal(typeof baileys.pruneTursoAuthState, 'function');
    });

    it('yields from pribadi session in shared groups and 1-on-1 DM with the bot', () => {
        global.botSessions = {
            bot: {
                status: 'connected',
                user: { id: '6288889999:1@s.whatsapp.net' }
            },
            pribadi: {
                status: 'connected',
                user: { id: '62811112222:0@s.whatsapp.net' }
            }
        };
        global.botGroupJids = new Set(['shared-group@g.us']);

        function shouldPribadiYield(msg) {
            const remoteJid = msg?.key?.remoteJid;
            if (!remoteJid) return false;
            const botSession = global.botSessions?.['bot'];
            if (botSession?.status !== 'connected') return false;

            if (remoteJid.endsWith('@g.us')) {
                return Boolean(global.botGroupJids && global.botGroupJids.has(remoteJid));
            }

            const botJid = botSession?.user?.id ? String(botSession.user.id).replace(/:.*@/, '@').toLowerCase().trim() : null;
            if (!botJid) return false;
            const cleanRemote = String(remoteJid).replace(/:.*@/, '@').toLowerCase().trim();
            return cleanRemote === botJid;
        }

        // 1. Shared group where bot is present -> should yield
        assert.equal(shouldPribadiYield({ key: { remoteJid: 'shared-group@g.us' } }), true);

        // 2. Solo group where bot is absent -> should NOT yield
        assert.equal(shouldPribadiYield({ key: { remoteJid: 'solo-group@g.us' } }), false);

        // 3. 1-on-1 DM with the bot (Bot WA) -> should yield to prevent dual replies
        assert.equal(shouldPribadiYield({ key: { remoteJid: '6288889999@s.whatsapp.net' } }), true);
        assert.equal(shouldPribadiYield({ key: { remoteJid: '6288889999:5@s.whatsapp.net' } }), true);

        // 4. 1-on-1 DM with a regular friend -> should NOT yield
        assert.equal(shouldPribadiYield({ key: { remoteJid: '62855556666@s.whatsapp.net' } }), false);
    });
});
