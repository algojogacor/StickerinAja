const birthday = require("../services/birthdayService");

const CANONICAL = {
  ultah: "birthday",
  birthday: "birthday",
};

function bareJid(value) {
  return String(value || "").trim().replace(/:\d+(?=@)/, "");
}

function isValidUserJid(value) {
  const bare = bareJid(value);
  return bare.endsWith("@s.whatsapp.net") || bare.endsWith("@lid");
}

function senderId(msg) {
  return bareJid(msg?.key?.participant || msg?.key?.remoteJid);
}

function findParticipant(participants, jidOrLid) {
  if (!Array.isArray(participants) || !jidOrLid) return null;
  const target = bareJid(jidOrLid);
  return participants.find((p) => {
    return bareJid(p?.id) === target || bareJid(p?.lid) === target || bareJid(p?.jid) === target;
  }) || null;
}

async function isPrivileged(sock, msg, remoteJid) {
  const owner = bareJid(process.env.OWNER_JID || "");
  const sender = senderId(msg);
  if (msg?.key?.fromMe || (owner && sender === owner)) return true;
  if (!remoteJid?.endsWith("@g.us") || typeof sock?.groupMetadata !== "function") return false;
  try {
    const metadata = await sock.groupMetadata(remoteJid);
    const participant = findParticipant(metadata?.participants, sender);
    if (!participant) return false;
    if (owner && (bareJid(participant.id) === owner || bareJid(participant.jid) === owner || bareJid(participant.lid) === owner)) {
      return true;
    }
    return Boolean(participant?.admin === "admin" || participant?.admin === "superadmin");
  } catch {
    return false;
  }
}

function mentionedIds(msg) {
  const context = msg?.message?.extendedTextMessage?.contextInfo;
  const ids = Array.isArray(context?.mentionedJid) ? context.mentionedJid : [];
  const quoted = context?.participant;
  return [...new Set([...ids, quoted].map(bareJid).filter(isValidUserJid))];
}

function parseDate(value) {
  const match = /^(\d{1,2})[-\/.](\d{1,2})(?:[-\/.](\d{4}))?$/.exec(String(value || ""));
  if (!match) throw new Error("Format tanggal: DD-MM atau DD-MM-YYYY");
  return { day: Number(match[1]), month: Number(match[2]), year: match[3] ? Number(match[3]) : null };
}

function displayDate(row) {
  return `${String(row.birthDay).padStart(2, "0")}-${String(row.birthMonth).padStart(2, "0")}`;
}

function targetFromMessage(msg) {
  const fromMentions = mentionedIds(msg)[0];
  if (fromMentions) return fromMentions;
  const quoted = msg?.message?.extendedTextMessage?.contextInfo?.participant;
  if (quoted && isValidUserJid(quoted)) return bareJid(quoted);
  return null;
}

async function resolveTarget(sock, remoteJid, rawTarget) {
  const target = bareJid(rawTarget);
  if (!target) return { jid: null, participant: null };
  if (!remoteJid?.endsWith("@g.us") || typeof sock?.groupMetadata !== "function") {
    return { jid: target, participant: null };
  }
  try {
    const metadata = await sock.groupMetadata(remoteJid);
    const participant = findParticipant(metadata?.participants, target);
    const resolvedJid = participant?.jid ? bareJid(participant.jid) : target;
    return { jid: resolvedJid, participant };
  } catch {
    return { jid: target, participant: null };
  }
}

function extractCustomName(args, dateArg, participant) {
  const remaining = args.slice(1).filter((arg) => arg !== dateArg);
  if (!remaining.length) return participant?.notify || participant?.name || undefined;

  const atIndex = remaining.findIndex((arg) => arg.startsWith("@"));
  if (atIndex !== -1) {
    const knownName = String(participant?.notify || participant?.name || "").trim().toLowerCase();
    const knownWords = knownName ? knownName.split(/\s+/) : [];

    let wordsToSkip = 1;
    if (knownWords.length > 1) {
      for (let i = 1; i < knownWords.length; i++) {
        const nextArg = remaining[atIndex + i]?.toLowerCase();
        if (nextArg && nextArg === knownWords[i]) {
          wordsToSkip++;
        } else {
          break;
        }
      }
    }

    const customWords = [
      ...remaining.slice(0, atIndex),
      ...remaining.slice(atIndex + wordsToSkip),
    ];
    const customName = customWords.join(" ").trim();
    return customName || participant?.notify || participant?.name || undefined;
  }

  const customName = remaining.join(" ").trim();
  return customName || participant?.notify || participant?.name || undefined;
}

function usage(PREFIX) {
  return `🎂 *Birthday Takeover*\n\n${PREFIX}ultah tambah DD-MM [@mention] [nama]\n${PREFIX}ultah ubah DD-MM [@mention] [nama]\n${PREFIX}ultah hapus [@mention]\n${PREFIX}ultah list\n${PREFIX}ultah hariini | besok\n${PREFIX}ultah mode on|off|status`;
}

async function reply(sock, remoteJid, msg, text, mentions) {
  return sock.sendMessage(remoteJid, { text, ...(mentions?.length ? { mentions } : {}) }, { quoted: msg });
}

module.exports = {
  names: Object.keys(CANONICAL),
  bareJid,
  isValidUserJid,
  findParticipant,
  isPrivileged,
  mentionedIds,
  targetFromMessage,
  resolveTarget,
  extractCustomName,

  async execute({ sock, msg, args, cmdName, remoteJid, logger, PREFIX }) {
    if (!remoteJid?.endsWith("@g.us")) {
      await reply(sock, remoteJid, msg, "⚠️ Birthday Takeover hanya tersedia di grup.");
      return;
    }

    const sub = (args[0] || "help").toLowerCase();
    const privileged = await isPrivileged(sock, msg, remoteJid);
    const rawTarget = targetFromMessage(msg);
    const { jid: target, participant } = await resolveTarget(sock, remoteJid, rawTarget);
    const dateArg = args.slice(1).find((arg) => /^(\d{1,2})[-\/.](\d{1,2})(?:[-\/.]\d{4})?$/.test(arg));

    if (["list", "daftar"].includes(sub)) {
      const rows = await birthday.getBirthdaysList(remoteJid);
      await reply(sock, remoteJid, msg, rows.length
        ? `🎂 *Daftar ulang tahun*\n\n${rows.map((row) => `• ${row.name} — ${displayDate(row)}`).join("\n")}`
        : "🎂 Belum ada data ulang tahun di grup ini.");
      return;
    }

    if (["hariini", "today"].includes(sub)) {
      const rows = await birthday.getTodayBirthdays(remoteJid);
      await reply(sock, remoteJid, msg, rows.length
        ? `🎉 Hari ini ulang tahun: ${rows.map((row) => row.name).join(", ")}`
        : "🎂 Hari ini tidak ada data ulang tahun.");
      return;
    }

    if (["besok", "tomorrow", "berikutnya", "next"].includes(sub)) {
      const rows = await birthday.getTomorrowBirthdays(remoteJid);
      await reply(sock, remoteJid, msg, rows.length
        ? `📅 Besok ulang tahun: ${rows.map((row) => row.name).join(", ")}`
        : "🎂 Besok tidak ada data ulang tahun.");
      return;
    }

    if (sub === "mode") {
      const action = (args[1] || "status").toLowerCase();
      if (action === "status") {
        await reply(sock, remoteJid, msg, `Birthday Takeover: ${await birthday.isTakeoverActive(remoteJid) ? "aktif" : "nonaktif"}.`);
        return;
      }
      if (!privileged) {
        await reply(sock, remoteJid, msg, "⚠️ Command ini hanya untuk admin/owner.");
        return;
      }
      if (action === "on") {
        const rows = await birthday.getTodayBirthdays(remoteJid);
        if (!rows.length) { await reply(sock, remoteJid, msg, "🎂 Tidak ada ulang tahun hari ini."); return; }
        await birthday.activateTakeover(remoteJid, rows);
        await reply(sock, remoteJid, msg, "✅ Birthday Takeover diaktifkan untuk hari ini.");
      } else if (action === "off") {
        await birthday.deactivateTakeover(remoteJid);
        await reply(sock, remoteJid, msg, "✅ Birthday Takeover dimatikan untuk hari ini.");
      } else await reply(sock, remoteJid, msg, "Gunakan mode on, off, atau status.");
      return;
    }

    if (!["tambah", "add", "ubah", "edit", "hapus", "delete", "remove"].includes(sub)) {
      await reply(sock, remoteJid, msg, usage(PREFIX));
      return;
    }
    if (!privileged) { await reply(sock, remoteJid, msg, "⚠️ Tambah/ubah/hapus hanya untuk admin/owner."); return; }
    if (!target) { await reply(sock, remoteJid, msg, "⚠️ Mention anggota yang dimaksud atau reply pesannya."); return; }

    if (["hapus", "delete", "remove"].includes(sub)) {
      await birthday.removeBirthday(remoteJid, target);
      await reply(sock, remoteJid, msg, "✅ Data ulang tahun dihapus.");
      return;
    }

    if (!dateArg) { await reply(sock, remoteJid, msg, usage(PREFIX)); return; }
    const date = parseDate(dateArg);
    const name = extractCustomName(args, dateArg, participant);
    if (sub === "tambah" || sub === "add") {
      await birthday.addBirthday(remoteJid, target, name, date.day, date.month, date.year, senderId(msg));
      await reply(sock, remoteJid, msg, `✅ Ulang tahun ${name || "anggota"} disimpan pada ${String(date.day).padStart(2, "0")}-${String(date.month).padStart(2, "0")}.`, [target]);
    } else {
      await birthday.updateBirthday(remoteJid, target, { name, birthDay: date.day, birthMonth: date.month, birthYear: date.year ?? undefined });
      await reply(sock, remoteJid, msg, "✅ Data ulang tahun diperbarui.", [target]);
    }
    logger?.info({ command: CANONICAL[cmdName], group: remoteJid }, "[Birthday] command completed");
  },
};
