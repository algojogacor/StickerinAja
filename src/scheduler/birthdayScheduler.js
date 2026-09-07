const fs = require("fs");
const { getBotSock, getBirthdaySock } = require("../core/socket");
const { createWindowedScheduler } = require("./windowedScheduler");
const repository = require("../repositories/birthdayRepository");
const birthday = require("../services/birthdayService");
const formatter = require("../formatters/birthdayMessageFormatter");
const birthdayAi = require("../services/birthdayAiService");
const { getConfig, EVENT_SCHEDULES } = require("../config/birthdayConfig");

let scheduler = null;
let logger = null;
let groupJid = "";
const runningEvents = new Set();

function assetBuffer(configKey) {
  const filePath = getConfig()[configKey];
  if (!filePath || !fs.existsSync(filePath)) return null;
  try { return fs.readFileSync(filePath); } catch { return null; }
}

async function sendMultiBubble(sock, targetJid, text, mentions = []) {
  if (!text) return null;
  const clean = String(text).trim();
  if (clean.length <= 1200) {
    return sock.sendMessage(targetJid, { text: clean, ...(mentions.length ? { mentions } : {}) });
  }

  const paragraphs = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const bubbles = [];
  let current = "";

  for (const para of paragraphs) {
    if (current && (current.length + para.length + 2 > 1200)) {
      bubbles.push(current);
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current) bubbles.push(current);

  let lastSent = null;
  for (let i = 0; i < bubbles.length; i++) {
    lastSent = await sock.sendMessage(targetJid, { text: bubbles[i], ...(mentions.length ? { mentions } : {}) });
    if (i < bubbles.length - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return lastSent;
}

async function getTargetGroups() {
  const config = getConfig();
  const explicitTarget = config.BIRTHDAY_TARGET_JID || (groupJid && groupJid !== process.env.GROUP_JID ? groupJid : null);
  if (explicitTarget) {
    return [explicitTarget];
  }

  let birthdayGroups = [];
  try {
    if (typeof birthday.getTodayBirthdayGroups === "function") {
      birthdayGroups = await birthday.getTodayBirthdayGroups();
    }
  } catch (err) {
    logger?.warn({ err }, "[Birthday] Failed to fetch active birthday groups");
  }

  if (birthdayGroups.length > 0) {
    return [...new Set(birthdayGroups.filter(Boolean))];
  }

  const defaultJid = groupJid || process.env.GROUP_JID || "";
  return defaultJid ? [defaultJid] : [];
}

async function resolveMentionsForGroup(sock, targetJid, persons) {
  const baseMentions = persons.map((p) => p.participantId).filter(Boolean);
  if (!targetJid?.endsWith("@g.us") || typeof sock?.groupMetadata !== "function") {
    return baseMentions;
  }
  try {
    const metadata = await sock.groupMetadata(targetJid);
    const enriched = [...baseMentions];
    for (const person of persons) {
      const target = (person.participantId || "").replace(/:\d+(?=@)/, "");
      const match = (metadata?.participants || []).find((part) => {
        const pid = (part?.id || "").replace(/:\d+(?=@)/, "");
        const pjid = (part?.jid || "").replace(/:\d+(?=@)/, "");
        const plid = (part?.lid || "").replace(/:\d+(?=@)/, "");
        return pid === target || pjid === target || plid === target;
      });
      if (match) {
        if (match.id) enriched.push(match.id.replace(/:\d+(?=@)/, ""));
        if (match.jid) enriched.push(match.jid.replace(/:\d+(?=@)/, ""));
        if (match.lid) enriched.push(match.lid.replace(/:\d+(?=@)/, ""));
      }
    }
    return [...new Set(enriched.filter(Boolean))];
  } catch {
    return baseMentions;
  }
}

async function checkAndRunFlashback(sock, targetJid) {
  if (!sock || !targetJid?.endsWith("@g.us")) return false;
  try {
    const isDue = await birthday.checkFlashbackDue(targetJid);
    if (!isDue) return false;

    const memory = await repository.getRandomMemoryPhoto(targetJid);
    if (!memory) return false;

    const formatted = formatter.formatFlashback(memory);
    if (memory.cloudinary_url) {
      await sock.sendMessage(targetJid, { image: { url: memory.cloudinary_url }, caption: formatted.text });
    } else {
      await sock.sendMessage(targetJid, formatted);
    }
    await birthday.advanceFlashbackSchedule(targetJid);
    logger?.info({ targetJid }, "[Birthday] Delivered memory flashback");
    return true;
  } catch (err) {
    logger?.warn({ err, targetJid }, "[Birthday] Flashback check failed");
    return false;
  }
}

async function runEventForGroup(event, targetJid, personsOverride) {
  if (!event || !targetJid) return false;
  const config = getConfig();
  if (config.BIRTHDAY_TARGET_JID && targetJid !== config.BIRTHDAY_TARGET_JID) {
    logger?.info({ event, targetJid, allowed: config.BIRTHDAY_TARGET_JID }, "[Birthday] Skipping group - does not match BIRTHDAY_TARGET_JID");
    return false;
  }
  try {
    await birthday.evaluateAndActivate(targetJid);
    const active = await birthday.isTakeoverActive(targetJid);

    // If takeover is not active and event is 21:00 recap, evaluate memory flashback
    if (!active) {
      if (event === "grand_recap" || event === "recap") {
        const sock = getBirthdaySock ? getBirthdaySock() : getBotSock();
        if (sock) await checkAndRunFlashback(sock, targetJid);
      }
      return true;
    }

    if (await birthday.hasSentEvent(targetJid, event)) {
      if (event === "roast_session") {
        const meta = await birthday.getTakeoverMetadata(targetJid);
        if (meta.roastSessionMessageId) return true;
      } else {
        return true;
      }
    }

    const persons = personsOverride || await birthday.getTakeoverBirthdayPersons(targetJid);
    if (!persons.length) return true;
    const sock = getBirthdaySock ? getBirthdaySock() : getBotSock();
    if (!sock) {
      logger?.warn({ event, targetJid }, "[Birthday] Neither bot nor personal session available — skipping event");
      return false;
    }

    const groupMentions = await resolveMentionsForGroup(sock, targetJid, persons);
    const today = birthday.getWIBToday();
    let sentMessage = null;

    // --- 07:00 Slot: Opening + Birthday Quest ---
    if (event === "opening_quest" || event === "opening") {
      let lastYearPredictions = [];
      try {
        if (persons[0]?.participantId) {
          lastYearPredictions = await repository.getLastYearPredictions(targetJid, persons[0].participantId, today.year);
        }
      } catch {}
      const quest = formatter.pickQuest(persons[0]?.name);
      const msg = formatter.formatOpeningQuest(persons, quest, lastYearPredictions);
      msg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, msg);
      const sticker = assetBuffer("BIRTHDAY_STICKER_PATH");
      if (sticker) await sock.sendMessage(targetJid, { sticker });
      if (sentMessage?.key?.id) {
        await birthday.updateTakeoverMetadata(targetJid, { questMessageId: sentMessage.key.id, quest });
      }

    // --- 09:00 Slot: Lagu Ulang Tahun ---
    } else if (event === "song") {
      if (!await birthday.hasSentEvent(targetJid, "opening_quest") && !await birthday.hasSentEvent(targetJid, "opening")) {
        const quest = formatter.pickQuest(persons[0]?.name);
        const openingMsg = formatter.formatOpeningQuest(persons, quest, []);
        openingMsg.mentions = groupMentions;
        await sock.sendMessage(targetJid, openingMsg);
        const sticker = assetBuffer("BIRTHDAY_STICKER_PATH");
        if (sticker) await sock.sendMessage(targetJid, { sticker });
        await birthday.addSentEvent(targetJid, "opening_quest");
      }
      const audio = assetBuffer("BIRTHDAY_AUDIO_PATH");
      if (audio) {
        await sock.sendMessage(targetJid, { audio, mimetype: "audio/mpeg", ptt: false });
      }
      const songMsg = formatter.formatSong(persons);
      songMsg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, songMsg);

    // --- 12:00 Slot: Memory Wall ---
    } else if (event === "memory_wall") {
      const msg = formatter.formatMemoryWall(persons);
      msg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, msg);
      if (sentMessage?.key?.id) {
        await birthday.updateTakeoverMetadata(targetJid, { memoryWallMessageId: sentMessage.key.id });
      }

    // --- 14:00 Slot: Truth Questions ---
    } else if (event === "truth_questions") {
      const msg = formatter.formatTruthOpening(persons);
      msg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, msg);
      if (sentMessage?.key?.id) {
        await birthday.updateTakeoverMetadata(targetJid, { truthSessionMessageId: sentMessage.key.id });
      }

    // --- 15:00 Slot: Satu Foto Satu Cerita ---
    } else if (event === "photo_story") {
      const msg = formatter.formatPhotoStoryPrompt(persons);
      msg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, msg);
      if (sentMessage?.key?.id) {
        await birthday.updateTakeoverMetadata(targetJid, { photoStoryMessageId: sentMessage.key.id });
      }

    // --- 16:30 Slot: Roast Session ---
    } else if (event === "roast_session") {
      const msg = formatter.formatRoastPrompt(persons);
      msg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, msg);
      if (sentMessage?.key?.id) {
        await birthday.updateTakeoverMetadata(targetJid, { roastSessionMessageId: sentMessage.key.id });
      }

    // --- 17:00 Slot: Dual DM Outreach ---
    } else if (event === "dm_outreach") {
      let nonBirthdayMembers = [];
      try {
        const meta = await sock.groupMetadata(targetJid);
        const bIds = new Set(persons.map((p) => birthday.bareJid(p.participantId)));
        const botId = birthday.bareJid(sock.user?.id);
        nonBirthdayMembers = (meta?.participants || []).filter((p) => {
          const pid = birthday.bareJid(p.id || p.jid);
          return !bIds.has(pid) && pid !== botId;
        });
      } catch {}

      // 1. Initiate DM sessions & attempt direct send
      const dmPrompt = formatter.formatDmPrompt(persons);
      for (const p of nonBirthdayMembers) {
        const pid = birthday.bareJid(p.id || p.jid);
        const sess = birthday.startDmSession(pid, {
          groupJid: targetJid,
          participantName: p.notify || p.name || pid.split("@")[0],
          birthdayPersons: persons,
        });
        try {
          await sock.sendMessage(pid, dmPrompt);
          sess.promptSent = true;
        } catch {
          // Direct DM error caught cleanly, user will trigger via group notice
        }
      }

      // 2. Announce in group with mentions
      const memberObjs = nonBirthdayMembers.map((m) => ({
        participantId: birthday.bareJid(m.id || m.jid),
        name: m.notify || m.name || m.id?.split("@")[0] || "Teman",
      }));
      const notice = formatter.formatDmGroupNotice(memberObjs);
      notice.mentions = memberObjs.map((m) => m.participantId);
      sentMessage = await sock.sendMessage(targetJid, notice);

    // --- 18:00 Slot: Confess Reveal ---
    } else if (event === "confess_reveal") {
      const meta = await birthday.getTakeoverMetadata(targetJid);
      const confessions = Array.isArray(meta.confessions) ? meta.confessions : [];
      const msg = formatter.formatConfessReveal(persons, confessions);
      msg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, msg);

    // --- 18:30 Slot: Hot Take Night ---
    } else if (event === "hot_take") {
      const msg = formatter.formatHotTakePrompt(persons);
      msg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, msg);
      if (sentMessage?.key?.id) {
        await birthday.updateTakeoverMetadata(targetJid, { hotTakeMessageId: sentMessage.key.id });
      }

    // --- 19:00 Slot: Satu Hal yang Belum Pernah Diucapkan ---
    } else if (event === "unsaid_thing") {
      const msg = formatter.formatUnsaidThingPrompt(persons);
      msg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, msg);
      if (sentMessage?.key?.id) {
        await birthday.updateTakeoverMetadata(targetJid, { unsaidThingMessageId: sentMessage.key.id });
      }

    // --- 19:15 Slot: Kalau Kamu Jadi... (Skenario Absurd) ---
    } else if (event === "what_if") {
      const config = getConfig();
      const scenarios = config.WHAT_IF_SCENARIOS || [
        "presiden Republik Indonesia mendadak",
        "chef bintang lima yang masakannya di luar nalar",
        "astronot pertama yang nyasar di luar angkasa",
        "host reality show cari jodoh paling dramatis",
      ];
      const scenario = scenarios[Math.floor(Math.random() * scenarios.length)];
      const msg = formatter.formatWhatIfPrompt(persons, scenario);
      msg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, msg);
      if (sentMessage?.key?.id) {
        await birthday.updateTakeoverMetadata(targetJid, { whatIfMessageId: sentMessage.key.id, whatIfScenario: scenario });
      }

    // --- 20:00 Slot: Wish Jar ---
    } else if (event === "wish_jar") {
      const msg = formatter.formatWishJarPrompt(persons);
      msg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, msg);
      if (sentMessage?.key?.id) {
        await birthday.setWishMessageId(targetJid, sentMessage.key.id);
        await birthday.updateTakeoverMetadata(targetJid, { wishJarMessageId: sentMessage.key.id });
      }

    // --- 20:30 Slot: Verdict: Siapa Kamu Sebenarnya? ---
    } else if (event === "ai_verdict") {
      const meta = await birthday.getTakeoverMetadata(targetJid);
      const verdictText = await birthdayAi.generateAiVerdict({
        targetName: persons[0]?.name || "Teman",
        truthQuestions: meta.truthData?.questions || [],
        hotTakes: meta.hotTakes || [],
        memories: (meta.memoryWall || []).map((m) => m.text),
        confessions: (meta.confessions || []).map((c) => c.text),
        unsaidThings: meta.unsaidThings || [],
        logger,
      });

      sentMessage = await sendMultiBubble(sock, targetJid, verdictText, groupMentions);

    // --- 21:00 Slot: Grand Recap ---
    } else if (event === "grand_recap" || event === "recap") {
      const wishMessageId = await birthday.getWishMessageId(targetJid);
      const wishes = wishMessageId ? await birthday.getWishes(targetJid, wishMessageId) : [];
      const meta = await birthday.getTakeoverMetadata(targetJid);

      const recapData = {
        persons,
        wishes: [...wishes, ...(meta.wishJar || [])],
        memories: meta.memoryWall || [],
        roast: meta.roasts || [],
        truthHighlights: (meta.truthData?.questions || []).map((q) => ({
          askerName: q.askerName,
          targetName: q.targetName,
          question: q.question,
          answer: q.answer,
          isHonest: q.isHonest,
        })),
        hotTakes: meta.hotTakes || [],
        unsaidThings: meta.unsaidThings || [],
        whatIfScenario: meta.whatIfScenario || "",
        whatIfAnswers: meta.whatIfAnswers || [],
        photoStories: meta.photoStories || [],
        predictions: meta.predictions || [],
      };
      const msg = formatter.formatGrandRecap(recapData);
      msg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, msg);

    // --- 23:00 Slot: Closing + Quest Verdict ---
    } else if (event === "closing_quest" || event === "closing") {
      const meta = await birthday.getTakeoverMetadata(targetJid);
      const quest = meta.quest;
      const completed = Boolean(meta.questReply);
      const penalty = formatter.pickPenalty();
      const msg = formatter.formatClosingQuest(persons, quest, completed, penalty);
      msg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, msg);

      for (const person of persons) {
        await birthday.markCelebrated(targetJid, person.participantId, today.year);
      }

    // --- 23:30 Slot: Rate The Day ---
    } else if (event === "rate_the_day") {
      const msg = formatter.formatRateTheDayPrompt(persons);
      msg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, msg);
      if (sentMessage?.key?.id) {
        await birthday.updateTakeoverMetadata(targetJid, {
          rateTheDayMessageId: sentMessage.key.id,
          rateTheDaySentAt: Date.now(),
        });
      }

    // --- 00:00 Slot: Midnight Letter ---
    } else if (event === "midnight_letter") {
      const chatLog = birthday.getGroupChatLog(targetJid);
      const meta = await birthday.getTakeoverMetadata(targetJid);
      const chatSummary = await birthdayAi.summarizeDayChat({
        chatMessages: [{ text: chatLog }],
        targetName: persons[0]?.name,
        logger,
      });

      const letterText = await birthdayAi.generateMidnightLetter({
        targetName: persons[0]?.name,
        chatSummary,
        memories: (meta.memoryWall || []).map((m) => m.text),
        photoStories: meta.photoStories || [],
        roast: (meta.roasts || []).map((r) => r.text),
        hotTakes: meta.hotTakes || [],
        unsaidThings: meta.unsaidThings || [],
        confessions: (meta.confessions || []).map((c) => c.text),
        whatIfAnswers: meta.whatIfAnswers || [],
        whatIfScenario: meta.whatIfScenario || "",
        wishJar: (meta.wishJar || []).map((w) => w.text),
        predictions: (meta.predictions || []).map((p) => `${p.senderName}: ${p.predictionText}`),
        rateTheDay: meta.rateTheDay || null,
        logger,
      });

      sentMessage = await sendMultiBubble(sock, targetJid, letterText, groupMentions);

    // --- 02:00 Slot: Surat Dini Hari (Omniscient Narrator) ---
    } else if (event === "narrator_letter") {
      const chatLog = birthday.getGroupChatLog(targetJid);
      const meta = await birthday.getTakeoverMetadata(targetJid);
      const chatSummary = await birthdayAi.summarizeDayChat({
        chatMessages: [{ text: chatLog }],
        targetName: persons[0]?.name,
        logger,
      });

      const narratorText = await birthdayAi.generateNarratorLetter({
        targetName: persons[0]?.name,
        memories: (meta.memoryWall || []).map((m) => m.text),
        photoStories: meta.photoStories || [],
        wishJar: (meta.wishJar || []).map((w) => w.text),
        predictions: (meta.predictions || []).map((p) => `${p.senderName}: ${p.predictionText}`),
        chatSummary,
        logger,
      });

      sentMessage = await sendMultiBubble(sock, targetJid, narratorText, groupMentions);
      await birthday.deactivateTakeover(targetJid);
      birthday.clearGroupChatLog(targetJid);

    // Legacy fallback slots
    } else if (event === "card") {
      const card = assetBuffer("BIRTHDAY_CARD_PATH");
      const message = formatter.formatCard(persons);
      sentMessage = card
        ? await sock.sendMessage(targetJid, { image: card, caption: message.text, mentions: groupMentions })
        : await sock.sendMessage(targetJid, { text: message.text, mentions: groupMentions });
      if (sentMessage?.key?.id) await birthday.setWishMessageId(targetJid, sentMessage.key.id);
    } else if (event === "spotlight") {
      const msg = formatter.formatSpotlight(persons);
      msg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, msg);
    } else if (event === "reminder") {
      const msg = formatter.formatReminder(persons);
      msg.mentions = groupMentions;
      sentMessage = await sock.sendMessage(targetJid, msg);
    }

    await birthday.addSentEvent(targetJid, event);
    logger?.info({ event, targetJid }, "[Birthday] Event delivered");
    return true;
  } catch (error) {
    logger?.error({ err: error, event, targetJid }, "[Birthday] Event failed for group");
    return false;
  }
}

async function runEvent(eventOrSlot, personsOverride) {
  const event = typeof eventOrSlot === "string" ? eventOrSlot : eventOrSlot?.id;
  if (!event) return false;
  if (runningEvents.has(event)) return false;
  runningEvents.add(event);

  try {
    const targetGroups = await getTargetGroups();
    for (const targetJid of targetGroups) {
      await runEventForGroup(event, targetJid, personsOverride);
    }
    return true;
  } finally {
    runningEvents.delete(event);
  }
}

function start({ logger: log, groupJid: jid } = {}) {
  if (scheduler?.getState().running) return false;
  const config = getConfig();
  if (!config.BIRTHDAY_FEATURE_ENABLED || !config.BIRTHDAY_TAKEOVER_ENABLED) {
    log?.info("[Birthday] Feature disabled; scheduler not started");
    return false;
  }
  logger = log;
  groupJid = jid || config.BIRTHDAY_TARGET_JID || process.env.GROUP_JID || "";
  if (!groupJid) {
    logger?.warn("[Birthday] No GROUP_JID or BIRTHDAY_TARGET_JID; scheduler not started");
    return false;
  }
  scheduler = createWindowedScheduler({
    name: "Birthday Scheduler",
    slots: EVENT_SCHEDULES,
    task: (slot) => runEvent(slot.id),
    logger,
    allow24Hours: true,
  });
  scheduler.start();
  logger?.info({ slots: EVENT_SCHEDULES.map((slot) => slot.time) }, "[Birthday] Scheduler started");
  return true;
}

function stop() {
  scheduler?.stop();
  scheduler = null;
  runningEvents.clear();
  logger?.info("[Birthday] Scheduler stopped");
}

function resume() {
  return scheduler?.resume() || Promise.resolve(false);
}

function isRunning() {
  return Boolean(scheduler?.getState().running);
}

module.exports = {
  EVENT_SCHEDULES,
  start,
  stop,
  resume,
  isRunning,
  runEvent,
  runEventForGroup,
  getTargetGroups,
  sendMultiBubble,
};
