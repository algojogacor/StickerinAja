const crypto = require('crypto');

/**
 * Creates raw EXIF binary buffer compliant with WhatsApp sticker metadata standard.
 * @param {string} packName - Sticker pack name (default from STICKERIN_BOT_NAME)
 * @param {string} author - Sticker author / publisher (default from STICKERIN_AUTHOR)
 * @param {string[]} emojis - Emojis associated with sticker
 */
function createExif(packName = process.env.STICKERIN_BOT_NAME || 'Stikerin Aja', author = process.env.STICKERIN_AUTHOR || 'Bot', emojis = ['✨']) {
    const json = {
        'sticker-pack-id': crypto.randomBytes(32).toString('hex'),
        'sticker-pack-name': packName,
        'sticker-pack-publisher': author,
        'emojis': emojis
    };
    const jsonBuff = Buffer.from(JSON.stringify(json), 'utf-8');
    const exif = Buffer.concat([
        Buffer.from([
            0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
            0x01, 0x00, 0x41, 0x57, 0x07, 0x00
        ]),
        Buffer.from([
            jsonBuff.length & 0xff,
            (jsonBuff.length >> 8) & 0xff,
            (jsonBuff.length >> 16) & 0xff,
            (jsonBuff.length >> 24) & 0xff
        ]),
        Buffer.from([0x16, 0x00, 0x00, 0x00]),
        jsonBuff
    ]);
    return exif;
}

/**
 * Injects WhatsApp sticker EXIF metadata directly into a WebP buffer.
 * Supports both static and animated WebP containers.
 * @param {Buffer} webpBuffer - Raw WebP image/animation buffer
 * @param {string} [packName] - Custom pack name
 * @param {string} [author] - Custom author name
 * @returns {Buffer} WebP buffer with embedded EXIF chunk
 */
function addExifToWebp(webpBuffer, packName, author) {
    if (!Buffer.isBuffer(webpBuffer) || webpBuffer.length < 12) {
        return webpBuffer;
    }

    // Verify RIFF WebP header
    if (webpBuffer.slice(0, 4).toString() !== 'RIFF' || webpBuffer.slice(8, 12).toString() !== 'WEBP') {
        return webpBuffer;
    }

    const exifData = createExif(
        packName || process.env.STICKERIN_BOT_NAME || 'Stikerin Aja',
        author || process.env.STICKERIN_AUTHOR || 'Bot'
    );

    const exifChunkHeader = Buffer.from('EXIF');
    const exifSizeBuf = Buffer.alloc(4);
    exifSizeBuf.writeUInt32LE(exifData.length, 0);
    const pad = exifData.length % 2 === 1 ? Buffer.from([0x00]) : Buffer.alloc(0);
    const exifChunk = Buffer.concat([exifChunkHeader, exifSizeBuf, exifData, pad]);

    const chunks = [];
    let offset = 12;
    let hasVp8x = false;
    let hasAnimation = false;
    let hasAlpha = false;

    while (offset < webpBuffer.length) {
        const fourcc = webpBuffer.slice(offset, offset + 4).toString();
        const size = webpBuffer.readUInt32LE(offset + 4);
        const chunkSize = 8 + size + (size % 2 === 1 ? 1 : 0);

        if (fourcc === 'VP8X') {
            hasVp8x = true;
        } else if (fourcc === 'ANIM' || fourcc === 'ANMF') {
            hasAnimation = true;
        } else if (fourcc === 'ALPH') {
            hasAlpha = true;
        }

        if (fourcc !== 'EXIF') {
            chunks.push({ fourcc, data: webpBuffer.slice(offset, offset + chunkSize) });
        }
        offset += chunkSize;
    }

    if (hasVp8x && chunks.length > 0 && chunks[0].fourcc === 'VP8X') {
        const vp8xChunk = Buffer.from(chunks[0].data);
        vp8xChunk[8] |= 0x08; // Set EXIF bit flag
        chunks[0].data = vp8xChunk;
    } else {
        // Construct Extended WebP (VP8X) header with 512x512 canvas bounds
        let flags = 0x08; // EXIF flag bit
        if (hasAnimation) flags |= 0x02;
        if (hasAlpha) flags |= 0x10;

        const vp8xChunkData = Buffer.from([
            0x56, 0x50, 0x38, 0x58, // 'VP8X'
            0x0A, 0x00, 0x00, 0x00, // length 10
            flags, 0x00, 0x00, 0x00,
            0xFF, 0x01, 0x00, // width: 512 (511 + 1)
            0xFF, 0x01, 0x00  // height: 512 (511 + 1)
        ]);
        chunks.unshift({ fourcc: 'VP8X', data: vp8xChunkData });
    }

    chunks.push({ fourcc: 'EXIF', data: exifChunk });

    const totalPayload = Buffer.concat(chunks.map(c => c.data));
    const riffHeader = Buffer.from('RIFF');
    const totalFileSize = Buffer.alloc(4);
    totalFileSize.writeUInt32LE(totalPayload.length + 4, 0);
    const webpHeader = Buffer.from('WEBP');

    return Buffer.concat([riffHeader, totalFileSize, webpHeader, totalPayload]);
}

module.exports = {
    createExif,
    addExifToWebp
};
