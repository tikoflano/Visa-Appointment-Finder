import crypto from "crypto";
import fs from "fs";
import path from "path";
import readline from "readline";
import { SecretBox } from "./SecretBox";
import { openDatabase, Store } from "./Store";

const USAGE = `Usage:
  node build/server/cli.js generate-key [path]
  node build/server/cli.js set-password
  node build/server/cli.js dump`;

function prompt(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY,
    });
    let muted = false;
    (rl as any)._writeToOutput = (text: string) => {
      if (!muted) process.stdout.write(text);
    };
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
    muted = hidden;
  });
}

function generateKey(file: string) {
  if (fs.existsSync(file)) {
    throw Error(`${file} already exists`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, crypto.randomBytes(32).toString("base64") + "\n", {
    mode: 0o600,
  });
  fs.chmodSync(file, 0o600);
  console.log(`Wrote master key to ${file}`);
  console.log(
    "Back this file up. If it is lost, stored passwords cannot be decrypted.",
  );
}

async function setPassword(store: Store) {
  const password = await prompt("New admin password: ", true);
  if (process.stdin.isTTY) {
    const confirmation = await prompt("Repeat password: ", true);
    if (password !== confirmation) {
      throw Error("Passwords do not match");
    }
  }
  await store.setAdminPassword(password);
  console.log("Admin password updated");
}

async function dump(store: Store) {
  const settings = await store.getSettings();
  const profiles = await store.listProfiles();
  const payload = {
    settings: {
      ...settings,
      gmailAppPassword: await store.getGmailAppPassword(),
      openwaApiKey: await store.getOpenwaApiKey(),
    },
    profiles: await Promise.all(
      profiles.map(async (profile) => ({
        ...profile,
        visaPassword: await store.getVisaPassword(profile.id),
      })),
    ),
  };
  console.log(JSON.stringify(payload, null, 2));
}

(async () => {
  const [command, ...args] = process.argv.slice(2);
  if (!["generate-key", "set-password", "dump"].includes(command)) {
    throw Error(USAGE);
  }

  if (command === "generate-key") {
    generateKey(args[0] || SecretBox.resolveKeyPath());
    return;
  }

  const db = await openDatabase();
  try {
    const store = new Store(db, SecretBox.fromEnvironment());
    await store.initialize();
    if (command === "set-password") await setPassword(store);
    if (command === "dump") await dump(store);
  } finally {
    await db.close();
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
