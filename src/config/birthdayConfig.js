// Birthday config — centralized settings for the birthday feature.
module.exports = {
    BOT_TIMEZONE: process.env.BOT_TIMEZONE || 'Asia/Jakarta',
    BIRTHDAY_FEATURE_ENABLED: process.env.BIRTHDAY_FEATURE_ENABLED !== 'false',
    BIRTHDAY_TAKEOVER_ENABLED: process.env.BIRTHDAY_TAKEOVER_ENABLED !== 'false',
    BIRTHDAY_SONG_URL: process.env.BIRTHDAY_SONG_URL || '',
    BIRTHDAY_AUDIO_PATH: process.env.BIRTHDAY_AUDIO_PATH || '',
    BIRTHDAY_CARD_PATH: process.env.BIRTHDAY_CARD_PATH || '',
    BIRTHDAY_STICKER_PATH: process.env.BIRTHDAY_STICKER_PATH || '',
    BIRTHDAY_WISH_MAX_LENGTH: parseInt(process.env.BIRTHDAY_WISH_MAX_LENGTH || '500', 10),

    ASSETS_DIR: './assets/birthday',

    // Birthday takeover schedule (WIB)
    TAKEOVER_SCHEDULE: [
        { time: '00:00', event: 'grand_opening' },
        { time: '07:00', event: 'birthday_song' },
        { time: '09:00', event: 'birthday_card' },
        { time: '12:00', event: 'open_wishes' },
        { time: '15:00', event: 'birthday_spotlight' },
        { time: '18:00', event: 'crowd_reminder' },
        { time: '21:00', event: 'birthday_recap' },
        { time: '23:30', event: 'closing' },
    ],

    // Spotlight templates (rotating)
    SPOTLIGHT_TEMPLATES: [
        '🌟 *BIRTHDAY SPOTLIGHT*\n\nTokoh utama grup hari ini: @BIRTHDAY_PERSON\n\nSemoga hari ini:\n✅ Makan enak\n✅ Dapat kabar baik\n✅ Tidak dibuat kesal\n✅ Banyak yang traktir',
        '🌟 *BIRTHDAY SPOTLIGHT*\n\nPerhatian untuk @BIRTHDAY_PERSON!\n\nMisi hari ini:\n🎯 Senyum terus\n🎯 Bahagia tanpa syarat\n🎯 Traktir opsional tapi dianjurkan\n🎯 Jangan lupa bersyukur',
        '🌟 *BIRTHDAY SPOTLIGHT*\n\nHari ini grup dipersembahkan untuk @BIRTHDAY_PERSON\n\nFakta random:\n🎂 Hari ini bertambah tua dengan elegan\n🎁 Hadiah diterima dalam bentuk apa pun\n🍰 Kue virtual sudah disiapkan',
    ],
};
