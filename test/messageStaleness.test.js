const test = require('node:test');
const assert = require('node:assert/strict');
const { isMessageStale, handler, commands } = require('../src/handler');

test('Message Staleness Detection (isMessageStale)', async (t) => {
    await t.test('considers recent messages (< 120s) as fresh (not stale)', () => {
        const nowSec = Math.floor(Date.now() / 1000);

        assert.equal(isMessageStale({ messageTimestamp: nowSec }), false);
        assert.equal(isMessageStale({ messageTimestamp: nowSec - 10 }), false);
        assert.equal(isMessageStale({ messageTimestamp: nowSec - 60 }), false);
        assert.equal(isMessageStale({ messageTimestamp: nowSec - 119 }), false);
    });

    await t.test('considers messages older than 120s as stale', () => {
        const nowSec = Math.floor(Date.now() / 1000);

        // 130 seconds ago
        assert.equal(isMessageStale({ messageTimestamp: nowSec - 130 }), true);
        // 22 minutes ago (like the first reconnect replay in user incident)
        assert.equal(isMessageStale({ messageTimestamp: nowSec - (22 * 60) }), true);
        // 72 minutes ago (like the second reconnect replay in user incident)
        assert.equal(isMessageStale({ messageTimestamp: nowSec - (72 * 60) }), true);
        // 24 hours ago
        assert.equal(isMessageStale({ messageTimestamp: nowSec - (24 * 3600) }), true);
    });

    await t.test('supports custom maxAgeSeconds threshold', () => {
        const nowSec = Math.floor(Date.now() / 1000);

        assert.equal(isMessageStale({ messageTimestamp: nowSec - 40 }, 30), true);
        assert.equal(isMessageStale({ messageTimestamp: nowSec - 20 }, 30), false);
    });

    await t.test('correctly decodes protobuf Long object representations', () => {
        const nowSec = Math.floor(Date.now() / 1000);

        // Baileys / Long.js format with .toNumber()
        const longWithToNumber = {
            toNumber: () => nowSec - 300
        };
        assert.equal(isMessageStale({ messageTimestamp: longWithToNumber }), true);

        // Baileys / Long.js format with { low, high }
        const longWithLow = {
            low: nowSec - 5,
            high: 0
        };
        assert.equal(isMessageStale({ messageTimestamp: longWithLow }), false);

        const staleLongWithLow = {
            low: nowSec - 1000,
            high: 0
        };
        assert.equal(isMessageStale({ messageTimestamp: staleLongWithLow }), true);
    });

    await t.test('handles millisecond timestamps gracefully by converting to seconds', () => {
        const nowMs = Date.now();
        // 10 seconds ago in ms
        assert.equal(isMessageStale({ messageTimestamp: nowMs - 10_000 }), false);
        // 10 minutes ago in ms
        assert.equal(isMessageStale({ messageTimestamp: nowMs - 600_000 }), true);
    });

    await t.test('handles string and numeric conversions', () => {
        const nowSec = Math.floor(Date.now() / 1000);
        assert.equal(isMessageStale({ messageTimestamp: String(nowSec - 10) }), false);
        assert.equal(isMessageStale({ messageTimestamp: String(nowSec - 500) }), true);
    });

    await t.test('safely falls back to false when timestamp is absent, zero, or invalid', () => {
        assert.equal(isMessageStale(null), false);
        assert.equal(isMessageStale({}), false);
        assert.equal(isMessageStale({ messageTimestamp: null }), false);
        assert.equal(isMessageStale({ messageTimestamp: undefined }), false);
        assert.equal(isMessageStale({ messageTimestamp: 0 }), false);
        assert.equal(isMessageStale({ messageTimestamp: 'invalid' }), false);
    });
});

test('Handler Staleness Integration', async (t) => {
    await t.test('drops stale command messages before execution', async () => {
        const nowSec = Math.floor(Date.now() / 1000);
        let executed = false;

        // Temporarily register test command
        commands.set('test_stale_cmd', {
            names: ['test_stale_cmd'],
            execute: async () => {
                executed = true;
            }
        });

        const mockSock = {
            sendMessage: async () => {}
        };
        const mockLogger = {
            info: () => {},
            warn: () => {},
            error: () => {}
        };

        const staleMsg = {
            key: {
                remoteJid: '218493593067617@lid',
                fromMe: true,
                id: 'STALE_MSG_ID_1'
            },
            message: {
                conversation: '!test_stale_cmd'
            },
            messageTimestamp: nowSec - 1800 // 30 minutes old
        };

        await handler(mockSock, staleMsg, mockLogger, 'pribadi', 'dual');
        assert.equal(executed, false, 'Stale message should NOT be executed');

        // Cleanup
        commands.delete('test_stale_cmd');
    });

    await t.test('allows fresh command messages to proceed', async () => {
        const nowSec = Math.floor(Date.now() / 1000);
        let executed = false;

        commands.set('test_fresh_cmd', {
            names: ['test_fresh_cmd'],
            execute: async () => {
                executed = true;
            }
        });

        const mockSock = {
            sendMessage: async () => {}
        };
        const mockLogger = {
            info: () => {},
            warn: () => {},
            error: () => {}
        };

        const freshMsg = {
            key: {
                remoteJid: '218493593067617@lid',
                fromMe: true,
                id: 'FRESH_MSG_ID_1'
            },
            message: {
                conversation: '!test_fresh_cmd'
            },
            messageTimestamp: nowSec - 5 // 5 seconds old
        };

        await handler(mockSock, freshMsg, mockLogger, 'pribadi', 'dual');
        assert.equal(executed, true, 'Fresh message SHOULD be executed');

        // Cleanup
        commands.delete('test_fresh_cmd');
    });
});
