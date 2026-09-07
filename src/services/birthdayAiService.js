const { analyzeImage } = require('./aiVisionService');
const { callLlmWithRotation } = require('./llmRotator');

async function callGroq(payload, logger) {
  return callLlmWithRotation({
    messages: payload.messages,
    max_tokens: payload.max_tokens,
    temperature: payload.temperature,
    isVision: false,
    logger,
  });
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
 * Generates the AI Verdict: Siapa Kamu Sebenarnya? (20:30 WIB)
 * Pseudo-psychological profile based on Truth answers, hot takes, memories, confess, and unsaid things.
 */
async function generateAiVerdict({
  targetName,
  truthQuestions = [],
  hotTakes = [],
  memories = [],
  confessions = [],
  unsaidThings = [],
  logger,
}) {
  const formattedTruth = truthQuestions
    .filter((t) => t.answer)
    .map((t) => `- Tanya (${t.askerName || 'Warga'}): "${t.question}" -> Jawab: "${t.answer}"`)
    .join('\n');

  const formattedHotTakes = hotTakes
    .map((h) => `- ${h.senderName || 'Warga'}${h.isRebuttal ? ' (Tanggapan Target)' : ''}: "${h.text}"`)
    .join('\n');

  const formattedMemories = memories.map((m) => `- "${m}"`).join('\n');
  const formattedConfess = confessions.map((c) => `- "${c}"`).join('\n');
  const formattedUnsaid = unsaidThings.map((u) => `- ${u.senderName || 'Warga'}: "${u.text}"`).join('\n');

  const contextParts = [
    `Nama target yang dianalisis: ${targetName}`,
    formattedTruth ? `Data Sesi Truth Questions (pertanyaan & jawaban langsung):\n${formattedTruth}` : null,
    formattedHotTakes ? `Data Sesi Hot Take Night (opini warga & tanggapan dia):\n${formattedHotTakes}` : null,
    formattedMemories ? `Data Memory Wall (kelakuan & kenangan masa lalu):\n${formattedMemories}` : null,
    formattedConfess ? `Data Anonymous Confession (rahasia/pengakuan teman):\n${formattedConfess}` : null,
    formattedUnsaid ? `Data Satu Hal yang Belum Pernah Diucapkan:\n${formattedUnsaid}` : null,
  ].filter(Boolean).join('\n\n');

  const payload = {
    messages: [
      {
        role: 'system',
        content: `Kamu adalah seorang profiler psikologis palsu yang sangat cerdas, humoris, tapi surprisingly accurate. Tugasmu menganalisis kepribadian asli dari ${targetName} berdasarkan data-data yang terkumpul seharian di grup WhatsApp.

PANDUAN OUTPUT (SANGAT PENTING):
1. INI BUKAN REKAP! Jangan buat ringkasan kronologis kegiatan hari ini. Ini adalah ANALISIS KARAKTER & PROFIL PSIKOLOGIS yang "terlalu jujur" (brutally honest yet affectionate).
2. Tone: Serius seperti psikiater / profiler FBI profesional, tapi kesimpulan dan deskripsinya kocak, relate banget dengan kehidupan anak muda Indonesia, dan bikin seisi grup ngakak sambil mikir "anjir bener lagi".
3. Struktur Pesan (1 Bubble Pesan WhatsApp yang rapi & estetik):
   - 📋 *BERKAS PSIKOLOGIS: SIAPA SEBENARNYA [NAMA]?*
   - *Tipe Kepribadian (Nama Tipe Absurd)*: misalnya "Introvert Berkedok Humas", "Overthinker Tingkat Dewa dengan Wajah Santai", dsb.
   - *Diagnosis Karakter*: analisis karakter mendalam berdasarkan fakta-fakta hari ini (kebiasaan, respon saat diserang hot take, cara dia jawab truth, dsb).
   - *Mekanisme Pertahanan Diri*: cara unik dia menghadapi masalah atau ledekan orang lain.
   - *Vonis Akhir (Verdict)*: 1-2 kalimat pamungkas tentang posisi dia di mata pertemanan ini.
4. Gunakan bahasa gaul santai/hangat khas tongkrongan Indonesia tapi dengan terminologi psikiatris analitis yang menggelitik. Maksimal 300-500 kata, padat dan punchy.`,
      },
      {
        role: 'user',
        content: `Berikut adalah data perilaku dan pernyataan ${targetName} serta warga grup hari ini:\n\n${contextParts}\n\nBuatkan berkas vonis psikologis AI Verdict untuk ${targetName}:`,
      },
    ],
    max_tokens: 1200,
    temperature: 0.85,
  };

  const res = await callGroq(payload, logger);
  if (res.success && res.text) return res.text;

  // Fallback verdict
  return `📋 *BERKAS PSIKOLOGIS: SIAPA SEBENARNYA ${targetName.toUpperCase()}?*

*Tipe Kepribadian:* _Overthinker Profesional Berkedok Manusia Santai_

*Diagnosis Karakter:*
Berdasarkan data observasi seharian ini, ${targetName} terbukti memiliki kapasitas adaptasi sosial yang unik. Di luar tampak tenang menghadapi segala ledekan dan pertanyaan, namun di balik ketenangannya terdapat mesin kalkulasi yang mencatat setiap detail obrolan. Dia adalah tipe orang yang butuh waktu sendiri setelah keramaian, tapi diam-diam menikmati setiap perhatian yang diberikan.

*Mekanisme Pertahanan Diri:*
Menjawab pertanyaan serius dengan senyuman atau humor defensif agar tidak terlalu terbongkar isi hatinya.

*Vonis Akhir (Verdict):*
Meskipun sering denial terhadap beberapa fakta, dia adalah perekat alami di grup ini yang kehadirannya selalu dinantikan.`;
}

/**
 * Generates the Humanized Midnight Letter (00:00 WIB)
 * Exact ingredient ordering: chatSummary -> memories -> photoStories -> roast -> hotTakes -> unsaidThings -> confessions -> whatIfAnswers -> wishJar -> predictions -> rateTheDay
 */
async function generateMidnightLetter({
  targetName,
  chatSummary,
  memories,
  photoStories,
  roast,
  hotTakes,
  unsaidThings,
  confessions,
  whatIfAnswers,
  whatIfScenario,
  wishJar,
  predictions,
  rateTheDay,
  logger,
}) {
  const formattedPhotos = (photoStories || []).map((p) => {
    const sender = p.senderName || 'Warga';
    const cap = p.caption ? `Caption: "${p.caption}"` : 'Tanpa caption';
    const visual = p.aiStory || p.description || '';
    return `- Foto dari ${sender} (${cap})${visual ? `: ${visual}` : ''}`;
  }).join('\n');

  const formattedHotTakes = (hotTakes || []).map((h) => {
    if (typeof h === 'string') return `- ${h}`;
    return `- ${h.senderName || 'Warga'}${h.isRebuttal ? ' (Tanggapan Target)' : ''}: "${h.text}"`;
  }).join('\n');

  const formattedUnsaid = (unsaidThings || []).map((u) => {
    if (typeof u === 'string') return `- ${u}`;
    return `- Dari ${u.senderName || 'Warga'}: "${u.text}"`;
  }).join('\n');

  const formattedWhatIf = (whatIfAnswers || []).map((w) => {
    if (typeof w === 'string') return `- ${w}`;
    return `- ${w.senderName || 'Warga'}: "${w.text}"`;
  }).join('\n');

  let formattedRateTheDay = null;
  if (rateTheDay) {
    if (typeof rateTheDay === 'string') {
      formattedRateTheDay = rateTheDay;
    } else if (rateTheDay.rating || rateTheDay.reason) {
      formattedRateTheDay = `Rating: ${rateTheDay.rating || '-'}/10 | Alasan/Perasaan: "${rateTheDay.reason || rateTheDay.fullText || '-'}"`;
    }
  }

  // Exact prompt context ordering requested by brief:
  // chatSummary -> memories -> photoStories -> roast -> hotTakes -> unsaidThings -> confessions -> whatIfAnswers -> wishJar -> predictions -> rateTheDay
  const contextParts = [
    `Nama yang berulang tahun: ${targetName}`,
    chatSummary ? `1. Rangkuman suasana & percakapan grup sepanjang hari:\n${chatSummary}` : null,
    memories?.length ? `2. Memory Wall (kenangan masa lalu dari teman-temannya):\n${memories.join('\n')}` : null,
    formattedPhotos ? `3. Foto-foto kenangan yang dibagikan hari ini (dan apa yang terlihat di foto):\n${formattedPhotos}` : null,
    roast?.length ? `4. Roast & candaan terbaik warga grup:\n${roast.join('\n')}` : null,
    formattedHotTakes ? `5. Hot Take & perdebatan tentang dia hari ini:\n${formattedHotTakes}` : null,
    formattedUnsaid ? `6. Hal-hal jujur yang belum pernah diucapkan ke dia:\n${formattedUnsaid}` : null,
    confessions?.length ? `7. Anonymous Confession rahasia dari teman-temannya:\n${confessions.join('\n')}` : null,
    formattedWhatIf ? `8. Jawaban skenario absurd "Kalau ${targetName} Jadi ${whatIfScenario || '...'}:"\n${formattedWhatIf}` : null,
    wishJar?.length ? `9. Doa & harapan tulus dari Wish Jar:\n${wishJar.join('\n')}` : null,
    predictions?.length ? `10. Prediksi masa depan untuk tahun depan:\n${predictions.join('\n')}` : null,
    formattedRateTheDay ? `11. SUARA TERAKHIR DARI ${targetName.toUpperCase()} MALAM INI (Rate The Day):\n${formattedRateTheDay}` : null,
  ].filter(Boolean).join('\n\n');

  const payload = {
    messages: [
      {
        role: 'system',
        content: `Kamu adalah seorang sahabat dekat yang sedang menulis surat penutup larut malam (Midnight Letter) di grup WhatsApp untuk ${targetName}.

PANDUAN MENULIS (SANGAT PENTING):
1. Tulis seperti MANUSIA yang sedang bicara tulus dari hati di tengah heningnya tengah malam, BUKAN seperti AI yang merangkum data laporan.
2. HINDARI struktur kaku, poin-poin angka, bullet points, atau subjudul formal. Buat mengalir bebas seperti surat atau pesan panjang dalam SATU BUBBLE PANJANG yang ditulis dengan penuh perasaan.
3. Boleh ada kalimat yang menggantung, repetisi emosional ("jujur ya...", "kadang gue mikir..."), atau alur yang mengalir santai layaknya obrolan anak muda Indonesia yang akrab (bahasa gaul santai/hangat).
4. Singgung foto-foto kenangan, memori lucu, roast tipis, hot take seru, dan hal-hal yang belum pernah terucap yang sempat dibagikan warga hari ini.
5. Suara Terakhir (Rate The Day): Jika ada respon Rate The Day dari ${targetName}, singgung perasaannya tersebut di akhir surat sebagai penutup hari yang manis.
6. Alur emosi:
   - Mulai dengan suasana tengah malam dan sedikit canda/humor tentang hari yang baru saja lewat.
   - Masukkan memori lucu, foto yang dibagikan, roast & hot take tipis, dan obrolan mereka hari ini.
   - Masuk ke bagian menyentuh: betapa berartinya kehadiran dia di tengah pertemanan ini, confess tulus dari teman-temannya, hal yang selama ini tak terucap, dan doa tulus yang dirangkum dari wish jar.
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

Hari ini seru banget, beneran. Dari pagi pas dibuka, lagu yang muter, memori-memori gila yang dibongkar bareng-bareng, obrolan absurd, sampe harapan-harapan kecil yang ditulis teman-teman lo. 

Mungkin lo sekarang lagi rebahan, cape ketawa atau cape baca notif yang masuk seharian. Tapi satu hal yang perlu lo tau: semua candaan, ledekan, hot take, sampe doa yang terucap hari ini, itu bener-bener nyata dari orang-orang yang seneng banget lo ada di sini.

Tahun ini, semoga langkah lo lebih enteng. Apapun yang lagi lo kejar, semoga jalannya dibukain pelan-pelan. Selamat ulang tahun sekali lagi, ${targetName}. Istirahat yang nyenyak malam ini.`;
}

/**
 * Generates the Omniscient Narrator Letter ("Surat Dini Hari" at 02:00 WIB)
 */
async function generateNarratorLetter({ targetName, memories, photoStories, wishJar, predictions, chatSummary, logger }) {
  const formattedPhotos = (photoStories || []).map((p) => {
    const sender = p.senderName || 'Warga';
    const cap = p.caption ? `Caption: "${p.caption}"` : 'Tanpa caption';
    const visual = p.aiStory || p.description || '';
    return `- Foto dari ${sender} (${cap})${visual ? `: ${visual}` : ''}`;
  }).join('\n');

  const contextParts = [
    `Nama yang berulang tahun: ${targetName}`,
    memories?.length ? `Kenangan manis/kocak bersama:\n${memories.join('\n')}` : null,
    formattedPhotos ? `Foto kenangan visual yang dibagikan:\n${formattedPhotos}` : null,
    wishJar?.length ? `Kumpulan doa dan harapan:\n${wishJar.join('\n')}` : null,
    predictions?.length ? `Prediksi masa depan:\n${predictions.join('\n')}` : null,
    chatSummary ? `Rangkuman obrolan hari itu:\n${chatSummary}` : null,
  ].filter(Boolean).join('\n\n');

  const payload = {
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
  generateAiVerdict,
  generateMidnightLetter,
  generateNarratorLetter,
};
