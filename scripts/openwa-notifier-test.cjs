const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "visa-openwa-"));
const keyFile = path.join(tmp, "master.key");
const dbFile = path.join(tmp, "db.sqlite");
fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("base64") + "\n", {
  mode: 0o600,
});
process.env.VISA_MASTER_KEY_FILE = keyFile;
process.env.DB_PATH = dbFile;

const { Notifier } = require("../build/server/Notifier");
const { openDatabase, Store } = require("../build/server/Store");
const { SecretBox } = require("../build/server/SecretBox");
const { parseWhatsAppChatIds } = require("../build/server/whatsapp");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function startMock(apiKey) {
  const received = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && /\/messages\/send-text$/.test(req.url || "")) {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        if (req.headers["x-api-key"] !== apiKey) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "bad key" }));
          return;
        }
        received.push({
          url: req.url,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          idempotencyKey: req.headers["idempotency-key"],
        });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ messageId: "true_test", timestamp: Date.now() / 1000 }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, received });
    });
  });
}

(async () => {
  const ids = parseWhatsAppChatIds("+56 9 1234 5678, 120363000000000000@g.us");
  assert(ids[0] === "56912345678@c.us", `phone normalize: ${ids[0]}`);
  assert(ids[1] === "120363000000000000@g.us", `group id: ${ids[1]}`);
  let threw = false;
  try {
    parseWhatsAppChatIds("123");
  } catch {
    threw = true;
  }
  assert(threw, "short number should fail");

  const mock = await startMock("test-key");
  const db = await openDatabase();
  const store = new Store(db, SecretBox.fromEnvironment());
  await store.initialize();
  await store.updateSettings({
    gmailUser: "",
    emailAdminDestination: "",
    openwaBaseUrl: `http://127.0.0.1:${mock.port}`,
    openwaSessionId: "sess-1",
    openwaApiKey: "test-key",
    whatsappAdminDestination: "56911111111",
    intervalMinutes: 5,
    heartbeatEnabled: true,
    heartbeatMinutes: 1440,
    maxConcurrentRuns: 1,
    runTimeoutMinutes: 5,
    failureAlarmThreshold: 3,
    botDebug: false,
  });
  const profile = await store.createProfile({
    name: "OpenWA test",
    visaEmail: "visa@example.com",
    visaPassword: "secret-pass",
    visaProcessId: "12345678",
    emailDestination: "",
    whatsappDestination: "56912345678",
    minDate: "2026-12-01",
    maxDate: "2026-12-31",
    actions: ["notify"],
    enabled: false,
  });
  const notifier = new Notifier(store);
  const dates = ["2026-12-07", "2026-12-14"];
  const result = {
    ok: true,
    outcome: "available",
    currentAppointment: "2026-12-20",
    dates,
    error: null,
    notified: false,
    rescheduled: false,
  };

  const first = await notifier.notifyForRun(profile.id, 1, "success", result);
  assert(first.notified === true, "first send should notify");
  assert(mock.received.length === 2, `expected 2 chats (profile+admin), got ${mock.received.length}`);
  assert(
    mock.received.some((item) => item.body.chatId === "56912345678@c.us"),
    "profile chat missing",
  );
  assert(
    mock.received.some((item) => item.body.chatId === "56911111111@c.us"),
    "admin chat missing",
  );
  assert(
    mock.received[0].body.text.includes("2026"),
    `body should mention the date: ${mock.received[0].body.text}`,
  );

  const second = await notifier.notifyForRun(profile.id, 2, "success", result);
  assert(second.notified === false, "same dates should be debounced");
  assert(mock.received.length === 2, "debounce should not send again");

  const third = await notifier.notifyForRun(profile.id, 3, "success", {
    ...result,
    dates: ["2026-12-03"],
  });
  assert(third.notified === true, "new earlier date should notify");
  assert(mock.received.length === 4, `expected 4 sends, got ${mock.received.length}`);

  mock.received.length = 0;
  const heartbeat = await notifier.sendHeartbeat({ force: true });
  assert(heartbeat.sent === true, "heartbeat should send");
  assert(mock.received.length === 1, `heartbeat should message admin once, got ${mock.received.length}`);
  assert(mock.received[0].body.chatId === "56911111111@c.us", "heartbeat chat");

  mock.received.length = 0;
  const testSend = await notifier.sendTest({ channel: "whatsapp" });
  assert(testSend.sent === true, "whatsapp test should send");
  assert(mock.received.length === 1, `test should message admin once, got ${mock.received.length}`);
  assert(
    mock.received[0].body.text.includes("test"),
    `test body should say test: ${mock.received[0].body.text}`,
  );

  let testThrew = false;
  try {
    await notifier.sendTest({ channel: "email" });
  } catch (error) {
    testThrew = /Gmail/i.test(String(error.message));
  }
  assert(testThrew, "email test without Gmail should fail");

  const notes = await store.listNotifications(20, { channel: "whatsapp" });
  assert(
    notes.some((note) => note.kind === "appointment" && note.status === "sent"),
    "appointment log missing",
  );
  assert(
    notes.some((note) => note.kind === "heartbeat" && note.status === "sent"),
    "heartbeat log missing",
  );
  assert(
    notes.some((note) => note.kind === "test" && note.status === "sent"),
    "test log missing",
  );

  mock.server.close();
  await db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("openwa notifier test: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
