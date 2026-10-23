const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "visa-intake-"));
const keyFile = path.join(tmp, "master.key");
fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("base64") + "\n", {
  mode: 0o600,
});
process.env.VISA_MASTER_KEY_FILE = keyFile;
process.env.DB_PATH = path.join(tmp, "db.sqlite");

const { intakeSavedReply, parseIntakeReply } = require("../build/server/intakeReply");
const {
  INTAKE_WINDOW_MS,
  nextIntakePollAt,
} = require("../build/server/intakeSchedule");
const { openDatabase, Store } = require("../build/server/Store");
const { SecretBox } = require("../build/server/SecretBox");
const { Action } = require("../build/types");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function reply(overrides = {}) {
  const fields = {
    login_email: "ada@example.com",
    login_password: "secret",
    process_id: "12345678",
    from: "2026-11-01",
    to: "2026-12-31",
    notification_emails: "ada@example.com, bob@example.com",
    notification_phones: "56911111111",
    ...overrides,
  };
  const lines = [
    "VISA-PROFILE",
    `login_email: ${fields.login_email}`,
    `login_password: ${fields.login_password}`,
    `process_id: ${fields.process_id}`,
    `from: ${fields.from}`,
  ];
  if (!Object.prototype.hasOwnProperty.call(overrides, "omitTo")) {
    lines.push(`to: ${fields.to}`);
  }
  lines.push(
    `notification_emails: ${fields.notification_emails}`,
    `notification_phones: ${fields.notification_phones}`,
  );
  return lines.join("\n");
}

function testParser() {
  assert(
    intakeSavedReply("Ada").includes("waiting for an admin to enable it"),
    "saved reply tells the phone user to wait for an admin",
  );
  const saved = parseIntakeReply(reply());
  assert(saved.kind === "ok", "valid block should save");
  assert(saved.fields.visaEmail === "ada@example.com", "email");
  assert(saved.fields.visaPassword === "secret", "password");
  assert(
    saved.fields.emailDestination === "ada@example.com,bob@example.com",
    "mails are a CSV",
  );
  assert(saved.fields.whatsappDestination === "56911111111@c.us", "listed phone only");
  assert(saved.fields.minDate === "2026-11-01", "from");
  assert(saved.fields.maxDate === "2026-12-31", "to");

  const spaced = parseIntakeReply(
    reply({ login_password: " secret " }).replace(
      "login_password:  secret ",
      "login_password:  secret ",
    ),
  );
  assert(spaced.kind === "ok", "password with spaces should still be the template");
  assert(spaced.fields.visaPassword === " secret ", "password keeps surrounding spaces");

  const noNotify = parseIntakeReply(
    reply({ notification_emails: "", notification_phones: "" }),
  );
  assert(noNotify.kind === "ok", "empty notification lists mean no notifications");
  assert(noNotify.fields.emailDestination === "", "no mails");
  assert(noNotify.fields.whatsappDestination === "", "no phones");

  const badMail = parseIntakeReply(
    reply({ notification_emails: "ada@example.com, not-an-email" }),
  );
  assert(badMail.kind === "invalid", "a bad address in the CSV is invalid");
  assert(
    badMail.problems.some((problem) => problem.includes("notification_emails")),
    "mail problem names the field",
  );
  assert(
    !badMail.problems.some((problem) => problem.includes("secret")),
    "validation reply must not echo the password",
  );

  const dates = parseIntakeReply(reply({ from: "2026-12-31", to: "2026-11-01" }));
  assert(dates.kind === "invalid", "reversed dates are invalid");
  assert(
    dates.problems.some((problem) => problem.includes("on or before")),
    "date order is explained",
  );

  const phones = parseIntakeReply(
    reply({
      notification_phones: "56911111111, 12",
      notification_emails: "ada@example.com",
    }),
  );
  assert(phones.kind === "invalid", "a bad number in the CSV is invalid");
  assert(
    phones.problems.some((problem) => problem.includes("notification_phones")),
    "phone problem names the field",
  );

  const listed = parseIntakeReply(
    reply({ notification_phones: "56933333333", notification_emails: "" }),
  );
  assert(listed.kind === "ok", "phones alone authorize WhatsApp");
  assert(listed.fields.whatsappDestination === "56933333333@c.us", "only the listed number");
  assert(listed.fields.emailDestination === "", "mails stay empty");

  const openEnded = parseIntakeReply(reply({ to: "" }));
  assert(openEnded.kind === "ok", "an empty to uses the current appointment");
  assert(openEnded.fields.maxDate === "", "empty to is stored as no latest date");

  const omittedTo = parseIntakeReply(reply({ omitTo: true }));
  assert(omittedTo.kind === "ok", "a missing to line uses the current appointment");
  assert(omittedTo.fields.maxDate === "", "omitted to is stored as no latest date");

  const slashDates = parseIntakeReply(
    reply({ from: "2026/11/01", to: "2026/12/31" }),
  );
  assert(slashDates.kind === "ok", "YYYY/MM/DD dates are accepted");
  assert(slashDates.fields.minDate === "2026-11-01", "from slash date is stored with dashes");
  assert(slashDates.fields.maxDate === "2026-12-31", "to slash date is stored with dashes");

  const badTo = parseIntakeReply(reply({ to: "November" }));
  assert(badTo.kind === "invalid", "a non-date to is invalid");
  assert(
    badTo.problems.some((problem) => problem.includes("current appointment")),
    "invalid to explains that empty means the current appointment",
  );

  const legacy = parseIntakeReply(
    [
      "VISA-PROFILE",
      "email: ada@example.com",
      "password: secret",
      "process: 12345678",
      "from: 2026-11-01",
      "to: 2026-12-31",
      "notification_mails: ada@example.com",
      "notification_phones: ",
    ].join("\n"),
  );
  assert(legacy.kind === "invalid", "the previous field names get a correction");
  assert(
    legacy.problems.some((problem) => problem.includes("process_id")),
    "the correction names the current fields",
  );

  assert(parseIntakeReply("hello").kind === "ignore", "chat is ignored");
  assert(
    parseIntakeReply(`Please fill this in.\n\n${reply()}`).kind === "ok",
    "text above the VISA-PROFILE block is fine",
  );
  assert(
    parseIntakeReply(
      `${reply()}\n\nHow to fill each field:\n> *login_email*: email used to login to AIS`,
    ).kind === "ok",
    "pasting the field help under the block is fine",
  );
  assert(
    parseIntakeReply(
      `Reply with this block only.\n\n${reply()}\n\nHow to fill each field:\n> *from*: earliest date`,
    ).kind === "ok",
    "pasting the whole prompt with a filled block is fine",
  );
  assert(
    parseIntakeReply(
      `Reply with this block only.\n\n${reply({
        login_email: "",
        login_password: "",
        process_id: "",
        from: "",
        to: "",
        notification_emails: "",
        notification_phones: "",
      })}\n\nHow to fill each field:`,
    ).kind === "ignore",
    "an unfilled template copy is ignored",
  );
  assert(
    parseIntakeReply(
      "VISA-PROFILE\nlogin_email: ada@example.com\nnot-a-field: x\n",
    ).kind === "invalid",
    "wrong key on a VISA-PROFILE block gets a correction",
  );
  assert(
    parseIntakeReply(reply().replace("login_email:", "Login_email:")).kind ===
      "invalid",
    "wrong casing on a field name gets a correction",
  );
}

function testSchedule() {
  const start = Date.parse("2026-10-22T12:00:00.000Z");
  const minute = 60 * 1000;
  assert(nextIntakePollAt(start, start) === start + minute, "first check is 1 minute");
  assert(
    nextIntakePollAt(start, start + 4 * minute) === start + 5 * minute,
    "still every minute at 4 minutes",
  );
  assert(
    nextIntakePollAt(start, start + 10 * minute) === start + 15 * minute,
    "5 minute cadence after 10 minutes",
  );
  assert(
    nextIntakePollAt(start, start + 30 * minute) === start + 35 * minute,
    "5 minute cadence at 30 minutes",
  );
  assert(
    nextIntakePollAt(start, start + 70 * minute) === start + 130 * minute,
    "hourly after 70 minutes",
  );
  assert(
    nextIntakePollAt(start, start + 2 * 60 * minute) === start + 130 * minute,
    "next hour-slot after 2 hours is 2 hours 10 minutes",
  );
  assert(
    nextIntakePollAt(start, start + INTAKE_WINDOW_MS - 1) === start + INTAKE_WINDOW_MS,
    "final check is the 24 hour mark",
  );
  assert(nextIntakePollAt(start, start + INTAKE_WINDOW_MS) === null, "nothing after 24 hours");
}

async function testStore() {
  const db = await openDatabase();
  const store = new Store(db, SecretBox.fromEnvironment());
  await store.initialize();
  await store.initialize();

  const manual = await store.createProfile({
    name: "Manual",
    visaEmail: "manual@example.com",
    visaPassword: "manual-secret",
    visaProcessId: "42",
    emailDestination: "manual@example.com",
    whatsappDestination: "",
    minDate: "2026-11-01",
    maxDate: "2026-12-31",
    actions: [Action.Notify],
    enabled: false,
  });
  assert(manual.intakeStatus === "ready", "manual profile is ready");
  assert((await store.getVisaPassword(manual.id)) === "manual-secret", "manual password");

  const first = await store.createIntake("Ada", "+56 9 1111 1111");
  const second = await store.createIntake("Bea", "56922222222");
  assert(first.intakeStatus === "pending", "intake pending");
  assert(first.visaProcessId == null && second.visaProcessId == null, "two empty process ids");
  assert(first.contactPhone === "56911111111@c.us", "phone normalized");
  assert(!(await store.getVisaPassword(first.id)), "no password yet");

  let duplicate = "";
  try {
    await store.createIntake("Cara", "56911111111");
  } catch (error) {
    duplicate = error.message;
  }
  assert(duplicate.includes("already has a profile"), duplicate || "duplicate phone");

  let enabled = "";
  try {
    await store.setProfileEnabled(first.id, true);
  } catch (error) {
    enabled = error.message;
  }
  assert(enabled.includes("waiting"), enabled || "pending cannot be enabled");

  const saved = parseIntakeReply(
    reply({
      process_id: "99",
      notification_emails: "ada@example.com",
      notification_phones: "",
    }),
  );
  assert(saved.kind === "ok", "store fixture parses");
  const done = await store.completeIntake(first.id, {
    name: first.name,
    visaEmail: saved.fields.visaEmail,
    visaPassword: saved.fields.visaPassword,
    visaProcessId: saved.fields.visaProcessId,
    emailDestination: saved.fields.emailDestination,
    whatsappDestination: saved.fields.whatsappDestination,
    minDate: saved.fields.minDate,
    maxDate: saved.fields.maxDate,
    actions: [Action.Notify],
    enabled: false,
  });
  const awaiting = await store.listProfilesAwaitingEnableNotice();
  assert(awaiting.some((profile) => profile.id === done.id), "phone user still needs the enable notice");
  assert(!awaiting.some((profile) => profile.id === manual.id), "manual profiles are not notified");
  await store.markIntakeConfirmed(done.id);
  assert(
    !(await store.listProfilesAwaitingEnableNotice()).some((profile) => profile.id === done.id),
    "confirmed intakes are not notified again",
  );
  assert(done.intakeStatus === "ready", "completed intake is ready");
  assert(done.visaProcessId === "99", "process id stored");
  assert((await store.getVisaPassword(first.id)) === "secret", "password encrypted");
  assert((await store.listPendingIntakes()).length === 1, "only Bea still pending");

  const now = Date.now();
  await store.markIntakePromptSent(second.id, now - 60_000);
  assert((await store.expireIntake(second.id, "stopped")) === true, "expire once");
  assert((await store.expireIntake(second.id, "stopped")) === false, "expire is single shot");
  const expired = await store.getProfile(second.id);
  assert(expired.intakeStatus === "expired", "expired status");
  assert(expired.intakeError === "stopped", "expired notice stored");

  await db.close();
}

(async () => {
  testParser();
  testSchedule();
  await testStore();
  console.log("intake tests passed");
})().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
