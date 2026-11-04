#!/usr/bin/env node
/**
 * Smoke-test the Live SSE hub end-to-end against a running management server.
 *
 * Usage:
 *   node scripts/live-sse-smoke.cjs [baseUrl]
 *
 * Default baseUrl: http://127.0.0.1:3000
 * In VISA_DEV the session cookie is optional.
 */
const http = require("http");
const https = require("https");
const { URL } = require("url");

const baseUrl = process.argv[2] || "http://127.0.0.1:3000";
const timeoutMs = Number(process.env.LIVE_SMOKE_TIMEOUT_MS || 20000);

function request(method, path, { headers = {}, body } = {}) {
  const url = new URL(path, baseUrl);
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      { method, headers: { Accept: "application/json", ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* ignore */
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function openSse(path, headers = {}) {
  const url = new URL(path, baseUrl);
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          ...headers,
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(
            new Error(
              `SSE HTTP ${res.statusCode} (want 200 text/event-stream)`,
            ),
          );
          res.resume();
          return;
        }
        const ctype = String(res.headers["content-type"] || "");
        if (!ctype.includes("text/event-stream")) {
          reject(new Error(`Unexpected content-type: ${ctype}`));
          res.resume();
          return;
        }
        resolve({ req, res });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function readSse(res, { until, timeoutMs: ms }) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const events = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${ms}ms waiting for SSE events`));
    }, ms);
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = block
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (!dataLine) continue;
        try {
          const event = JSON.parse(dataLine.slice(6));
          events.push(event);
          if (until(event, events)) {
            cleanup();
            resolve(events);
            return;
          }
        } catch {
          /* ignore malformed */
        }
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      res.off("data", onData);
      res.off("error", onError);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    res.on("data", onData);
    res.on("error", onError);
  });
}

(async () => {
  console.log(`Live SSE smoke → ${baseUrl}`);

  const session = await request("GET", "/api/session");
  if (session.status !== 200) {
    throw new Error(`/api/session → ${session.status}`);
  }
  console.log(
    `session ok (dev=${!!session.json?.dev}, auth=${!!session.json?.authenticated})`,
  );

  const { req, res } = await openSse("/api/live/stream");
  console.log("SSE connected");

  const helloEvents = await readSse(res, {
    timeoutMs: 5000,
    until: (_event, events) =>
      events.some((e) => e.type === "hello") &&
      events.some((e) => e.type === "profiles"),
  });
  const hello = helloEvents.find((e) => e.type === "hello");
  const profilesEvent = helloEvents.find((e) => e.type === "profiles");
  if (!hello?.screencasting) {
    throw new Error("hello.screencasting should be true for the first viewer");
  }
  if (!Array.isArray(profilesEvent?.profiles)) {
    throw new Error("profiles event missing array");
  }
  console.log(
    `hello+profiles ok (${profilesEvent.profiles.length} profiles, screencasting=${hello.screencasting})`,
  );

  const enabled = profilesEvent.profiles.find((p) => p.enabled);
  if (!enabled) {
    console.log("No enabled profile — stream handshake validated only.");
    req.destroy();
    process.exit(0);
  }

  const run = await request("POST", `/api/profiles/${enabled.id}/run`, {
    headers: {
      "Content-Type": "application/json",
      Origin: new URL(baseUrl).origin,
    },
    body: "{}",
  });
  if (run.status !== 200 || !run.json?.ok) {
    throw new Error(
      `Run now failed for profile ${enabled.id}: HTTP ${run.status} ${run.text}`,
    );
  }
  console.log(`Run now started for profile ${enabled.id} (${enabled.name})`);

  const runEvents = await readSse(res, {
    timeoutMs,
    until: (event, events) => {
      const sawRunning = events.some(
        (e) =>
          e.type === "profiles" &&
          e.profiles?.some(
            (p) => p.id === enabled.id && p.state === "running",
          ),
      );
      const sawFrame = events.some(
        (e) => e.type === "frame" && e.profileId === enabled.id && e.jpeg,
      );
      return sawRunning && sawFrame;
    },
  });

  const frames = runEvents.filter(
    (e) => e.type === "frame" && e.profileId === enabled.id,
  );
  console.log(
    `PASS — saw running state and ${frames.length} frame(s) for profile ${enabled.id}`,
  );
  req.destroy();
  process.exit(0);
})().catch((error) => {
  console.error("FAIL —", error.message || error);
  process.exit(1);
});
