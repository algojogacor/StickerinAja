const { analyzeImage, optimizeImageForVision, VISION_MODEL } = require('./aiVisionService');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const TEXT_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';

function getApiKeys() {
  const keys = [
    process.env.GROQ_API_KEY_PRIMARY,
    process.env.GROQ_API_KEY_SECONDARY,
    process.env.GROQ_API_KEY_1,
    process.env.GROQ_API_KEY_2,
  ].filter(Boolean);
  return [...new Set(keys)];
}

async function callGroq(payload, logger) {
  const keys = getApiKeys();
  if (keys.length === 0) {
    return { success: false, error: 'GROQ_API_KEY belum dikonfigurasi' };
  }

  let lastError = null;
  for (const key of keys) {
    try {
      const res = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (res.ok && data.choices?.[0]?.message?.content) {
        return { success: true, text: data.choices[0].message.content.trim() };
      }
      lastError = data.error?.message || `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.message;
    }
  }

  logger?.warn({ err: lastError }, '[Birthday AI] Failed to call Groq');
  return { success: false, error: lastError || 'Groq call failed' };
}

/**
 * Analyzes a memory photo using Groq/Qwen multimodal vision
 */
async function describeMemoryPhoto({ imageBuffer, senderName, caption, logger }) {
  const prompt = `Kamu adalah teman akrab di grup WhatsApp yang hangat, seru, dan punya selera humor santai. 
Foto kenangan ini dikirim oleh ${senderName || 'salah satu teman'} dengan caption: "${caption || '-'}" untuk merayakan teman yang sedang berulang tahun.
Deskripsikan suasana foto ini, ekspresi orang di dalamnya, dan momen lucunya dalam 2-3 kalimat akrab bahasa Indonesia yang hangat dan kocak. Jangan kaku.`;

  try {
    const res = await analyzeImage({ imageBuffer, prompt, logger });
    if (res.success && res.text) return res.text;
    return caption || 'Foto kenangan seru bareng warga grup!';
  } catch (err) {
    logger?.warn({ err }, '[Birthday AI] Photo description failed');
    return caption || 'Foto kenangan spesial hari ini.';
  }
}

/**
 * Summarizes the entire day's chat log (07:00 - 23:00) with depth and detail
 */
async function summarizeDayChat({ chatMessages, targetName, logger }) {
  if (!Array.isArray(chatMessages) || chatMessages.length === 0) {
    return 'Hari ini grup penuh canda tawa dan obrolan hangat merayakan ulang tahun.';
  }

  const rawLines = chatMessages
    .slice(-150)
    .map((m) => `[${m.time || ''}] ${m.senderName || 'Warga'}: ${m.text || ''}`)
    .join('\n');

  const payload = {
    model: TEXT_MODEL,
    messages: [
      {
        role: 'system',
        content: `Kamu adalah asisten pencatat kenangan grup. Tugasmu merangkum log percakapan grup WhatsApp sepanjang hari ulang tahun ${targetName} secara LENGKAP dan DETAIL. 
Catat topik-topik obrolan seru, candaan/banter yang terjadi, respons teman-teman, dan momen-momen lucu yang muncul. Rangkuman ini harus kaya konteks dan mendalam (3-5 paragraf mengalir), jangan generik.`,
      },
      {
        role: 'user',
        content: `Berikut adalah log percakapan grup hari ini:\n\n${rawLines}\n\nBuat rangkuman detail percakapan hari ini untuk bahan Midnight Letter:`,
      },
    ],
    max_tokens: 1200,
    temperature: 0.7,
  };

  const res = await callGroq(payload, logger);
  return res.success ? res.text : 'Grup ramai dengan obrolan seru dan canda tawa sepanjang hari.';
}

/**
 * Generates the Humanized Midnight Letter (00:00 WIB)
 */
async function generateMidnightLetter({ targetName, roast, memories, wishJar, predictions, confessions, chatSummary, logger }) {
  const contextParts = [
    `Nama yang berulang tahun: ${targetName}`,
    roast?.length ? `Roast/candaan terbaik warga grup:\n${roast.join('\n')}` : null,
    memories?.length ? `Memory & kenangan yang dikirim:\n${memories.join('\n')}` : null,
    wishJar?.length ? `Harapan dari Wish Jar:\n${wishJar.join('\n')}` : null,
    predictions?.length ? `Prediksi masa depan dari teman-temannya:\n${predictions.join('\n')}` : null,
    confessions?.length ? `Confess anonim teman-temannya:\n${confessions.join('\n')}` : null,
    chatSummary ? `Rangkuman suasana & percakapan grup hari ini:\n${chatSummary}` : null,
  ].filter(Boolean).join('\n\n');

  const payload = {
    model: TEXT_MODEL,
    messages: [
      {
        role: 'system',
        content: `Kamu adalah seorang sahabat dekat yang sedang menulis surat penutup larut malam (Midnight Letter) di grup WhatsApp untuk ${targetName}.

PANDUAN MENULIS (SANGAT PENTING):
1. Tulis seperti MANUSIA yang sedang bicara tulus dari hati di tengah heningnya tengah malam, BUKAN seperti AI yang merangkum data laporan.
2. HINDARI struktur kaku, poin-poin angka, bullet points, atau subjudul formal. Buat mengalir bebas seperti surat atau pesan panjang yang ditulis dengan penuh perasaan.
3. Boleh ada kalimat yang menggantung, repetisi emosional ("jujur ya...", "kadang gue mikir..."), atau alur yang mengalir santai layaknya obrolan anak muda Indonesia yang akrab (bahasa gaul santai/hangat).
4. Tulisan harus BENAR-BENAR PANJANG dan mendalam.
5. Alur emosi:
   - Mulai dengan suasana tengah malam dan sedikit canda/humor tentang hari yang baru saja lewat.
   - Masukkan memori lucu, roast tipis, dan obrolan mereka hari ini.
   - Masuk ke bagian menyentuh: betapa berartinya kehadiran dia di tengah pertemanan ini, confess tulus dari teman-temannya, dan doa tulus yang dirangkum dari wish jar.
   - Tutup dengan ucapan selamat tidur dan doa panjang yang menenangkan.`,
      },
      {
        role: 'user',
        content: `Berikut adalah semua bahan yang terkumpul hari ini:\n\n${contextParts}\n\nTulis Midnight Letter panjang yang hangat dan manusiawi untuk ${targetName}:`,
      },
    ],
    max_tokens: 2000,
    temperature: 0.85,
  };

  const res = await callGroq(payload, logger);
  if (res.success && res.text) return res.text;

  // Fallback humanized text
  return `Udah jam 12 malem lewat ya, ${targetName}...

Hari ini seru banget, beneran. Dari pagi pas dibuka, lagu yang muter, memori-memori gila yang dibongkar bareng-bareng, sampe harapan-harapan kecil yang ditulis teman-teman lo. 

Mungkin lo sekarang lagi rebahan, cape ketawa atau cape baca notif yang masuk seharian. Tapi satu hal yang perlu lo tau: semua candaan, ledekan, sampe doa yang terucap hari ini, itu bener-bener nyata dari orang-orang yang seneng banget lo ada di sini.

Tahun ini, semoga langkah lo lebih enteng. Apapun yang lagi lo kejar, semoga jalannya dibukain pelan-pelan. Selamat ulang tahun sekali lagi, ${targetName}. Istirahat yang nyenyak malam ini.`;
}

/**
 * Generates the Omniscient Narrator Letter ("Surat Dini Hari" at 02:00 WIB)
 */
async function generateNarratorLetter({ targetName, memories, wishJar, predictions, chatSummary, logger }) {
  const contextParts = [
    `Nama yang berulang tahun: ${targetName}`,
    memories?.length ? `Kenangan manis/kocak bersama:\n${memories.join('\n')}` : null,
    wishJar?.length ? `Kumpulan doa dan harapan:\n${wishJar.join('\n')}` : null,
    predictions?.length ? `Prediksi masa depan:\n${predictions.join('\n')}` : null,
    chatSummary ? `Rangkuman obrolan hari itu:\n${chatSummary}` : null,
  ].filter(Boolean).join('\n\n');

  const payload = {
    model: TEXT_MODEL,
    messages: [
      {
        role: 'system',
        content: `Kamu adalah narator ketiga serba tahu (omniscient narrator) dalam sebuah novel kehidupan yang puitis, hangat, dan menyejukkan. Sekarang adalah jam 02:00 dini hari di heningnya malam, sehari setelah perayaan ulang tahun ${targetName} selesai. Asumsinya ${targetName} sedang tertidur pulas dan pesan ini akan menjadi hal pertama yang dibaca saat ia membuka mata di pagi hari.

PANDUAN MENULIS (SANGAT PENTING):
1. Sudut pandang orang ketiga serba tahu yang melihat dari luar: mengamati tawa yang sempat pecah, doa-doa yang tersembunyi di balik candaan, dan kehangatan yang mengelilingi ${targetName}.
2. Tone: Doa yang sangat tulus, kedamaian, dan penguatan emosional bahwa ${targetName} TIDAK PERNAH SENDIRIAN di dunia ini.
3. Ditulis bukan dengan mengatasnamakan "teman-temanmu", melainkan sebagai suara semesta yang berbicara langsung ke dalam jiwanya, penuh cinta tanpa syarat dan penerimaan utuh.
4. Jangan kaku atau teoritis. Tulis dengan gaya bahasa sastra yang membumi, mengalir panjang, manusiawi, dan mampu membuat matanya berkaca-kaca karena merasa begitu disayangi saat bangun tidur.
5. Ditutup dengan doa fajar dan berkat untuk hari-hari barunya ke depan.`,
      },
      {
        role: 'user',
        content: `Berikut adalah esensi dari hari yang baru saja berlalu:\n\n${contextParts}\n\nTulis Surat Dini Hari yang menyentuh hati dan menenangkan untuk ${targetName}:`,
      },
    ],
    max_tokens: 2000,
    temperature: 0.85,
  };

  const res = await callGroq(payload, logger);
  if (res.success && res.text) return res.text;

  // Fallback narrator text
  return `Di jam dua pagi, ketika dunia akhirnya sunyi dan kamu sedang tertidur lelap...

Malam ini membiarkan semua tawa, celoteh, dan doa-doa yang beterbangan kemarin mengendap perlahan di sudut kamarmu. Jika kamu bisa melihat hari kemarin dari kejauhan, kamu akan menyadari betapa kamu begitu dijaga dan disayangi—bukan hanya oleh mereka yang mengirimkan kata-kata, tapi oleh semesta yang menempatkan orang-orang baik di sekelilingmu.

Kamu tidak pernah berjalan sendirian, ${targetName}. Bahkan di hari-hari ketika kamu merasa langkahmu berat atau sepi, kehangatan itu selalu ada, menunggu untuk kamu ingat kembali.

Ketika matamu terbuka pagi ini, tarik napas yang dalam. Sambut tahun barumu dengan hati yang tenang. Kamu sudah tumbuh sejauh ini, dan hal-hal indah sedang menunggumu di depan sana.`;
}

module.exports = {
  describeMemoryPhoto,
  summarizeDayChat,
  generateMidnightLetter,
  generateNarratorLetter,
};
