const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const stickerCmd = require('../src/commands/sticker');
const { revealViewOnce, unwrapMessage } = require('../src/services/sticker/converterService');

describe('Reveal View Once Command & Service', () => {
    it('exports revealViewOnce in converterService and binds aliases in sticker command', () => {
        assert.equal(typeof revealViewOnce, 'function');
        assert.ok(stickerCmd.names.includes('reveal'));
        assert.ok(stickerCmd.names.includes('rvo'));
        assert.ok(stickerCmd.names.includes('viewonce'));
        assert.ok(stickerCmd.names.includes('bukaonce'));
    });

    it('replies with usage instructions when invoked without media or quote', async () => {
        const sentMessages = [];
        const mockSock = {
            sendMessage: async (jid, payload) => {
                sentMessages.push({ jid, payload });
            }
        };

        const mockMsg = {
            key: { remoteJid: 'test@s.whatsapp.net', id: '1' },
            message: { conversation: '!reveal' }
        };

        await revealViewOnce({
            sock: mockSock,
            msg: mockMsg,
            remoteJid: 'test@s.whatsapp.net',
            quotedMsg: null,
            quotedStanza: null,
            downloadFn: async () => null
        });

        assert.equal(sentMessages.length, 1);
        assert.ok(sentMessages[0].payload.text.includes('REVEAL VIEW ONCE'));
    });

    it('warns when quoted message is not media', async () => {
        const sentMessages = [];
        const mockSock = {
            sendMessage: async (jid, payload) => {
                sentMessages.push({ jid, payload });
            }
        };

        const mockMsg = {
            key: { remoteJid: 'test@s.whatsapp.net', id: '2' },
            message: { conversation: '!reveal' }
        };

        const mockQuotedMsg = {
            conversation: 'hanya teks biasa'
        };

        await revealViewOnce({
            sock: mockSock,
            msg: mockMsg,
            remoteJid: 'test@s.whatsapp.net',
            quotedMsg: mockQuotedMsg,
            quotedStanza: 'stanza-1',
            downloadFn: async () => null
        });

        assert.equal(sentMessages.length, 1);
        assert.ok(sentMessages[0].payload.text.includes('bukan foto, video, atau audio'));
    });

    it('successfully reveals View Once image in original quality (not WebP)', async () => {
        const sentMessages = [];
        const mockSock = {
            sendMessage: async (jid, payload) => {
                sentMessages.push({ jid, payload });
            }
        };

        const originalImageBuffer = Buffer.from('RAW_JPEG_IMAGE_BYTES_12345');

        const mockMsg = {
            key: { remoteJid: 'test@s.whatsapp.net', id: '3' },
            message: { conversation: '!reveal' }
        };

        const mockQuotedMsg = {
            viewOnceMessage: {
                message: {
                    imageMessage: {
                        url: 'https://mmg.whatsapp.net/v/t62.7118-24/test.jpg',
                        mimetype: 'image/jpeg',
                        caption: 'foto rahasia'
                    }
                }
            }
        };

        await revealViewOnce({
            sock: mockSock,
            msg: mockMsg,
            remoteJid: 'test@s.whatsapp.net',
            quotedMsg: mockQuotedMsg,
            quotedStanza: 'stanza-img-1',
            downloadFn: async () => originalImageBuffer
        });

        // First message is the loading notice, second is the revealed media
        assert.equal(sentMessages.length, 2);
        assert.ok(sentMessages[0].payload.text.includes('Membuka media View Once'));

        const mediaMessage = sentMessages[1].payload;
        assert.ok(mediaMessage.image, 'Should send as an image message');
        assert.equal(mediaMessage.image, originalImageBuffer, 'Should preserve exact original image buffer');
        assert.equal(mediaMessage.mimetype, 'image/jpeg');
        assert.ok(mediaMessage.caption.includes('foto rahasia'));
    });

    it('successfully reveals View Once video', async () => {
        const sentMessages = [];
        const mockSock = {
            sendMessage: async (jid, payload) => {
                sentMessages.push({ jid, payload });
            }
        };

        const originalVideoBuffer = Buffer.from('RAW_MP4_VIDEO_BYTES_99999');

        const mockMsg = {
            key: { remoteJid: 'test@s.whatsapp.net', id: '4' },
            message: { conversation: '!rvo' }
        };

        const mockQuotedMsg = {
            viewOnceMessageV2: {
                message: {
                    videoMessage: {
                        url: 'https://mmg.whatsapp.net/v/t62.7118-24/test.mp4',
                        mimetype: 'video/mp4'
                    }
                }
            }
        };

        await revealViewOnce({
            sock: mockSock,
            msg: mockMsg,
            remoteJid: 'test@s.whatsapp.net',
            quotedMsg: mockQuotedMsg,
            quotedStanza: 'stanza-vid-1',
            downloadFn: async () => originalVideoBuffer
        });

        assert.equal(sentMessages.length, 2);
        const mediaMessage = sentMessages[1].payload;
        assert.ok(mediaMessage.video, 'Should send as a video message');
        assert.equal(mediaMessage.video, originalVideoBuffer);
        assert.equal(mediaMessage.mimetype, 'video/mp4');
    });

    it('unwraps nested ephemeral and viewOnce wrappers in converterService', () => {
        const nestedMsg = {
            ephemeralMessage: {
                message: {
                    viewOnceMessageV2Extension: {
                        message: {
                            imageMessage: {
                                mimetype: 'image/png'
                            }
                        }
                    }
                }
            }
        };

        const unwrapped = unwrapMessage(nestedMsg);
        assert.ok(unwrapped?.imageMessage);
        assert.equal(unwrapped.imageMessage.mimetype, 'image/png');
    });

    it('handles download failure gracefully', async () => {
        const sentMessages = [];
        const mockSock = {
            sendMessage: async (jid, payload) => {
                sentMessages.push({ jid, payload });
            }
        };

        const mockMsg = {
            key: { remoteJid: 'test@s.whatsapp.net', id: '5' },
            message: { conversation: '!reveal' }
        };

        const mockQuotedMsg = {
            viewOnceMessage: {
                message: {
                    imageMessage: { mimetype: 'image/jpeg' }
                }
            }
        };

        await revealViewOnce({
            sock: mockSock,
            msg: mockMsg,
            remoteJid: 'test@s.whatsapp.net',
            quotedMsg: mockQuotedMsg,
            quotedStanza: 'stanza-fail',
            downloadFn: async () => null
        });

        assert.equal(sentMessages.length, 2);
        assert.ok(sentMessages[1].payload.text.includes('Gagal mengunduh media View Once'));
    });
});
