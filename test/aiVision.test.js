const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const { optimizeImageForVision, VISION_MODEL } = require('../src/services/aiVisionService');
const aiCommand = require('../src/commands/ai');

describe('AI Vision & Chat Service', () => {
    it('exports all expected command names and aliases', () => {
        assert.ok(aiCommand.names.includes('ai'));
        assert.ok(aiCommand.names.includes('tanya'));
        assert.ok(aiCommand.names.includes('vision'));
        assert.ok(aiCommand.names.includes('gpt'));
        assert.ok(aiCommand.names.includes('baca'));
        assert.ok(aiCommand.names.includes('deskripsi'));
        assert.equal(typeof aiCommand.execute, 'function');
    });

    it('uses the verified active Groq Vision model qwen/qwen3.8-27b', () => {
        assert.equal(VISION_MODEL, 'qwen/qwen3.8-27b');
    });

    it('optimizes an image buffer into a base64 JPEG data URL', async () => {
        const dummyBuffer = await sharp({
            create: {
                width: 800,
                height: 600,
                channels: 4,
                background: { r: 50, g: 150, b: 250, alpha: 1 }
            }
        }).png().toBuffer();

        const dataUrl = await optimizeImageForVision(dummyBuffer);
        assert.ok(dataUrl.startsWith('data:image/jpeg;base64,'));
        assert.ok(dataUrl.length > 50);
    });

    it('displays helpful usage instructions when called with no query and no media', async () => {
        const sentMessages = [];
        const mockSock = {
            sendMessage: async (jid, content, options) => {
                sentMessages.push({ jid, content, options });
                return { key: { id: 'test-id' } };
            }
        };

        const mockMsg = {
            key: { id: 'msg-123', remoteJid: '120363@g.us', fromMe: false },
            message: { conversation: '!ai' }
        };

        await aiCommand.execute({
            sock: mockSock,
            msg: mockMsg,
            args: [],
            cmdName: 'ai',
            remoteJid: '120363@g.us',
            quotedMsg: null,
            quotedStanza: null,
            session: { pack: 'test', author: 'test' },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
            PREFIX: '!'
        });

        assert.equal(sentMessages.length, 1);
        assert.ok(sentMessages[0].content.text.includes('GROQ AI VISION & CHAT'));
        assert.ok(sentMessages[0].content.text.includes('!ai'));
    });
});
