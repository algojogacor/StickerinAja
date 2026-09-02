const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractPackName, POPULAR_TELEGRAM_PACKS } = require('../src/services/telegramStickerService');
const telegramCommand = require('../src/commands/telegram');

describe('Telegram Sticker Integration', () => {
  it('extracts pack names from various Telegram link formats and raw strings', () => {
    assert.equal(extractPackName('wunkus'), 'wunkus');
    assert.equal(extractPackName('https://t.me/addstickers/spongebob'), 'spongebob');
    assert.equal(extractPackName('https://telegram.me/addstickers/PepeTheFrog'), 'PepeTheFrog');
    assert.equal(extractPackName('tg://addstickers?set=IndoMeme'), 'IndoMeme');
    assert.equal(extractPackName('   Doge_Sticker   '), 'Doge_Sticker');
    assert.equal(extractPackName(''), null);
    assert.equal(extractPackName(null), null);
  });

  it('contains popular curated Telegram packs', () => {
    assert.ok(Array.isArray(POPULAR_TELEGRAM_PACKS));
    assert.ok(POPULAR_TELEGRAM_PACKS.includes('wunkus'));
    assert.ok(POPULAR_TELEGRAM_PACKS.includes('catmemes'));
    assert.ok(POPULAR_TELEGRAM_PACKS.includes('spongebob'));
  });

  it('exports valid command module structure and names', () => {
    assert.ok(Array.isArray(telegramCommand.names));
    assert.ok(telegramCommand.names.includes('tg'));
    assert.ok(telegramCommand.names.includes('telegram'));
    assert.equal(typeof telegramCommand.execute, 'function');
  });

  it('replies with usage instructions when input is missing', async () => {
    let sentText = '';
    const mockSock = {
      sendMessage: async (jid, content) => {
        sentText = content.text;
      },
    };

    await telegramCommand.execute({
      sock: mockSock,
      msg: {},
      args: [],
      remoteJid: 'chat@g.us',
      ctx: { logger: { info: () => {}, error: () => {} } },
      PREFIX: '!',
    });

    assert.ok(sentText.includes('TELEGRAM STICKER IMPORTER'));
    assert.ok(sentText.includes('!tg <nama_pack'));
  });
});
