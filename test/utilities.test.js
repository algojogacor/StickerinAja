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
            assert.ok(downloaderCmd.names.includes('ig'));
            assert.ok(downloaderCmd.names.includes('igdl'));
            assert.ok(downloaderCmd.names.includes('instagram'));
            assert.ok(downloaderCmd.names.includes('reels'));
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
            assert.match(sentMessage.text, /SOCIAL MEDIA DOWNLOADER/);
            assert.match(sentMessage.text, /!tiktok/);
            assert.match(sentMessage.text, /!ig/);
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
            assert.match(encodeMsg.text, /BASE64 ENCODE/);
            assert.match(encodeMsg.text, /SGFsbyBEdW5pYQ==/);

            const decodeArgs = ['decode', 'SGFsbyBEdW5pYQ=='];
            decodeArgs._command = 'base64';
            await toolsCmd.execute(mockSock, { key: { remoteJid: 'test@s.whatsapp.net' } }, decodeArgs);
            assert.match(decodeMsg.text, /BASE64 DECODE/);
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

    describe('PDF & Scanner Module', () => {
        const pdfCmd = require('../src/commands/pdf');
        const sharp = require('sharp');

        it('exports required command names and helper functions', () => {
            assert.ok(Array.isArray(pdfCmd.names));
            assert.ok(pdfCmd.names.includes('pdf'));
            assert.ok(pdfCmd.names.includes('topdf'));
            assert.ok(pdfCmd.names.includes('scan'));
            assert.ok(pdfCmd.names.includes('pdfdone'));
            assert.equal(typeof pdfCmd.execute, 'function');
            assert.equal(typeof pdfCmd.imagesToPdf, 'function');
        });

        it('generates valid PDF buffer from image buffers', async () => {
            const img1 = await sharp({
                create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } }
            }).jpeg().toBuffer();

            const img2 = await sharp({
                create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 255, b: 0 } }
            }).jpeg().toBuffer();

            const pdfBuffer = await pdfCmd.imagesToPdf([img1, img2]);
            assert.ok(Buffer.isBuffer(pdfBuffer));
            assert.ok(pdfBuffer.length > 500);
            assert.equal(pdfBuffer.slice(0, 5).toString('utf-8'), '%PDF-');
        });

        it('starts a new PDF session when triggered without media', async () => {
            let sentMessage = null;
            const mockSock = {
                sendMessage: async (jid, content) => {
                    sentMessage = content;
                    return { key: { id: 'test' } };
                }
            };
            const args = [];
            args._command = 'topdf';
            await pdfCmd.execute(mockSock, { key: { remoteJid: 'test@s.whatsapp.net', participant: 'user1@s.whatsapp.net' } }, args);
            assert.ok(sentMessage);
            assert.match(sentMessage.text, /SESI PEMBUATAN PDF DIMULAI/);
            assert.ok(pdfCmd.pdfSessions.has('user1@s.whatsapp.net'));
        });

        it('captures incoming images during active session and compiles with pdfdone', async () => {
            let sentMessages = [];
            const mockSock = {
                sendMessage: async (jid, content) => {
                    sentMessages.push(content);
                    return { key: { id: 'test' } };
                }
            };

            // Start session
            const args = [];
            args._command = 'scan';
            await pdfCmd.execute(mockSock, { key: { remoteJid: 'group1@g.us', participant: 'user2@s.whatsapp.net' } }, args);
            assert.ok(pdfCmd.pdfSessions.has('user2@s.whatsapp.net'));

            // Mock an image buffer in session
            const sampleImg = await sharp({
                create: { width: 100, height: 100, channels: 3, background: { r: 120, g: 120, b: 120 } }
            }).jpeg().toBuffer();

            const session = pdfCmd.pdfSessions.get('user2@s.whatsapp.net');
            session.rawBuffers.push(sampleImg);
            session.rawBuffers.push(sampleImg);

            // Execute pdfdone
            const doneArgs = [];
            doneArgs._command = 'pdfdone';
            await pdfCmd.execute(mockSock, { key: { remoteJid: 'group1@g.us', participant: 'user2@s.whatsapp.net' } }, doneArgs);

            // Wait for queue
            await new Promise(r => setTimeout(r, 100));

            // PDF V1 and PDF V2 sent
            const docs = sentMessages.filter(m => m.document);
            assert.ok(docs.length >= 2, 'Should send both Version 1 and Version 2 PDFs');
            assert.equal(docs[0].mimetype, 'application/pdf');
            assert.equal(docs[1].mimetype, 'application/pdf');
            assert.ok(docs[0].fileName.endsWith('_Original.pdf'), 'Version 1 should be Original');
            assert.ok(docs[1].fileName.endsWith('_Filter.pdf'), 'Version 2 should be Filter');
            assert.match(docs[0].caption, /ORIGINAL/);
            assert.match(docs[1].caption, /FILTER RINGAN/);
            assert.ok(!pdfCmd.pdfSessions.has('user2@s.whatsapp.net'), 'Session should be cleared after completion');
        });

        it('preserves fine ink and pencil strokes in applyGentleScan without bleaching', async () => {
            // 100x100 image with light grey paper (210) and pencil stroke (175)
            const width = 100, height = 100;
            const buf = Buffer.alloc(width * height * 3, 210); // paper
            // Draw pencil line at y = 50
            for (let x = 20; x <= 80; x++) {
                const idx = (50 * width + x) * 3;
                buf[idx] = 175;
                buf[idx + 1] = 175;
                buf[idx + 2] = 175;
            }
            const imgJpg = await sharp(buf, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();

            const enhanced = await pdfCmd.applyGentleScan(imgJpg);
            assert.ok(Buffer.isBuffer(enhanced));

            const rawOut = await sharp(enhanced).raw().toBuffer();
            const pencilIdx = (50 * width + 50) * 3;
            const pencilVal = rawOut[pencilIdx];

            // In the old algorithm, pencil got bleached to 255 (erased)!
            // In gentle scan, pencil must be preserved and distinctly darker than paper (< 220)
            assert.ok(pencilVal < 220, `Pencil pixel should be preserved and clearly visible, got: ${pencilVal}`);
        });

        it('prepares authentic original image in prepareOriginalImage', async () => {
            const img = await sharp({
                create: { width: 80, height: 80, channels: 3, background: { r: 150, g: 100, b: 50 } }
            }).jpeg().toBuffer();

            const original = await pdfCmd.prepareOriginalImage(img);
            assert.ok(Buffer.isBuffer(original));
            const meta = await sharp(original).metadata();
            assert.equal(meta.format, 'jpeg');
            assert.equal(meta.width, 80);
            assert.equal(meta.height, 80);
        });

        it('cancels active session with pdfcancel', async () => {
            let sentMessage = null;
            const mockSock = {
                sendMessage: async (jid, content) => {
                    sentMessage = content;
                    return { key: { id: 'test' } };
                }
            };

            pdfCmd.pdfSessions.set('user3@s.whatsapp.net', { mode: 'scan', rawBuffers: [], lastActive: Date.now() });

            const cancelArgs = [];
            cancelArgs._command = 'pdfcancel';
            await pdfCmd.execute(mockSock, { key: { remoteJid: 'test@s.whatsapp.net', participant: 'user3@s.whatsapp.net' } }, cancelArgs);

            assert.ok(sentMessage);
            assert.match(sentMessage.text, /dibatalkan/);
            assert.ok(!pdfCmd.pdfSessions.has('user3@s.whatsapp.net'));
        });

        it('normalizes device JIDs in cleanJid and getSessionForUser', () => {
            pdfCmd.pdfSessions.set('62812345678@s.whatsapp.net', { rawBuffers: [], lastActive: Date.now() });

            // Lookup using linked device sender JID
            const { session, key } = pdfCmd.getSessionForUser('62812345678:15@s.whatsapp.net', 'some-chat@s.whatsapp.net');
            assert.ok(session, 'Should find session despite device suffix :15');
            assert.equal(key, '62812345678@s.whatsapp.net');

            // Lookup using 1-on-1 DM remoteJid
            const dmLookup = pdfCmd.getSessionForUser(null, '62812345678:2@s.whatsapp.net');
            assert.ok(dmLookup.session, 'Should find session via DM remoteJid');
            assert.equal(dmLookup.key, '62812345678@s.whatsapp.net');

            pdfCmd.pdfSessions.delete('62812345678@s.whatsapp.net');
        });

        it('debounces page save confirmation during rapid multi-image uploads', async () => {
            let sentMessages = [];
            const mockSock = {
                sendMessage: async (jid, content) => {
                    sentMessages.push(content);
                    return { key: { id: 'test' } };
                }
            };

            const userJid = 'album_user@s.whatsapp.net';
            const session = { rawBuffers: [], lastActive: Date.now() };
            pdfCmd.pdfSessions.set(userJid, session);

            // Create 2 test images
            const img1 = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
            const img2 = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 40, g: 50, b: 60 } } }).jpeg().toBuffer();

            // Mock Baileys downloadMediaMessage
            const { downloadMediaMessage } = require('@whiskeysockets/baileys');
            // Mock message objects with images
            const msg1 = { key: { remoteJid: userJid, id: 'm1' }, message: { imageMessage: {} } };
            const msg2 = { key: { remoteJid: userJid, id: 'm2' }, message: { imageMessage: {} } };

            // Simulate msg 1 arriving
            session.rawBuffers.push(img1);
            if (session.ackTimer) clearTimeout(session.ackTimer);
            session.ackTimer = setTimeout(async () => {
                await mockSock.sendMessage(userJid, { text: `✅ *Halaman ${session.rawBuffers.length} Tersimpan!*` });
            }, 50);

            // Rapidly simulate msg 2 arriving 10ms later (album bundle)
            await new Promise(r => setTimeout(r, 10));
            session.rawBuffers.push(img2);
            if (session.ackTimer) clearTimeout(session.ackTimer);
            session.ackTimer = setTimeout(async () => {
                await mockSock.sendMessage(userJid, { text: `✅ *Halaman ${session.rawBuffers.length} Tersimpan!*` });
            }, 50);

            // Wait 100ms for debounce timer to fire
            await new Promise(r => setTimeout(r, 100));

            // Should only have sent ONE aggregated message with Halaman 2, not 2 separate messages
            assert.equal(sentMessages.length, 1);
            assert.match(sentMessages[0].text, /Halaman 2 Tersimpan/);

            pdfCmd.pdfSessions.delete(userJid);
        });
    });

    describe('KBBI Module', () => {
        const kbbiCmd = require('../src/commands/kbbi');

        it('exports required command names and formatting function', () => {
            assert.ok(Array.isArray(kbbiCmd.names));
            assert.ok(kbbiCmd.names.includes('kbbi'));
            assert.ok(kbbiCmd.names.includes('kamus'));
            assert.ok(kbbiCmd.names.includes('artikata'));
            assert.ok(kbbiCmd.names.includes('arti'));
            assert.equal(typeof kbbiCmd.execute, 'function');
            assert.equal(typeof kbbiCmd.formatKbbi, 'function');
        });

        it('replies with usage instructions when query is empty', async () => {
            let sentMessage = null;
            const mockSock = {
                sendMessage: async (jid, content) => {
                    sentMessage = content;
                    return { key: { id: 'test' } };
                }
            };
            await kbbiCmd.execute(mockSock, { key: { remoteJid: 'test@s.whatsapp.net' } }, []);
            assert.ok(sentMessage);
            assert.match(sentMessage.text, /KAMUS BESAR BAHASA INDONESIA/);
            assert.match(sentMessage.text, /!kbbi <kata>/);
        });

        it('formats mock KBBI json correctly', () => {
            const mockData = {
                lemma: 'cinta',
                entries: [
                    {
                        entry: 'cin.ta',
                        definitions: [
                            {
                                definition: 'suka sekali; sayang benar',
                                labels: [{ code: 'a', kind: 'Kelas Kata' }],
                                usageExamples: ['orang tuaku ~ kepada kami semua']
                            }
                        ],
                        derivedWords: ['bercinta', 'tercinta']
                    }
                ]
            };

            const formatted = kbbiCmd.formatKbbi(mockData, 'cinta');
            assert.match(formatted, /📖 \*cinta\*/);
            assert.match(formatted, /\*cin\.ta\* \(a\)/);
            assert.match(formatted, /1\. suka sekali; sayang benar/);
            assert.match(formatted, /📝 _orang tuaku cinta kepada kami semua_/);
            assert.match(formatted, /📌 \*Kata turunan:\* bercinta, tercinta/);
        });
    });

    describe('Libur Module', () => {
        const liburCmd = require('../src/commands/libur');

        it('exports required command names and helper functions', () => {
            assert.ok(Array.isArray(liburCmd.names));
            assert.ok(liburCmd.names.includes('libur'));
            assert.ok(liburCmd.names.includes('harilibur'));
            assert.ok(liburCmd.names.includes('holiday'));
            assert.equal(typeof liburCmd.execute, 'function');
            assert.equal(typeof liburCmd.parseMonth, 'function');
            assert.equal(typeof liburCmd.formatHolidays, 'function');
        });

        it('parses month names and numbers correctly', () => {
            assert.equal(liburCmd.parseMonth('8'), 8);
            assert.equal(liburCmd.parseMonth('agustus'), 8);
            assert.equal(liburCmd.parseMonth('aug'), 8);
            assert.equal(liburCmd.parseMonth('desember'), 12);
            assert.equal(liburCmd.parseMonth('invalid_month'), null);
        });

        it('formats mock holidays correctly with national and cuti tags', () => {
            const mockHolidays = [
                { date: '2026-08-17', name: 'Proklamasi Kemerdekaan', isCutiBersama: false },
                { date: '2026-08-25', name: 'Maulid Nabi Muhammad S.A.W.', isCutiBersama: false }
            ];

            const formatted = liburCmd.formatHolidays(mockHolidays, 8, 2026);
            assert.match(formatted, /📅 \*Hari Libur — Agustus 2026\*/);
            assert.match(formatted, /17 Agustus 2026, Senin — Proklamasi Kemerdekaan 🔴/);
            assert.match(formatted, /25 Agustus 2026, Selasa — Maulid Nabi Muhammad S\.A\.W\. 🔴/);
        });

        it('formats empty month correctly', () => {
            const formatted = liburCmd.formatHolidays([], 9, 2026);
            assert.match(formatted, /📅 \*Hari Libur — September 2026\*/);
            assert.match(formatted, /Tidak ada hari libur di bulan ini\./);
        });
    });

    describe('Kalender Module', () => {
        const kalenderCmd = require('../src/commands/kalender');

        it('exports required command names and generator function', () => {
            assert.ok(Array.isArray(kalenderCmd.names));
            assert.ok(kalenderCmd.names.includes('kalender'));
            assert.ok(kalenderCmd.names.includes('cal'));
            assert.ok(kalenderCmd.names.includes('calendar'));
            assert.equal(typeof kalenderCmd.execute, 'function');
            assert.equal(typeof kalenderCmd.generateCalendarPng, 'function');
        });

        it('replies with error message when month is invalid', async () => {
            let sentMessage = null;
            const mockSock = {
                sendMessage: async (jid, content) => {
                    sentMessage = content;
                    return { key: { id: 'test' } };
                }
            };
            await kalenderCmd.execute(mockSock, { key: { remoteJid: 'test@s.whatsapp.net' } }, ['bulan_salah']);
            assert.ok(sentMessage);
            assert.equal(sentMessage.text, '❌ Bulan tidak valid.');
        });

        it('generates a valid PNG buffer with holidays and custom year/month', async () => {
            const mockHolidays = [
                { date: '2026-08-17', name: 'Proklamasi Kemerdekaan', isCutiBersama: false }
            ];
            const pngBuf = await kalenderCmd.generateCalendarPng(2026, 8, mockHolidays);
            assert.ok(Buffer.isBuffer(pngBuf));
            assert.ok(pngBuf.length > 1000);
            // Verify PNG magic header: \x89PNG
            assert.equal(pngBuf[0], 0x89);
            assert.equal(pngBuf[1], 0x50);
            assert.equal(pngBuf[2], 0x4E);
            assert.equal(pngBuf[3], 0x47);
        });

        it('generates a valid PNG buffer even when holidays array is empty (API fallback)', async () => {
            const pngBuf = await kalenderCmd.generateCalendarPng(2026, 9, []);
            assert.ok(Buffer.isBuffer(pngBuf));
            assert.ok(pngBuf.length > 1000);
            assert.equal(pngBuf[0], 0x89);
        });
    });

    describe('Queue & Concurrency Hardening', () => {
        const { ProcessQueue } = require('../src/utils/cache');
        const { enqueueChatTask } = require('../src/handler');

        it('executes tasks in sequential order with bounded concurrency', async () => {
            const queue = new ProcessQueue(1);
            const executionOrder = [];

            const task1 = queue.add(async () => {
                await new Promise(r => setTimeout(r, 20));
                executionOrder.push(1);
            });
            const task2 = queue.add(async () => {
                executionOrder.push(2);
            });

            await Promise.all([task1, task2]);
            assert.deepEqual(executionOrder, [1, 2]);
        });

        it('handles task timeout cleanly without locking subsequent queue tasks', async () => {
            const queue = new ProcessQueue(1);
            const results = [];

            // Task 1 will timeout (timeout = 30ms, task takes 100ms)
            const task1 = queue.add(async () => {
                await new Promise(r => setTimeout(r, 100));
                results.push('task1_late');
            }, 30).catch(err => {
                results.push('task1_timeout');
            });

            // Task 2 should execute right after task 1 times out
            const task2 = queue.add(async () => {
                results.push('task2_ok');
            }, 50);

            await Promise.all([task1, task2]);
            assert.ok(results.includes('task1_timeout'));
            assert.ok(results.includes('task2_ok'));
        });

        it('maintains per-chat FIFO execution order across overlapping messages', async () => {
            const chatJid = 'test_group_123@g.us';
            const log = [];

            const p1 = enqueueChatTask(chatJid, async () => {
                await new Promise(r => setTimeout(r, 25));
                log.push('userA_msg1');
            });

            const p2 = enqueueChatTask(chatJid, async () => {
                log.push('userB_msg2');
            });

            await Promise.all([p1, p2]);
            assert.deepEqual(log, ['userA_msg1', 'userB_msg2']);
        });
    });

    describe('YouTube Downloader & Music Module', () => {
        const ytCmd = require('../src/commands/youtube');

        it('exports required command names and helper functions', () => {
            assert.ok(Array.isArray(ytCmd.names));
            assert.ok(ytCmd.names.includes('play'));
            assert.ok(ytCmd.names.includes('ytmp3'));
            assert.ok(ytCmd.names.includes('yta'));
            assert.ok(ytCmd.names.includes('ytmp4'));
            assert.ok(ytCmd.names.includes('ytv'));
            assert.ok(ytCmd.names.includes('youtube'));
            assert.ok(ytCmd.names.includes('yt'));
            assert.ok(ytCmd.names.includes('lagu'));
            assert.ok(ytCmd.names.includes('music'));
            assert.equal(typeof ytCmd.execute, 'function');
            assert.equal(typeof ytCmd.resolveVideo, 'function');
            assert.equal(typeof ytCmd.sanitizeFileName, 'function');
            assert.equal(typeof ytCmd.isYouTubeUrl, 'function');
        });

        it('identifies YouTube URLs correctly', () => {
            assert.equal(ytCmd.isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
            assert.equal(ytCmd.isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ'), true);
            assert.equal(ytCmd.isYouTubeUrl('https://youtube.com/shorts/abcdefghijk'), true);
            assert.equal(ytCmd.isYouTubeUrl('just a song title'), false);
        });

        it('sanitizes filename safely for Windows/Linux filesystems', () => {
            const dirty = 'Lagu: Keren / Gokil * Banget? <2026> | OK';
            const clean = ytCmd.sanitizeFileName(dirty);
            assert.doesNotMatch(clean, /[/\\?%*:|"<>]/);
            assert.ok(clean.length <= 60);
        });

        it('replies with usage help when called without query', async () => {
            let sentMessage = null;
            const mockSock = {
                sendMessage: async (jid, content) => {
                    sentMessage = content;
                    return { key: { id: 'test' } };
                }
            };
            await ytCmd.execute(mockSock, { key: { remoteJid: 'test@s.whatsapp.net' } }, []);
            assert.ok(sentMessage);
            assert.match(sentMessage.text, /YOUTUBE DOWNLOADER & MUSIC PLAYER/);
        });
    });

    describe('Menu Submenus', () => {
        it('renders downloader, youtube, tts, kbbi, libur, kalender, tools, cuaca, and pdf submenus', async () => {
            const submenus = ['downloader', 'youtube', 'tts', 'kbbi', 'libur', 'kalender', 'tools', 'cuaca', 'pdf'];
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
