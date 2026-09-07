const fs = require("fs");
const { getConfig } = require("../config/birthdayConfig");

function mentionText(persons) {
  return (Array.isArray(persons) ? persons : [persons])
    .map((person) => {
      const id = (person.participantId || "").replace(/:\d+(?=@)/, "").split("@")[0];
      const customName = person.name && person.name !== id ? ` (${person.name})` : "";
      return id ? `@${id}${customName}` : `@${person.name || "Unknown"}`;
    })
    .join(", ");
}

function mentions(persons) {
  return (Array.isArray(persons) ? persons : [persons]).map((person) => person.participantId).filter(Boolean);
}

function result(text, persons) {
  return { text, mentions: mentions(persons) };
}

function formatOpeningQuest(persons, questText, lastYearPredictions = []) {
  const parts = [];
  if (Array.isArray(lastYearPredictions) && lastYearPredictions.length > 0) {
    parts.push(`🔮 *KILAS BALIK PREDIKSI TAHUN LALU* 🔮\n\nSebelum mulai, yuk kita cek ramalan teman-teman tahun lalu untuk ${mentionText(persons)}:`);
    for (const pred of lastYearPredictions) {
      parts.push(`• *${pred.senderName || 'Warga'}*: “${pred.predictionText}”`);
    }
    parts.push(`Kira-kira ada yang beneran kejadian gak nih? 😄\n\n━━━━━━━━━━━━━━━━━━━━\n`);
  }

  parts.push(
    `🚨🎉 *BIRTHDAY TAKEOVER AKTIF!* 🎉🚨\n\n` +
    `Hari ini panggung utama grup milik ${mentionText(persons)}! 🎂✨\n` +
    `Semoga hari ini penuh kabar baik, tawa lepas, dan traktiran.\n\n` +
    `🎯 *BIRTHDAY QUEST HARI INI:*\n` +
    `“${questText || 'Kirim 1 foto paling bahagia lo hari ini ke grup!'}”\n\n` +
    `📢 _Balas (reply) pesan ini untuk menyelesaikan quest sebelum jam 23:00 WIB! Kalau tuntas dapet apresiasi, kalau mangkir ada sanksi kocak!_`
  );

  return result(parts.join("\n"), persons);
}

function formatSong(persons) {
  const config = getConfig();
  const hasAudio = Boolean(config.BIRTHDAY_AUDIO_PATH && fs.existsSync(config.BIRTHDAY_AUDIO_PATH));
  const fallbackUrl = !hasAudio && config.BIRTHDAY_SONG_URL ? `\n\n🎶 ${config.BIRTHDAY_SONG_URL}` : "";
  return result(`🎵 *LAGU ULANG TAHUN*\n\nSelamat ulang tahun untuk ${mentionText(persons)}! 🎂🎉${fallbackUrl}`, persons);
}

function formatMemoryWallPrompt(persons) {
  return result(
    `🧱✨ *MEMORY WALL & UCAPAN DIBUKA!* ✨🧱\n\n` +
    `Spesial untuk ${mentionText(persons)}!\n` +
    `Kalian punya 2 misi di sesi ini via reply pesan ini:\n\n` +
    `1️⃣ Kirim *ucapan atau doa terbaik* kalian.\n` +
    `2️⃣ Kirim *memori paling absurd, lucu, atau berkesan* bareng dia!\n\n` +
    `📢 _Yuk reply pesan ini sekarang dan ramaikan hari spesialnya!_`,
    persons
  );
}

function formatTruthQuestionsPrompt(persons) {
  return result(
    `🎲🔥 *SESI TRUTH QUESTIONS DIBUKA!* 🔥🎲\n\n` +
    `Aturan main:\n` +
    `• Setiap anggota punya jatah *maksimal 5 pertanyaan*.\n` +
    `• ${mentionText(persons)} boleh tanya ke *siapapun* di grup (sebut/mention orangnya).\n` +
    `• Anggota lain *hanya boleh bertanya ke ${mentionText(persons)}*.\n\n` +
    `⚖️ *Aturan Jawaban (Honor System):*\n` +
    `• Jawab dengan awalan tanda seru (*!*) = Jawaban JUJUR & mengikat!\n` +
    `• Tanpa tanda seru = Jawaban bebas/candaan.\n\n` +
    `📢 _Reply pesan ini untuk langsung mengajukan pertanyaanmu!_`,
    persons
  );
}

function formatPhotoStoryPrompt(persons) {
  return result(
    `📸📖 *SATU FOTO SATU CERITA* 📖📸\n\n` +
    `Yuk buka galeri kalian! Masing-masing anggota grup (selain ${mentionText(persons)}) diminta kirim/reply *1 foto kenangan atau momen seru bareng dia*.\n\n` +
    `Foto bakal disimpan rapi ke arsip kenangan grup. Kirim sekarang ya! 🎞️✨`,
    persons
  );
}

function formatRoastPrompt(persons) {
  return result(
    `🔥🌶️ *SESI BIRTHDAY ROAST DIBUKA!* 🌶️🔥\n\n` +
    `Spesial untuk ${mentionText(persons)}:\n` +
    `Sekarang saatnya warga grup keluarin roasting terlucu, fakta kocak, atau ledekan penuh kasih sayang buat dia! 😂\n\n` +
    `📢 _Reply pesan ini dengan roast terbaikmu! Berikan reaksi emoji ke roast yang paling savage dan bikin ngakak! 😂_`,
    persons
  );
}

const QUEST_POOL = [
  "Kirim 1 foto paling bahagia lo hari ini ke grup!",
  "Ceritakan 1 hal konyol yang pernah lo lakuin tahun lalu ke grup!",
  "Kirim voice note bernyanyi satu bait lagu favorit lo!",
  "Kirim selfie muka paling jelek/lucu lo hari ini!",
  "Sebutkan 3 hal yang paling lo syukuri di umur baru ini!",
];

function pickQuest() {
  return QUEST_POOL[Math.floor(Math.random() * QUEST_POOL.length)];
}

const PENALTY_POOL = [
  "Wajib mendoakan semua warga grup sebelum tidur malam ini!",
  "Wajib pasang status foto profil paling kocak selama 2 jam!",
  "Wajib traktir gorengan atau es teh saat kumpul berikutnya!",
  "Wajib kirim voice note ucapan terima kasih dengan gaya pembaca berita!",
];

function pickPenalty() {
  return PENALTY_POOL[Math.floor(Math.random() * PENALTY_POOL.length)];
}

function formatDmAnnouncementGroup(targetOrMembers, maybeMembers = []) {
  let targetName = "Teman yang Ulang Tahun";
  let pendingMembers = [];
  if (Array.isArray(targetOrMembers)) {
    pendingMembers = targetOrMembers;
  } else {
    targetName = typeof targetOrMembers === "string" ? targetOrMembers : (targetOrMembers?.name || "Teman yang Ulang Tahun");
    pendingMembers = Array.isArray(maybeMembers) ? maybeMembers : [];
  }
  const memberMentions = pendingMembers.map((m) => {
    const jid = typeof m === "string" ? m : (m.participantId || m.id || m.jid || "");
    return `@${jid.replace(/:\d+(?=@)/, "").split("@")[0]}`;
  }).filter(Boolean).join(", ");
  const rawJids = pendingMembers.map((m) => {
    const jid = typeof m === "string" ? m : (m.participantId || m.id || m.jid || "");
    return jid.replace(/:\d+(?=@)/, "");
  }).filter(Boolean);
  return {
    text:
      `🕵️‍♂️🤫 *MISI RAHASIA: CONFESS & PREDIKSI* 🤫🕵️‍♂️\n\n` +
      `Bot baru saja mencoba kirim DM rahasia ke teman-teman selain yang berulang tahun.\n\n` +
      `Bagi kalian yang belum pernah chat bot secara pribadi di WhatsApp, silakan buka nomor bot ini dan *chat apapun dulu di DM pribadi* agar sesi rahasia bisa dimulai!\n\n` +
      `Menunggu balasan dari: ${memberMentions || "Semua teman"}\n\n` +
      `⏳ _Waktu pengisian: 5 jam. Confess akan dikirim 100% anonim jam 18:00!_`,
    mentions: rawJids,
  };
}

function formatDmPrompt(targetOrPersons) {
  const targetName = typeof targetOrPersons === "string"
    ? targetOrPersons
    : (Array.isArray(targetOrPersons) ? (targetOrPersons[0]?.name || targetOrPersons[0]?.participantId?.split("@")[0] || "Teman") : (targetOrPersons?.name || "Teman"));

  return {
    text:
      `Halo! Ini pesan rahasia dari Bot untuk perayaan ulang tahun *${targetName}* 🎂\n\n` +
      `Mohon balas pesan ini dengan 2 hal berikut sekaligus:\n\n` +
      `1️⃣ *Confess Something*: Satu pengakuan, rahasia kecil, atau hal yang selama ini belum pernah lo ungkapin langsung ke dia. (Akan dikirim ke grup secara 100% ANONIM).\n\n` +
      `2️⃣ *Prediksi Masa Depan*: Satu prediksi absurd atau sungguh-sungguh tentang apa yang bakal terjadi sama dia di setahun ke depan. (Akan disimpan dan ditagih tahun depan!).\n\n` +
      `_Kirim balasanmu langsung ke chat ini ya!_`,
  };
}

function formatConfessReveal(targetOrPersons, confessions = []) {
  const targetName = typeof targetOrPersons === "string"
    ? targetOrPersons
    : (Array.isArray(targetOrPersons) ? (targetOrPersons[0]?.name || targetOrPersons[0]?.participantId?.split("@")[0] || "Teman") : (targetOrPersons?.name || "Teman"));

  const list = (Array.isArray(confessions) && confessions.length > 0)
    ? confessions.map((c, i) => `🔹 *Pengakuan #${i + 1}:*\n“${c.text || c}”`).join("\n\n")
    : "Belum ada pengakuan yang masuk, tapi rahasia tetap aman 😄";

  return {
    text:
      `💌🕯️ *CONFESS SOMETHING (100% ANONIM)* 🕯️💌\n\n` +
      `Khusus untuk *${targetName}*, ada beberapa pengakuan jujur dari warga grup yang dikirim via jalur rahasia:\n\n` +
      `${list}\n\n` +
      `_Semua pengakuan di atas dikirim tanpa nama pengirim._`,
    mentions: [],
  };
}

function formatWishJarPrompt(persons) {
  return result(
    `🫙✨ *SESI WISH JAR DIBUKA!* ✨🫙\n\n` +
    `Sebelum hari berakhir, mari kita isi toples harapan untuk ${mentionText(persons)}!\n\n` +
    `Kalian wajib menggunakan format awalan:\n` +
    `👉 *"Tahun ini, semoga kamu [harapanmu]..."*\n\n` +
    `📢 _Reply pesan ini dan tuliskan harapan terbaik kalian untuk dia ya!_`,
    persons
  );
}

function formatHotTakePrompt(persons) {
  const name = (Array.isArray(persons) ? persons[0]?.name : persons?.name) || "dia";
  return result(
    `🌶️🔥 *HOT TAKE NIGHT DIBUKA!* 🔥🌶️\n\n` +
    `Spesial untuk ${mentionText(persons)}!\n\n` +
    `Masing-masing warga grup diminta kirim *satu statement kontroversial atau opini yang bisa diperdebatkan* tentang ${name} via reply pesan ini.\n\n` +
    `⚠️ _Catatan: Ini bukan roast, bukan juga pujian murni, melainkan opini atau sudut pandang yang bisa disetujui atau dibantah!_\n\n` +
    `💡 *Contoh Sudut Pandang Pemantik (Bisa Dipakai / Bikin Sendiri):*\n` +
    `1️⃣ “Sebenernya ${name} itu jauh lebih introvert & butuh me-time ekstrem dibanding kelihatannya di grup.”\n` +
    `2️⃣ “Selera musik atau tontonan ${name} yang sebenarnya itu jauh lebih unhinged / random dari yang pernah dia akuin.”\n` +
    `3️⃣ “${name} aslinya punya standar perfectionist tinggi ke diri sendiri, makanya suka overthinking hal sepele.”\n` +
    `4️⃣ “${name} kalau lagi kesel malah pura-pura santai/tenang, tapi auranya kerasa sampai radius 5 km.”\n` +
    `5️⃣ “Di balik sifat santainya, ${name} diem-diem pemerhati paling detail dan tau semua kebiasaan warga grup.”\n\n` +
    `👉 ${mentionText(persons)} bisa langsung reply balik pesan teman-teman untuk *SETUJU* atau *BANTAH*!\n` +
    `📢 _Diskusi bebas mengalir, highlight hot take terbaik akan masuk ke Grand Recap jam 21:00! Kirim opinimu sekarang!_`,
    persons
  );
}

function formatUnsaidThingPrompt(persons) {
  return result(
    `💬🕊️ *SATU HAL YANG BELUM PERNAH DIUCAPKAN* 🕊️💬\n\n` +
    `Kadang ada kata-kata yang selalu tertunda karena gak pernah nemu momen yang pas...\n\n` +
    `Malam ini, setiap warga grup diajak menyampaikan *1 hal yang selama ini ingin diucapkan langsung ke ${mentionText(persons)}*.\n\n` +
    `✨ *Ketentuan:*\n` +
    `• Bisa serius, apresiasi mendalam, atau hal receh yang kepikiran.\n` +
    `• Dikirim via *reply pesan ini langsung di grup* (terbuka & non-anonim, dengan nama kalian).\n\n` +
    `📢 _Kutipan-kutipan terbaik dari sesi ini akan dibacakan di Grand Recap jam 21:00 WIB. Yuk sampaikan sekarang!_`,
    persons
  );
}

function formatWhatIfPrompt(persons, scenario) {
  const name = (Array.isArray(persons) ? persons[0]?.name : persons?.name) || "dia";
  const chosenScenario = scenario || "presiden Republik Indonesia mendadak";
  return result(
    `🎭🎪 *KALAU KAMU JADI... (SKENARIO ABSURD)* 🎪🎭\n\n` +
    `Mari berimajinasi liar!\n\n` +
    `👉 *Skenario Malam Ini:*\n` +
    `*“Kalau ${name} jadi ${chosenScenario}, hal pertama yang dia lakuin pasti...”*\n\n` +
    `Tiap anggota grup (termasuk ${mentionText(persons)} sendiri!) wajib jawab via reply pesan ini dengan kelanjutan kalimat di atas.\n\n` +
    `📢 _Semua jawaban bakal dikumpulkan dan dibacakan ulang secara dramatis di Grand Recap jam 21:00 WIB!_`,
    persons
  );
}

function formatRateTheDayPrompt(persons) {
  return result(
    `⭐📊 *RATE THE DAY (KHUSUS UNTUK YANG BERULANG TAHUN)* 📊⭐\n\n` +
    `Halo ${mentionText(persons)}! Sebelum hari ulang tahunmu resmi berganti...\n\n` +
    `Tolong beri nilai untuk harimu hari ini dari *skala 1 sampai 10*, plus *satu kalimat alasan atau perasaanmu* via reply pesan ini.\n\n` +
    `Contoh balasan: “9/10, seru banget dari pagi dikerjain tapi berasa disayang se-grup”\n\n` +
    `⏳ _Bot menunggu balasanmu dalam 25 menit ke depan ya. Jawabanmu akan menjadi suara penutup hari ini!_`,
    persons
  );
}

function formatGrandRecap({
  persons,
  wishes = [],
  memories = [],
  roast = [],
  photoStories = [],
  predictions = [],
  truthHighlights = [],
  hotTakes = [],
  unsaidThings = [],
  whatIfScenario = "",
  whatIfAnswers = [],
}) {
  const lines = [
    `👑🌟 *GRAND BIRTHDAY RECAP (JAM 21:00 WIB)* 🌟👑`,
    `Spesial untuk: ${mentionText(persons)}\n`,
    `━━━━━━━━━━━━━━━━━━━━`,
  ];

  // 1. Ucapan & Doa
  lines.push(`💌 *1. UCAPAN & DOA HARI INI:*`);
  if (!wishes.length) {
    lines.push(`• Belum ada ucapan tertulis, tapi doa terbaik tetap menyertai 🎂`);
  } else {
    for (const w of wishes.slice(0, 15)) {
      lines.push(`• *${w.senderName || 'Warga'}*: “${w.messageText}”`);
    }
  }
  lines.push(`\n━━━━━━━━━━━━━━━━━━━━`);

  // 2. Memory Wall
  lines.push(`🧱 *2. MEMORY WALL TERABSURD:*`);
  if (!memories.length) {
    lines.push(`• Tidak ada memori aneh yang dibongkar hari ini 😄`);
  } else {
    for (const m of memories.slice(0, 15)) {
      lines.push(`• *${m.senderName || 'Warga'}*: “${m.text}”`);
    }
  }
  lines.push(`\n━━━━━━━━━━━━━━━━━━━━`);

  // 3. Roast Session
  if (roast.length) {
    lines.push(`🔥 *3. BEST ROAST OF THE DAY:*`);
    for (const r of roast.slice(0, 5)) {
      lines.push(`• *${r.senderName || 'Warga'}*: “${r.text}” ${r.reactions ? `(${r.reactions} reaksi)` : ''}`);
    }
    lines.push(`\n━━━━━━━━━━━━━━━━━━━━`);
  }

  // 4. Truth Questions Highlights
  if (truthHighlights.length) {
    lines.push(`🎲 *4. HIGHLIGHT TRUTH QUESTIONS:*`);
    for (const t of truthHighlights.slice(0, 6)) {
      const tag = t.isHonest ? '🔒 [JUJUR!]' : '💬 [BEBAS]';
      lines.push(`• Tanya (${t.askerName} ➔ ${t.targetName}): “${t.question}”`);
      if (t.answer) lines.push(`  ↳ Jawab ${tag}: “${t.answer}”`);
    }
    lines.push(`\n━━━━━━━━━━━━━━━━━━━━`);
  }

  // 5. Highlight Hot Take Terbaik
  if (hotTakes.length) {
    lines.push(`🌶️ *5. HIGHLIGHT HOT TAKE & REBUTTAL:*`);
    for (const h of hotTakes.slice(0, 6)) {
      const tag = h.isRebuttal ? '🛡️ [TANGGAPAN TARGET]' : '🔥 [HOT TAKE]';
      lines.push(`• *${h.senderName || 'Warga'}* ${tag}: “${h.text}”`);
    }
    lines.push(`\n━━━━━━━━━━━━━━━━━━━━`);
  }

  // 6. Kutipan Satu Hal yang Belum Pernah Diucapkan
  if (unsaidThings.length) {
    lines.push(`🕊️ *6. SATU HAL YANG BELUM PERNAH DIUCAPKAN:*`);
    for (const u of unsaidThings.slice(0, 6)) {
      lines.push(`• Dari *${u.senderName || 'Warga'}*: “${u.text}”`);
    }
    lines.push(`\n━━━━━━━━━━━━━━━━━━━━`);
  }

  // 7. Pembacaan Dramatis Skenario "Kalau Kamu Jadi..."
  if (whatIfAnswers.length) {
    const scTitle = whatIfScenario ? ` (${whatIfScenario})` : '';
    lines.push(`🎭 *7. PEMBACAAN DRAMATIS: KALAU KAMU JADI...${scTitle}:*`);
    for (const a of whatIfAnswers.slice(0, 6)) {
      lines.push(`• *${a.senderName || 'Warga'}*: “...pasti ${a.text}”`);
    }
    lines.push(`\n━━━━━━━━━━━━━━━━━━━━`);
  }

  // 8. Arsip Foto Cerita
  if (photoStories.length) {
    lines.push(`📸 *8. ARSIP KENANGAN HARI INI:*`);
    for (const p of photoStories.slice(0, 5)) {
      const cap = p.caption ? `“${p.caption}”` : 'Momen seru hari ini';
      const aiNote = p.aiStory ? `\n  ↳ Sorotan Momen: ${p.aiStory}` : '';
      lines.push(`• Foto dari *${p.senderName || 'Teman'}*: ${cap}${aiNote}`);
    }
    lines.push(`\n━━━━━━━━━━━━━━━━━━━━`);
  }

  // 9. Prediksi Masa Depan (Non-Anonim)
  lines.push(`🔮 *9. PREDIKSI MASA DEPAN TAHUN INI:*`);
  if (!predictions.length) {
    lines.push(`• Belum ada ramalan yang masuk.`);
  } else {
    for (const p of predictions.slice(0, 10)) {
      lines.push(`• *${p.senderName || 'Warga'}*: “${p.predictionText}”`);
    }
  }
  lines.push(`\n_Catatan: Prediksi di atas disimpan dan akan ditagih tahun depan! 😉_`);

  return result(lines.join("\n"), persons);
}

function formatClosingQuest(persons, questOrCompleted, completedOrPenalty, maybePenalty) {
  let questCompleted = false;
  let penaltyText = "";

  if (typeof questOrCompleted === "boolean") {
    questCompleted = questOrCompleted;
    penaltyText = completedOrPenalty || "";
  } else {
    questCompleted = Boolean(completedOrPenalty);
    penaltyText = maybePenalty || "";
  }

  const questVerdict = questCompleted
    ? `🎖️ *STATUS QUEST: COMPLETED!* ✅\n` +
      `Keren banget ${mentionText(persons)} udah nyelesaiin Birthday Quest hari ini! Misi terselesaikan dengan gemilang 👏🎉`
    : `⚠️ *STATUS QUEST: MISSED!* ❌\n` +
      `Wah ${mentionText(persons)} mangkir dari Birthday Quest hari ini!\n` +
      `Sesuai aturan, lo kena sanksi jenaka:\n` +
      `👉 *${penaltyText || 'Wajib mendoakan semua warga grup sebelum tidur malam ini!'}*\n` +
      `Jangan lupa dijalani ya! 😄`;

  return result(
    `🌙✨ *BIRTHDAY TAKEOVER SELESAI* ✨🌙\n\n` +
    `${questVerdict}\n\n` +
    `Terima kasih untuk seluruh warga grup yang sudah meramaikan hari ini dari pagi sampai malam.\n` +
    `Selamat ulang tahun sekali lagi untuk ${mentionText(persons)}! 🎂💐`,
    persons
  );
}

function formatFlashbackPhoto(photoRecord) {
  const dateStr = photoRecord?.createdAt
    ? new Date(photoRecord.createdAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'Suatu hari';

  return (
    `📸🕰️ *KILAS BALIK KENANGAN (MEMORY FLASHBACK)* 🕰️📸\n\n` +
    `_Tanggal asli: ${dateStr}_ • Dari: *${photoRecord?.senderName || 'Warga grup'}*\n\n` +
    `💬 *Caption:* "${photoRecord?.caption || '-'}"\n\n` +
    `📝 *Catatan Kenangan:*\n` +
    `${photoRecord?.aiDescription || 'Momen seru tak terlupakan bersama kawan-kawan!'}`
  );
}

// Legacy / fallback formatters:
function formatCard(persons) {
  return result(`🎉 *SELAMAT ULANG TAHUN!*\n\nSpesial untuk ${mentionText(persons)} 🎂`, persons);
}

function formatSpotlight(persons) {
  return result(`✨ *BIRTHDAY SPOTLIGHT*\n\nHari ini adalah harinya ${mentionText(persons)}! 🌟`, persons);
}

function formatReminder(persons) {
  return result(`🎊 *PENGINGAT ULANG TAHUN*\n\nYang belum mengucapkan selamat kepada ${mentionText(persons)}, masih ada waktu sampai malam 🎂`, persons);
}

function formatWishesOpen(persons) {
  return formatWishJarPrompt(persons);
}

function formatRecap(persons, wishes = []) {
  return formatGrandRecap({ persons, wishes });
}

function formatClosing(persons) {
  return formatClosingQuest(persons, true, "");
}

module.exports = {
  mentionText,
  mentions,
  result,
  pickQuest,
  pickPenalty,
  formatOpening: formatOpeningQuest,
  formatOpeningQuest,
  formatSong,
  formatMemoryWall: formatMemoryWallPrompt,
  formatMemoryWallPrompt,
  formatTruthOpening: formatTruthQuestionsPrompt,
  formatTruthQuestionsPrompt,
  formatPhotoStoryPrompt,
  formatRoastPrompt,
  formatDmAnnouncementGroup,
  formatDmGroupNotice: formatDmAnnouncementGroup,
  formatDmPrompt,
  formatConfessReveal,
  formatHotTakePrompt,
  formatUnsaidThingPrompt,
  formatWhatIfPrompt,
  formatRateTheDayPrompt,
  formatWishJarPrompt,
  formatGrandRecap,
  formatClosingQuest,
  formatFlashback: formatFlashbackPhoto,
  formatFlashbackPhoto,
  formatCard,
  formatSpotlight,
  formatReminder,
  formatWishesOpen,
  formatRecap,
  formatClosing,
};

