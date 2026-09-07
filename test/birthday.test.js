const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const birthdayRepository = require("../src/repositories/birthdayRepository");
const birthdayService = require("../src/services/birthdayService");
const birthdayFormatter = require("../src/formatters/birthdayMessageFormatter");
const birthdayConfig = require("../src/config/birthdayConfig");
const birthdayScheduler = require("../src/scheduler/birthdayScheduler");
const birthdayCommand = require("../src/commands/birthday");

beforeEach(async () => {
  await birthdayRepository.resetForTests();
});

describe("Birthday repository and service", () => {
  it("persists birthday records in the memory fallback", async () => {
    await birthdayRepository.init();
    await birthdayService.addBirthday(
      "120@g.us",
      "628123@s.whatsapp.net",
      "Rina",
      15,
      7,
      2000,
      "admin@s.whatsapp.net"
    );

    const rows = await birthdayService.getBirthdaysList("120@g.us");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "Rina");
    assert.equal(rows[0].birthDay, 15);
  });

  it("rejects invalid dates and non-group targets", async () => {
    await assert.rejects(
      birthdayService.addBirthday("private@s.whatsapp.net", "628123@s.whatsapp.net", "Rina", 31, 2),
      /group/i
    );
    await assert.rejects(
      birthdayService.addBirthday("120@g.us", "628123@s.whatsapp.net", "Rina", 31, 2),
      /date|tanggal/i
    );
  });

  it("activates a takeover once per group and date", async () => {
    await birthdayRepository.init();
    const persons = [{ participantId: "628123@s.whatsapp.net", name: "Rina" }];
    const first = await birthdayService.activateTakeover("120@g.us", persons);
    const second = await birthdayService.activateTakeover("120@g.us", persons);
    assert.equal(first.isActive, true);
    assert.equal(second.isActive, true);
    assert.equal(await birthdayService.isTakeoverActive("120@g.us"), true);
  });

  it("tracks event idempotency and wishes", async () => {
    await birthdayRepository.init();
    await birthdayService.activateTakeover("120@g.us", [{ participantId: "628123@s.whatsapp.net", name: "Rina" }]);
    assert.equal(await birthdayService.hasSentEvent("120@g.us", "opening"), false);
    await birthdayService.addSentEvent("120@g.us", "opening");
    assert.equal(await birthdayService.hasSentEvent("120@g.us", "opening"), true);
    await birthdayService.addWish({
      groupJid: "120@g.us",
      birthdayEventId: "open-1",
      senderId: "628555@s.whatsapp.net",
      senderName: "Budi",
      messageText: "Selamat ulang tahun!",
      messageId: "msg-1",
    });
    const wishes = await birthdayService.getWishes("120@g.us", "open-1");
    assert.equal(wishes.length, 1);
    assert.equal(wishes[0].messageText, "Selamat ulang tahun!");
  });

  it("persists, updates, and deletes birthday records for @lid participants", async () => {
    await birthdayRepository.init();
    await birthdayService.addBirthday(
      "120@g.us",
      "244203384742140:47@lid",
      "Wirtz",
      7,
      9,
      2001,
      "admin@s.whatsapp.net"
    );

    const rows = await birthdayService.getBirthdaysList("120@g.us");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "Wirtz");
    assert.equal(rows[0].participantId, "244203384742140@lid");

    await birthdayService.updateBirthday("120@g.us", "244203384742140@lid", { name: "Wirtz Updated" });
    const updated = await birthdayService.getBirthdaysList("120@g.us");
    assert.equal(updated[0].name, "Wirtz Updated");

    await birthdayService.removeBirthday("120@g.us", "244203384742140@lid");
    const afterDelete = await birthdayService.getBirthdaysList("120@g.us");
    assert.equal(afterDelete.length, 0);
  });

  it("finds all distinct groups that have birthdays on a specific date", async () => {
    await birthdayRepository.init();
    await birthdayService.addBirthday("group-1@g.us", "user1@s.whatsapp.net", "User 1", 7, 9);
    await birthdayService.addBirthday("group-2@g.us", "user2@s.whatsapp.net", "User 2", 7, 9);
    await birthdayService.addBirthday("group-3@g.us", "user3@s.whatsapp.net", "User 3", 8, 9);

    const groups = await birthdayRepository.getGroupsWithBirthdaysOn(7, 9);
    assert.equal(groups.length, 2);
    assert.ok(groups.includes("group-1@g.us"));
    assert.ok(groups.includes("group-2@g.us"));
    assert.ok(!groups.includes("group-3@g.us"));
  });
});

describe("Birthday formatting and configuration", () => {
  it("formats mentions with valid user ID tag and custom display name", () => {
    const result = birthdayFormatter.formatOpening([
      { participantId: "628123@s.whatsapp.net", name: "Rina" },
    ]);
    assert.ok(result.text.includes("@628123 (Rina)"));
    assert.deepEqual(result.mentions, ["628123@s.whatsapp.net"]);
    assert.equal(result.text.includes("@s.whatsapp.net"), false);
  });

  it("keeps the production event schedule aligned with the 13-slot timeline", () => {
    assert.equal(birthdayConfig.EVENT_SCHEDULES.length, 13);
    const times = birthdayConfig.EVENT_SCHEDULES.map((s) => s.time);
    assert.ok(times.includes("07:00"));
    assert.ok(times.includes("14:00"));
    assert.ok(times.includes("17:00"));
    assert.ok(times.includes("23:00"));
    assert.ok(times.includes("00:00"));
    assert.ok(times.includes("02:00"));
  });
});

describe("Birthday scheduler contract", () => {
  it("exports an absolute-slot scheduler lifecycle", () => {
    assert.equal(typeof birthdayScheduler.start, "function");
    assert.equal(typeof birthdayScheduler.stop, "function");
    assert.equal(typeof birthdayScheduler.resume, "function");
    assert.equal(typeof birthdayScheduler.runEvent, "function");
  });

  it("isolates delivery strictly to BIRTHDAY_TARGET_JID when configured", async () => {
    const originalTarget = process.env.BIRTHDAY_TARGET_JID;
    try {
      process.env.BIRTHDAY_TARGET_JID = "120363253471284606@g.us";
      const targets = await birthdayScheduler.getTargetGroups();
      assert.deepEqual(targets, ["120363253471284606@g.us"]);

      const result = await birthdayScheduler.runEventForGroup("opening", "other_group@g.us");
      assert.equal(result, false);
    } finally {
      if (originalTarget !== undefined) process.env.BIRTHDAY_TARGET_JID = originalTarget;
      else delete process.env.BIRTHDAY_TARGET_JID;
    }
  });
});

describe("Birthday command", () => {
  it("allows an owner/bot admin to add a mentioned member", async () => {
    const sent = [];
    const sock = {
      sendMessage: async (...args) => { sent.push(args); return { key: { id: "command-1" } }; },
    };
    await birthdayCommand.execute({
      sock,
      msg: {
        key: { remoteJid: "120@g.us", participant: "628999@s.whatsapp.net", fromMe: true, id: "m1" },
        message: {
          conversation: "!ultah tambah 15-07 @628123",
          extendedTextMessage: { contextInfo: { mentionedJid: ["628123@s.whatsapp.net"] } },
        },
      },
      args: ["tambah", "15-07", "@628123"],
      cmdName: "ultah",
      remoteJid: "120@g.us",
      PREFIX: "!",
      logger: { info() {} },
    });
    const rows = await birthdayService.getBirthdaysList("120@g.us");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].participantId, "628123@s.whatsapp.net");
    assert.equal(sent.length, 1);
  });

  it("allows adding a member using @lid mention", async () => {
    const sent = [];
    const sock = {
      sendMessage: async (...args) => { sent.push(args); return { key: { id: "cmd-lid-1" } }; },
      groupMetadata: async () => ({
        participants: [
          { id: "260227974823977@lid", lid: "260227974823977@lid", notify: "wirtz meatsucker icir" },
        ],
      }),
    };
    await birthdayCommand.execute({
      sock,
      msg: {
        key: { remoteJid: "120@g.us", participant: "628999@s.whatsapp.net", fromMe: true, id: "m2" },
        message: {
          conversation: "!ultah tambah 07-09 @wirtz meatsucker icir rtlkntl",
          extendedTextMessage: { contextInfo: { mentionedJid: ["260227974823977@lid"] } },
        },
      },
      args: ["tambah", "07-09", "@wirtz", "meatsucker", "icir", "rtlkntl"],
      cmdName: "ultah",
      remoteJid: "120@g.us",
      PREFIX: "!",
      logger: { info() {} },
    });
    const rows = await birthdayService.getBirthdaysList("120@g.us");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].participantId, "260227974823977@lid");
    assert.equal(rows[0].name, "rtlkntl");
    assert.equal(sent.length, 1);
    assert.ok(sent[0][1].text.includes("rtlkntl"));
  });

  it("allows adding a member by replying to their message with @lid participant", async () => {
    const sent = [];
    const sock = {
      sendMessage: async (...args) => { sent.push(args); return { key: { id: "cmd-lid-2" } }; },
      groupMetadata: async () => ({
        participants: [
          { id: "260227974823977@lid", lid: "260227974823977@lid", jid: "628111222333@s.whatsapp.net" },
        ],
      }),
    };
    await birthdayCommand.execute({
      sock,
      msg: {
        key: { remoteJid: "120@g.us", participant: "244203384742140:47@lid", fromMe: true, id: "m3" },
        message: {
          extendedTextMessage: {
            text: "!ultah tambah 07-09 rtlkntl",
            contextInfo: { participant: "260227974823977:12@lid" },
          },
        },
      },
      args: ["tambah", "07-09", "rtlkntl"],
      cmdName: "ultah",
      remoteJid: "120@g.us",
      PREFIX: "!",
      logger: { info() {} },
    });
    const rows = await birthdayService.getBirthdaysList("120@g.us");
    assert.equal(rows.length, 1);
    // Resolved to canonical phone JID via groupMetadata
    assert.equal(rows[0].participantId, "628111222333@s.whatsapp.net");
    assert.equal(rows[0].name, "rtlkntl");
    assert.equal(sent.length, 1);
  });

  it("validates isPrivileged when sender uses @lid matching owner or admin", async () => {
    const prevOwner = process.env.OWNER_JID;
    process.env.OWNER_JID = "628999@s.whatsapp.net";
    try {
      const sock = {
        groupMetadata: async () => ({
          participants: [
            { id: "244203384742140@lid", lid: "244203384742140@lid", jid: "628999@s.whatsapp.net", admin: null },
            { id: "111111111111111@lid", lid: "111111111111111@lid", jid: "628111@s.whatsapp.net", admin: "admin" },
            { id: "222222222222222@lid", lid: "222222222222222@lid", jid: "628222@s.whatsapp.net", admin: null },
          ],
        }),
      };

      // Owner via LID -> JID mapping
      const isOwnerPriv = await birthdayCommand.isPrivileged(sock, {
        key: { remoteJid: "120@g.us", participant: "244203384742140:47@lid", fromMe: false },
      }, "120@g.us");
      assert.equal(isOwnerPriv, true);

      // Group admin via LID
      const isAdminPriv = await birthdayCommand.isPrivileged(sock, {
        key: { remoteJid: "120@g.us", participant: "111111111111111@lid", fromMe: false },
      }, "120@g.us");
      assert.equal(isAdminPriv, true);

      // Regular member
      const isRegularPriv = await birthdayCommand.isPrivileged(sock, {
        key: { remoteJid: "120@g.us", participant: "222222222222222@lid", fromMe: false },
      }, "120@g.us");
      assert.equal(isRegularPriv, false);
    } finally {
      process.env.OWNER_JID = prevOwner;
    }
  });

  it("enforces Truth Questions quota of 5 per member and records answers", async () => {
    await birthdayRepository.init();
    await birthdayService.activateTakeover("120@g.us", [{ participantId: "628123@s.whatsapp.net", name: "Rina" }]);

    // Ask questions 1 to 5
    const q1 = await birthdayService.recordTruthQuestion("120@g.us", "628555@s.whatsapp.net", "Budi", "628123@s.whatsapp.net", "Rina", "Kenapa suka mie ayam?", "msg-q1");
    assert.equal(q1.success, true);
    assert.equal(q1.quotaRemaining, 4);

    const q2 = await birthdayService.recordTruthQuestion("120@g.us", "628555@s.whatsapp.net", "Budi", "628123@s.whatsapp.net", "Rina", "Siapa gebetanmu?", "msg-q2");
    assert.equal(q2.success, true);
    assert.equal(q2.quotaRemaining, 3);

    const q3 = await birthdayService.recordTruthQuestion("120@g.us", "628555@s.whatsapp.net", "Budi", "628123@s.whatsapp.net", "Rina", "Pernah bolos gak?", "msg-q3");
    assert.equal(q3.success, true);
    assert.equal(q3.quotaRemaining, 2);

    const q4 = await birthdayService.recordTruthQuestion("120@g.us", "628555@s.whatsapp.net", "Budi", "628123@s.whatsapp.net", "Rina", "Pilih siapa?", "msg-q4");
    assert.equal(q4.success, true);
    assert.equal(q4.quotaRemaining, 1);

    const q5 = await birthdayService.recordTruthQuestion("120@g.us", "628555@s.whatsapp.net", "Budi", "628123@s.whatsapp.net", "Rina", "Pertanyaan ke-5", "msg-q5");
    assert.equal(q5.success, true);
    assert.equal(q5.quotaRemaining, 0);

    // Question 6 should exceed quota
    const q6 = await birthdayService.recordTruthQuestion("120@g.us", "628555@s.whatsapp.net", "Budi", "628123@s.whatsapp.net", "Rina", "Pertanyaan ke-6", "msg-q6");
    assert.equal(q6.error, "quota_exceeded");
    assert.equal(q6.maxQuota, 5);

    // Record honest answer with ! prefix
    const ans1 = await birthdayService.recordTruthAnswer("120@g.us", "628123@s.whatsapp.net", "!Karena bumbunya enak banget", "msg-q1");
    assert.equal(ans1.success, true);
    assert.equal(ans1.isHonest, true);
    assert.equal(ans1.question.answer, "Karena bumbunya enak banget");

    // Record non-binding answer without ! prefix
    const ans2 = await birthdayService.recordTruthAnswer("120@g.us", "628123@s.whatsapp.net", "Rahasia dong", "msg-q2");
    assert.equal(ans2.success, true);
    assert.equal(ans2.isHonest, false);
    assert.equal(ans2.question.answer, "Rahasia dong");

    const interactions = await birthdayService.getTruthInteractions("120@g.us");
    assert.equal(interactions.length, 5);
  });

  it("manages DM session, parses response, and stores confess anonymously & prediction with name", async () => {
    await birthdayRepository.init();
    await birthdayService.activateTakeover("120@g.us", [{ participantId: "628123@s.whatsapp.net", name: "Rina" }]);

    birthdayService.startDmSession("628777@s.whatsapp.net", {
      groupJid: "120@g.us",
      participantName: "Siti",
      birthdayPersons: [{ participantId: "628123@s.whatsapp.net", name: "Rina" }],
    });

    const sess = birthdayService.getDmSession("628777@s.whatsapp.net");
    assert.ok(sess);
    assert.equal(sess.participantName, "Siti");

    const dmText = `Confess: Dulu aku yang ga sengaja tumpahin kopi ke bukumu hehe\n\nPrediksi: Tahun depan Rina bakal dapet promosi jabatan!`;
    const recorded = await birthdayService.recordDmAnswer("628777@s.whatsapp.net", dmText);
    assert.equal(recorded, true);

    const meta = await birthdayService.getTakeoverMetadata("120@g.us");
    // Confession exists and has no senderId/senderName attached
    assert.equal(meta.confessions.length, 1);
    assert.equal(meta.confessions[0].text, "Dulu aku yang ga sengaja tumpahin kopi ke bukumu hehe");
    assert.equal(meta.confessions[0].senderId, undefined);
    assert.equal(meta.confessions[0].senderName, undefined);

    // Prediction has senderName attached
    assert.equal(meta.predictions.length, 1);
    assert.equal(meta.predictions[0].senderName, "Siti");
    assert.ok(meta.predictions[0].predictionText.includes("promosi"));
  });

  it("supports roastOptIn flag in addBirthday and updateBirthday", async () => {
    await birthdayRepository.init();
    const created = await birthdayService.addBirthday("120@g.us", "628999@s.whatsapp.net", "Andi", 10, 5, 1999, "admin", 1);
    assert.equal(created.roastOptIn, 1);

    const rows = await birthdayService.getBirthdaysList("120@g.us");
    assert.equal(rows[0].roastOptIn, 1);

    await birthdayService.updateBirthday("120@g.us", "628999@s.whatsapp.net", { roastOptIn: 0 });
    const updated = await birthdayService.getBirthdaysList("120@g.us");
    assert.equal(updated[0].roastOptIn, 0);
  });

  it("checks flashback due and advances schedule", async () => {
    await birthdayRepository.init();
    const isDueInitial = await birthdayService.checkFlashbackDue("120@g.us");
    assert.equal(isDueInitial, true);

    const nextDate = await birthdayService.advanceFlashbackSchedule("120@g.us");
    assert.ok(nextDate > new Date());

    const isDueAfter = await birthdayService.checkFlashbackDue("120@g.us");
    assert.equal(isDueAfter, false);
  });

  it("parses Cloudinary credentials from CLOUDINARY_URL or individual env variables", () => {
    const cloudinaryService = require("../src/services/cloudinaryService");
    const prevUrl = process.env.CLOUDINARY_URL;
    const prevName = process.env.CLOUDINARY_CLOUD_NAME;
    const prevKey = process.env.CLOUDINARY_API_KEY;
    const prevSec = process.env.CLOUDINARY_API_SECRET;

    try {
      delete process.env.CLOUDINARY_CLOUD_NAME;
      delete process.env.CLOUDINARY_API_KEY;
      delete process.env.CLOUDINARY_API_SECRET;
      process.env.CLOUDINARY_URL = "cloudinary://123456789:testSecret123@mycloud";

      const creds = cloudinaryService.getCredentials();
      assert.equal(creds.cloudName, "mycloud");
      assert.equal(creds.apiKey, "123456789");
      assert.equal(creds.apiSecret, "testSecret123");
      assert.equal(cloudinaryService.isConfigured(), true);
      assert.equal(typeof cloudinaryService.uploadImage, "function");
    } finally {
      process.env.CLOUDINARY_URL = prevUrl;
      process.env.CLOUDINARY_CLOUD_NAME = prevName;
      process.env.CLOUDINARY_API_KEY = prevKey;
      process.env.CLOUDINARY_API_SECRET = prevSec;
    }
  });

  it("provides all formatters and exports required by birthdayScheduler and takeover", () => {
    const persons = [{ participantId: "628123@s.whatsapp.net", name: "Rina" }];

    // Aliases and prompts required by scheduler
    assert.equal(typeof birthdayFormatter.formatMemoryWall, "function");
    assert.equal(typeof birthdayFormatter.formatMemoryWallPrompt, "function");
    assert.equal(typeof birthdayFormatter.formatTruthOpening, "function");
    assert.equal(typeof birthdayFormatter.formatTruthQuestionsPrompt, "function");
    assert.equal(typeof birthdayFormatter.formatPhotoStoryPrompt, "function");
    assert.equal(typeof birthdayFormatter.formatRoastPrompt, "function");
    assert.equal(typeof birthdayFormatter.formatDmPrompt, "function");
    assert.equal(typeof birthdayFormatter.formatDmGroupNotice, "function");
    assert.equal(typeof birthdayFormatter.formatDmAnnouncementGroup, "function");
    assert.equal(typeof birthdayFormatter.formatConfessReveal, "function");
    assert.equal(typeof birthdayFormatter.formatWishJarPrompt, "function");
    assert.equal(typeof birthdayFormatter.formatGrandRecap, "function");
    assert.equal(typeof birthdayFormatter.formatClosingQuest, "function");
    assert.equal(typeof birthdayFormatter.formatFlashback, "function");
    assert.equal(typeof birthdayFormatter.formatFlashbackPhoto, "function");
    assert.equal(typeof birthdayFormatter.pickQuest, "function");
    assert.equal(typeof birthdayFormatter.pickPenalty, "function");

    // Legacy formatters
    assert.equal(typeof birthdayFormatter.formatCard, "function");
    assert.equal(typeof birthdayFormatter.formatSpotlight, "function");
    assert.equal(typeof birthdayFormatter.formatReminder, "function");
    assert.equal(typeof birthdayFormatter.formatWishesOpen, "function");
    assert.equal(typeof birthdayFormatter.formatRecap, "function");
    assert.equal(typeof birthdayFormatter.formatClosing, "function");

    // Verify executions do not throw
    assert.ok(birthdayFormatter.formatMemoryWall(persons).text.includes("MEMORY WALL"));
    assert.ok(birthdayFormatter.formatTruthOpening(persons).text.includes("TRUTH QUESTIONS"));
    assert.ok(birthdayFormatter.formatPhotoStoryPrompt(persons).text.includes("SATU FOTO SATU CERITA"));
    assert.ok(birthdayFormatter.formatRoastPrompt(persons).text.includes("ROAST"));
    assert.ok(birthdayFormatter.formatDmPrompt(persons).text.includes("Confess"));
    assert.ok(birthdayFormatter.formatDmGroupNotice([{ participantId: "628999@s.whatsapp.net", name: "Budi" }]).text.includes("MISI RAHASIA"));
    assert.ok(birthdayFormatter.formatConfessReveal(persons, [{ text: "Rahasia" }]).text.includes("Rahasia"));
    assert.ok(birthdayFormatter.formatWishJarPrompt(persons).text.includes("WISH JAR"));
    assert.ok(birthdayFormatter.formatGrandRecap({ persons }).text.includes("GRAND BIRTHDAY RECAP"));
    assert.ok(birthdayFormatter.formatClosingQuest(persons, "quest", true, "sanksi").text.includes("COMPLETED"));
    assert.ok(birthdayFormatter.formatClosingQuest(persons, "quest", false, "sanksi").text.includes("MISSED"));
    assert.ok(birthdayFormatter.formatFlashback({ senderName: "Budi", caption: "Halo" }).includes("Halo"));

    // Verify birthdayService export
    assert.equal(typeof birthdayService.getWishMessageId, "function");
  });

  it("stores photoUrl in Memory Wall and Quest replies", async () => {
    await birthdayRepository.init();
    await birthdayService.activateTakeover("120@g.us", [{ participantId: "628123@s.whatsapp.net", name: "Rina" }]);

    await birthdayService.recordMemoryWallItem(
      "120@g.us",
      "628999@s.whatsapp.net",
      "Budi",
      "Foto kenangan liburan",
      "https://res.cloudinary.com/test/image/upload/v1/liburan.png"
    );

    await birthdayService.recordQuestReply(
      "120@g.us",
      "628123@s.whatsapp.net",
      "Ini foto sarapanku",
      "https://res.cloudinary.com/test/image/upload/v1/sarapan.png"
    );

    await birthdayService.recordRoast(
      "120@g.us",
      "628999@s.whatsapp.net",
      "Budi",
      "Muka lu pas tidur",
      "https://res.cloudinary.com/test/image/upload/v1/roast.png"
    );

    await birthdayService.recordWishJarItem(
      "120@g.us",
      "628999@s.whatsapp.net",
      "Budi",
      "Tahun ini semoga sukses",
      "https://res.cloudinary.com/test/image/upload/v1/wish.png"
    );

    const meta = await birthdayService.getTakeoverMetadata("120@g.us");
    assert.equal(meta.memoryWall.length, 1);
    assert.equal(meta.memoryWall[0].text, "Foto kenangan liburan");
    assert.equal(meta.memoryWall[0].photoUrl, "https://res.cloudinary.com/test/image/upload/v1/liburan.png");

    assert.equal(meta.questReply.text, "Ini foto sarapanku");
    assert.equal(meta.questReply.photoUrl, "https://res.cloudinary.com/test/image/upload/v1/sarapan.png");

    assert.equal(meta.roasts.length, 1);
    assert.equal(meta.roasts[0].photoUrl, "https://res.cloudinary.com/test/image/upload/v1/roast.png");

    assert.equal(meta.wishJar.length, 1);
    assert.equal(meta.wishJar[0].photoUrl, "https://res.cloudinary.com/test/image/upload/v1/wish.png");
  });
});
