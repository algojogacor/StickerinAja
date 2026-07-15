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
});

describe("Birthday formatting and configuration", () => {
  it("formats mentions without exposing raw JIDs", () => {
    const result = birthdayFormatter.formatOpening([
      { participantId: "628123@s.whatsapp.net", name: "Rina" },
    ]);
    assert.ok(result.text.includes("@Rina"));
    assert.deepEqual(result.mentions, ["628123@s.whatsapp.net"]);
    assert.equal(result.text.includes("628123@s.whatsapp.net"), false);
  });

  it("keeps the production event schedule inside the active WIB window", () => {
    assert.ok(birthdayConfig.EVENT_SCHEDULES.length >= 5);
    for (const slot of birthdayConfig.EVENT_SCHEDULES) {
      const [hour, minute] = slot.time.split(":").map(Number);
      assert.ok(hour * 60 + minute >= 7 * 60);
      assert.ok(hour * 60 + minute <= 22 * 60);
    }
  });
});

describe("Birthday scheduler contract", () => {
  it("exports an absolute-slot scheduler lifecycle", () => {
    assert.equal(typeof birthdayScheduler.start, "function");
    assert.equal(typeof birthdayScheduler.stop, "function");
    assert.equal(typeof birthdayScheduler.resume, "function");
    assert.equal(typeof birthdayScheduler.runEvent, "function");
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
});
