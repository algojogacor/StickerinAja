const birthday = require("./birthdayService");
const repository = require("../repositories/birthdayRepository");
const formatter = require("../formatters/birthdayMessageFormatter");
const birthdayAi = require("./birthdayAiService");
const cloudinaryService = require("./cloudinaryService");

async function handleIncomingDm(sock, msg, messageText, logger) {
  const remoteJid = msg.key?.remoteJid;
  if (!remoteJid || remoteJid.endsWith("@g.us") || msg.key?.fromMe) return false;

  const senderJid = birthday.bareJid(remoteJid);
  const session = birthday.getDmSession(senderJid);
  if (!session) return false;

  try {
    if (!session.promptSent) {
      const prompt = formatter.formatDmPrompt(session.birthdayPersons);
      await sock.sendMessage(remoteJid, prompt);
      session.promptSent = true;
      return true;
    }

    if (!session.completed) {
      await birthday.recordDmAnswer(senderJid, messageText);
      await sock.sendMessage(remoteJid, {
        text: "✅ Terima kasih banyak! Confess kamu akan disampaikan secara 100% anonim di grup jam 18:00 WIB, dan prediksimu sudah dicatat untuk dibacakan malam nanti! ✨",
      });
      return true;
    }
  } catch (err) {
    logger?.error({ err, senderJid }, "[Birthday] Error handling incoming DM");
  }

  return false;
}

async function handleInteractiveGroupMessage(sock, msg, messageText, quotedStanza, quotedMsg, logger) {
  const remoteJid = msg.key?.remoteJid;
  if (!remoteJid?.endsWith("@g.us") || msg.key?.fromMe) return false;

  const active = await birthday.isTakeoverActive(remoteJid);
  if (!active) return false;

  const senderJid = birthday.bareJid(msg.key?.participant || remoteJid);
  const senderName = msg.pushName || "Warga";

  // Always log group messages during active takeover (07:00 - 23:00)
  birthday.recordGroupChatMessage(remoteJid, senderName, messageText, new Date());

  if (!quotedStanza) return false;

  const meta = await birthday.getTakeoverMetadata(remoteJid);
  const persons = await birthday.getTakeoverBirthdayPersons(remoteJid);
  const birthdayPerson = persons[0] || { participantId: "", name: "Teman" };

  try {
    // 1. Truth Questions: reply to truth opening message
    if (meta.truthSessionMessageId && quotedStanza === meta.truthSessionMessageId) {
      const isBirthdayPerson = persons.some((p) => birthday.bareJid(p.participantId) === senderJid);
      let target = birthdayPerson;
      if (isBirthdayPerson) {
        const context = msg.message?.extendedTextMessage?.contextInfo;
        const mentioned = (context?.mentionedJid || [])[0];
        if (mentioned) {
          target = { participantId: birthday.bareJid(mentioned), name: "Teman" };
        }
      }

      const res = await birthday.recordTruthQuestion(remoteJid, senderJid, senderName, target.participantId, target.name, messageText, msg.key.id);
      if (res?.error === "quota_exceeded") {
        await sock.sendMessage(remoteJid, { text: "⚠️ Jatah 3 pertanyaan Truth kamu sudah habis!" }, { quoted: msg });
      } else {
        await sock.sendMessage(remoteJid, { react: { text: "❓", key: msg.key } }).catch(() => {});
      }
      return true;
    }

    // Check if replying to a truth question
    const truthQuestions = meta.truthData?.questions || [];
    const isTruthAnswer = truthQuestions.some((q) => q.id === quotedStanza);
    if (isTruthAnswer) {
      const ansRes = await birthday.recordTruthAnswer(remoteJid, senderJid, messageText, quotedStanza);
      if (ansRes?.success) {
        const emoji = ansRes.isHonest ? "🤞" : "💬";
        await sock.sendMessage(remoteJid, { react: { text: emoji, key: msg.key } }).catch(() => {});
      }
      return true;
    }

    // 2. Birthday Quest Reply
    if (meta.questMessageId && quotedStanza === meta.questMessageId) {
      await birthday.recordQuestReply(remoteJid, senderJid, messageText);
      await sock.sendMessage(remoteJid, { react: { text: "🎯", key: msg.key } }).catch(() => {});
      return true;
    }

    // 3. Memory Wall
    if (meta.memoryWallMessageId && quotedStanza === meta.memoryWallMessageId) {
      await birthday.recordMemoryWallItem(remoteJid, senderJid, senderName, messageText);
      await sock.sendMessage(remoteJid, { react: { text: "❤️", key: msg.key } }).catch(() => {});
      return true;
    }

    // 4. Photo Story
    if (meta.photoStoryMessageId && quotedStanza === meta.photoStoryMessageId) {
      let imageBuffer = null;
      try {
        const { downloadMediaMessage } = require("@whiskeysockets/baileys");
        if (msg.message?.imageMessage) {
          imageBuffer = await downloadMediaMessage(msg, "buffer", {}, { logger: console });
        } else if (quotedMsg?.imageMessage) {
          imageBuffer = await downloadMediaMessage({ key: { id: quotedStanza, remoteJid, fromMe: false, participant: senderJid }, message: quotedMsg }, "buffer", {}, { logger: console });
        }
      } catch (err) {
        logger?.warn({ err }, "[Birthday] Failed to download photo story image");
      }

      let aiStory = "";
      let photoUrl = "";
      if (imageBuffer) {
        try {
          const uploadRes = await cloudinaryService.uploadImage(imageBuffer, "birthday_stories");
          if (uploadRes.success) photoUrl = uploadRes.url;
        } catch {}

        try {
          aiStory = await birthdayAi.describeMemoryPhoto({
            imageBuffer,
            senderName,
            caption: messageText,
            logger,
          });
        } catch {}

        if (photoUrl) {
          await repository.addMemoryPhoto({
            groupJid: remoteJid,
            cloudinaryUrl: photoUrl,
            senderId: senderJid,
            senderName,
            caption: messageText,
            aiDescription: aiStory,
            sourceType: "birthday_story",
          });
        }
      }

      await birthday.recordPhotoStory(remoteJid, {
        senderId: senderJid,
        senderName,
        caption: messageText,
        photoUrl,
        aiStory,
        timestamp: Date.now(),
      });

      if (aiStory) {
        await sock.sendMessage(remoteJid, { text: `📸 *Satu Foto Satu Cerita*\n\n${aiStory}` }, { quoted: msg });
      } else {
        await sock.sendMessage(remoteJid, { react: { text: "📸", key: msg.key } }).catch(() => {});
      }
      return true;
    }

    // 5. Roast Session
    if (meta.roastSessionMessageId && quotedStanza === meta.roastSessionMessageId) {
      await birthday.recordRoast(remoteJid, senderJid, senderName, messageText);
      await sock.sendMessage(remoteJid, { react: { text: "🔥", key: msg.key } }).catch(() => {});
      return true;
    }

    // 6. Wish Jar
    if (meta.wishJarMessageId && quotedStanza === meta.wishJarMessageId) {
      await birthday.recordWishJarItem(remoteJid, senderJid, senderName, messageText);
      await birthday.recordWishFromMessage(msg);
      await sock.sendMessage(remoteJid, { react: { text: "🌟", key: msg.key } }).catch(() => {});
      return true;
    }

    // Legacy card wish fallback
    if ((await birthday.getWishMessageId(remoteJid)) === quotedStanza) {
      await birthday.recordWishFromMessage(msg);
      await sock.sendMessage(remoteJid, { react: { text: "🎂", key: msg.key } }).catch(() => {});
      return true;
    }
  } catch (err) {
    logger?.error({ err, remoteJid }, "[Birthday] Error handling interactive group message");
  }

  return false;
}

module.exports = {
  shouldSuppressCron: birthday.shouldSuppressCron,
  recordWishFromMessage: birthday.recordWishFromMessage,
  handleIncomingDm,
  handleInteractiveGroupMessage,
};
