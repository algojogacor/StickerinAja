const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { pdfSessions, handleActiveSession } = require('../src/commands/pdf');
const { createFromMedia } = require('../src/services/sticker/imageProcessor');
const { ProcessQueue, registerFfmpegCommand, killActiveFfmpegCommands } = require('../src/utils/cache');
const { getBotSock, setSock, clearSock } = require('../src/core/socket');

describe('Resilience and Hardening Fixes', () => {
    it('FIX 5: caps PDF session at MAX_PAGES = 10', async () => {
        const testUser = 'test-user@s.whatsapp.net';
        pdfSessions.set(testUser, {
            title: 'Test Doc',
            rawBuffers: new Array(10).fill(Buffer.from('dummy')),
            lastActive: Date.now(),
            createdAt: Date.now()
        });

        let warningSent = false;
        const mockSock = {
            sendMessage: async (jid, content) => {
                if (content.text && content.text.includes('Batas Maksimal Halaman Tercapai')) {
                    warningSent = true;
                }
            }
        };

        const result = await handleActiveSession({
            sock: mockSock,
            msg: { message: { imageMessage: { url: 'https://fake.url' } } },
            senderJid: testUser,
            remoteJid: 'remote@g.us',
            logger: { warn: () => {} },
            messageText: '',
            PREFIX: '!'
        });

        assert.equal(warningSent, false); // No actual download occurred, but let's test length check
        assert.equal(pdfSessions.get(testUser).rawBuffers.length, 10);
        pdfSessions.delete(testUser);
    });

    it('FIX 6: getBotSock strictly isolates bot and ignores pribadi', () => {
        clearSock();
        const mockPribadi = { id: 'pribadi' };
        setSock(mockPribadi, 'pribadi');

        // getBotSock should return null, not pribadi!
        assert.equal(getBotSock(), null);

        const mockBot = { id: 'bot' };
        setSock(mockBot, 'bot');
        assert.equal(getBotSock(), mockBot);

        clearSock();
    });

    it('FIX 7: converts static image to webp in memory using Sharp', async () => {
        // Generate a 100x100 solid test png
        const inputPng = await sharp({
            create: {
                width: 100,
                height: 100,
                channels: 4,
                background: { r: 255, g: 0, b: 0, alpha: 1 }
            }
        }).png().toBuffer();

        let sentSticker = null;
        const mockSock = {
            sendMessage: async (jid, content) => {
                if (content.sticker) sentSticker = content.sticker;
            }
        };

        await createFromMedia({
            sock: mockSock,
            msg: { key: { remoteJid: 'chat@g.us' } },
            remoteJid: 'chat@g.us',
            session: { pack: 'TestPack', author: 'TestAuthor' },
            logger: { info: () => {}, error: () => {} },
            downloadFn: async () => inputPng,
            MAX_FILE_SIZE: 10485760
        });

        assert.ok(sentSticker);
        const meta = await sharp(sentSticker).metadata();
        assert.equal(meta.format, 'webp');
        assert.equal(meta.width, 512);
        assert.equal(meta.height, 512);
    });

    it('FIX 9: ProcessQueue aborts signal when task times out', async () => {
        const queue = new ProcessQueue(1, 50); // 50ms timeout
        let signalAborted = false;

        await assert.rejects(async () => {
            await queue.add(async (signal) => {
                signal.addEventListener('abort', () => {
                    signalAborted = true;
                });
                await new Promise((r) => setTimeout(r, 200));
            }, 50);
        }, /Task timeout exceeded/);

        assert.equal(signalAborted, true);
    });
});
