const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const repository = require("../repositories/birthdayRepository");
const cloudinaryService = require("../services/cloudinaryService");
const birthdayAi = require("../services/birthdayAiService");

const CANONICAL = {
  kenangan: "kenangan",
  memory: "kenangan",
  memori: "kenangan",
};

function bareJid(value) {
  return String(value || "").trim().replace(/:\d+(?=@)/, "");
}

async function reply(sock, remoteJid, msg, text) {
  return sock.sendMessage(remoteJid, { text }, { quoted: msg });
}

module.exports = {
  names: Object.keys(CANONICAL),
  bareJid,

  async execute({ sock, msg, args, remoteJid, quotedMsg, quotedStanza, logger, PREFIX }) {
    if (!remoteJid?.endsWith("@g.us")) {
      await reply(sock, remoteJid, msg, "⚠️ Fitur Kenangan hanya tersedia di grup.");
      return;
    }

    const sub = (args[0] || "help").toLowerCase();
    const sender = bareJid(msg.key?.participant || remoteJid);
    const senderName = msg.pushName || "Teman";

    if (sub === "list" || sub === "daftar") {
      const memories = await repository.getMemoriesForGroup(remoteJid);
      if (!memories.length) {
        await reply(sock, remoteJid, msg, "📸 Belum ada foto kenangan yang tersimpan untuk grup ini.");
        return;
      }

      const listText = memories
        .slice(0, 15)
        .map((m, idx) => {
          const dateStr = m.created_at ? new Date(m.created_at).toLocaleDateString("id-ID") : "-";
          return `${idx + 1}. *[${dateStr}]* ${m.sender_name || "Teman"}: "${m.caption || "Tanpa caption"}"\n   🔗 ${m.cloudinary_url}`;
        })
        .join("\n\n");

      await reply(sock, remoteJid, msg, `📸 *Album Kenangan Grup (${memories.length} foto)*\n\n${listText}`);
      return;
    }

    if (sub === "tambah" || sub === "add" || sub === "simpan") {
      const caption = args.slice(1).join(" ").trim();
      let imageBuffer = null;

      try {
        if (msg.message?.imageMessage) {
          imageBuffer = await downloadMediaMessage(msg, "buffer", {}, { logger: console });
        } else if (quotedMsg?.imageMessage) {
          imageBuffer = await downloadMediaMessage(
            { key: { id: quotedStanza, remoteJid, fromMe: false, participant: sender }, message: quotedMsg },
            "buffer",
            {},
            { logger: console }
          );
        }
      } catch (err) {
        logger?.warn({ err }, "[Kenangan] Failed to download image");
      }

      if (!imageBuffer) {
        await reply(sock, remoteJid, msg, `⚠️ Kirim foto dengan caption *${PREFIX}kenangan tambah [cerita]* atau reply foto yang ada!`);
        return;
      }

      await reply(sock, remoteJid, msg, "⏳ Sedang mengunggah dan menganalisis foto kenangan...");

      let photoUrl = "";
      let publicId = "";
      try {
        const uploadRes = await cloudinaryService.uploadImage(imageBuffer, "group_memories");
        if (uploadRes.success) {
          photoUrl = uploadRes.url;
          publicId = uploadRes.publicId;
        }
      } catch (uploadErr) {
        logger?.warn({ err: uploadErr }, "[Kenangan] Cloudinary upload failed");
      }

      let aiStory = "";
      try {
        aiStory = await birthdayAi.describeMemoryPhoto({
          imageBuffer,
          senderName,
          caption,
          logger,
        });
      } catch (aiErr) {
        logger?.warn({ err: aiErr }, "[Kenangan] AI description failed");
      }

      const memoryRecord = await repository.addMemoryPhoto({
        groupJid: remoteJid,
        cloudinaryUrl: photoUrl || "https://res.cloudinary.com/placeholder",
        cloudinaryPublicId: publicId,
        senderId: sender,
        senderName,
        caption: caption || "Kenangan indah",
        aiDescription: aiStory || "Foto kenangan bersama warga grup.",
        sourceType: "manual_upload",
      });

      await reply(
        sock,
        remoteJid,
        msg,
        `✅ *Foto Kenangan Berhasil Disimpan!* (ID: #${memoryRecord.id})\n\n📝 "${caption || "Tanpa caption"}"\n\n✨ *Catatan:* ${aiStory || "Kenangan tersimpan rapi di album grup."}`
      );
      return;
    }

    await reply(
      sock,
      remoteJid,
      msg,
      `📸 *Fitur Kenangan Grup*\n\n` +
      `• *${PREFIX}kenangan tambah [cerita]* — Simpan foto (lampirkan atau reply foto)\n` +
      `• *${PREFIX}kenangan list* — Lihat daftar foto kenangan yang tersimpan`
    );
  },
};
