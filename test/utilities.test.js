const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Utility and Tools Command Suite', () => {
    const downloaderCmd = require('../src/commands/downloader');
    const ttsCmd = require('../src/commands/tts');
    const toolsCmd = require('../src/commands/tools');
    const weatherCmd = require('../src/commands/weather');
    const menuCmd = require('../src/commands/menu');

    describe('Downloader Module', () => {
        it('exports required command names', () => {
            assert.ok(Array.isArray(downloaderCmd.names));
            assert.ok(downloaderCmd.names.includes('tiktok'));
            assert.ok(downloaderCmd.names.includes('tt'));
            assert.ok(downloaderCmd.names.includes('ttdl'));
            assert.ok(downloaderCmd.names.includes('ttmp3'));
            assert.equal(typeof downloaderCmd.execute, 'function');
        });

        it('replies with usage instructions when no link is provided', async () => {
            let sentMessage = null;
            const mockSock = {
                sendMessage: async (jid, content) => {
                    sentMessage = content;
                    return { key: { id: 'test' } };
                }
            };
            await downloaderCmd.execute(mockSock, { key: { remoteJid: 'test@s.whatsapp.net' } }, []);
            assert.ok(sentMessage);
            assert.match(sentMessage.text, /TIKTOK DOWNLOADER/);
            assert.match(sentMessage.text, /!tiktok/);
        });
    });

    describe('TTS Module', () => {
        it('exports required command names', () => {
            assert.ok(Array.isArray(ttsCmd.names));
            assert.ok(ttsCmd.names.includes('tts'));
            assert.ok(ttsCmd.names.includes('vn'));
            assert.ok(ttsCmd.names.includes('suara'));
            assert.equal(typeof ttsCmd.execute, 'function');
        });

        it('replies with usage instructions when text is empty', async () => {
            let sentMessage = null;
            const mockSock = {
                sendMessage: async (jid, content) => {
                    sentMessage = content;
                    return { key: { id: 'test' } };
                }
            };
            await ttsCmd.execute(mockSock, { key: { remoteJid: 'test@s.whatsapp.net' } }, []);
            assert.ok(sentMessage);
            assert.match(sentMessage.text, /TEXT TO SPEECH/);
            assert.match(sentMessage.text, /!tts/);
        });
    });

    describe('Tools & Developer Module', () => {
        it('exports required command names', () => {
            assert.ok(Array.isArray(toolsCmd.names));
            assert.ok(toolsCmd.names.includes('short'));
            assert.ok(toolsCmd.names.includes('unshort'));
            assert.ok(toolsCmd.names.includes('qr'));
            assert.ok(toolsCmd.names.includes('pass'));
            assert.ok(toolsCmd.names.includes('ip'));
            assert.ok(toolsCmd.names.includes('base64'));
            assert.ok(toolsCmd.names.includes('hash'));
            assert.equal(typeof toolsCmd.execute, 'function');
        });

        it('generates random password with custom length', async () => {
            let sentMessage = null;
            const mockSock = {
                sendMessage: async (jid, content) => {
                    sentMessage = content;
                    return { key: { id: 'test' } };
                }
            };
            const args = ['20'];
            args._command = 'pass';
            await toolsCmd.execute(mockSock, { key: { remoteJid: 'test@s.whatsapp.net' } }, args);
            assert.ok(sentMessage);
            assert.match(sentMessage.text, /RANDOM PASSWORD GENERATOR/);
            assert.match(sentMessage.text, /20 karakter/);
        });

        it('encodes and decodes base64 correctly', async () => {
            let encodeMsg = null;
            let decodeMsg = null;
            const mockSock = {
                sendMessage: async (jid, content) => {
                    if (!encodeMsg) encodeMsg = content;
                    else decodeMsg = content;
                    return { key: { id: 'test' } };
                }
            };

            const encodeArgs = ['encode', 'Halo Dunia'];
            encodeArgs._command = 'base64';
            await toolsCmd.execute(mockSock, { key: { remoteJid: 'test@s.whatsapp.net' } }, encodeArgs);
            assert.match(encodeMsg.text, /HASIL BASE64 ENCODE/);
            assert.match(encodeMsg.text, /SGFsbyBEdW5pYQ==/);

            const decodeArgs = ['decode', 'SGFsbyBEdW5pYQ=='];
            decodeArgs._command = 'base64';
            await toolsCmd.execute(mockSock, { key: { remoteJid: 'test@s.whatsapp.net' } }, decodeArgs);
            assert.match(decodeMsg.text, /HASIL BASE64 DECODE/);
            assert.match(decodeMsg.text, /Halo Dunia/);
        });

        it('generates MD5 and SHA256 hashes correctly', async () => {
            let sentMessage = null;
            const mockSock = {
                sendMessage: async (jid, content) => {
                    sentMessage = content;
                    return { key: { id: 'test' } };
                }
            };
            const args = ['hello'];
            args._command = 'hash';
            await toolsCmd.execute(mockSock, { key: { remoteJid: 'test@s.whatsapp.net' } }, args);
            assert.ok(sentMessage);
            assert.match(sentMessage.text, /5d41402abc4b2a76b9719d911017c592/); // MD5 of 'hello'
            assert.match(sentMessage.text, /2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824/); // SHA256 of 'hello'
        });
    });

    describe('Weather Module', () => {
        it('exports required command names', () => {
            assert.ok(Array.isArray(weatherCmd.names));
            assert.ok(weatherCmd.names.includes('cuaca'));
            assert.ok(weatherCmd.names.includes('weather'));
            assert.equal(typeof weatherCmd.execute, 'function');
        });

        it('replies with usage instructions when city is missing', async () => {
            let sentMessage = null;
            const mockSock = {
                sendMessage: async (jid, content) => {
                    sentMessage = content;
                    return { key: { id: 'test' } };
                }
            };
            await weatherCmd.execute(mockSock, { key: { remoteJid: 'test@s.whatsapp.net' } }, []);
            assert.ok(sentMessage);
            assert.match(sentMessage.text, /INFO CUACA REALTIME/);
            assert.match(sentMessage.text, /!cuaca/);
        });
    });

    describe('Menu Submenus', () => {
        it('renders downloader, tts, tools, and cuaca submenus', async () => {
            const submenus = ['downloader', 'tts', 'tools', 'cuaca'];
            for (const sub of submenus) {
                let sentText = '';
                const mockSock = {
                    sendMessage: async (jid, content) => {
                        sentText = content.text;
                        return { key: { id: 'test' } };
                    }
                };
                await menuCmd.execute({
                    sock: mockSock,
                    msg: { key: { remoteJid: 'test@s.whatsapp.net' } },
                    args: [sub],
                    remoteJid: 'test@s.whatsapp.net',
                    session: { pack: 'Stiker', author: 'Bot', quality: 80 },
                    logger: { info: () => {} },
                    PREFIX: '!'
                });
                assert.ok(sentText.length > 20, `Submenu ${sub} should not be empty`);
                assert.doesNotMatch(sentText, /Topik menu tidak dikenal/);
            }
        });
    });
});
