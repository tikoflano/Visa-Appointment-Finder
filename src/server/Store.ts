import crypto from "crypto";
import sqlite3 from "sqlite3";
import { Database, open } from "sqlite";
import {
  BotResult,
  normalizeBotResult,
  profileSearchWindow,
  windowsOverlap,
} from "../botResult";
import { Action } from "../types";
import { DatabaseService } from "../services/DatabaseService";
import { SecretBox } from "./SecretBox";

type Db = Database<sqlite3.Database, sqlite3.Statement>;

const KEY_CHECK_PLAINTEXT = "visa-appointment-finder";
const RUN_OUTPUT_LIMIT = 64 * 1024;
const RUN_RETENTION_DAYS = 14;

export interface ProfileInput {
  name: string;
  visaEmail: string;
  // Omitted or empty on update means "keep the stored password".
  visaPassword?: string;
  visaProcessId: string;
  emailDestination: string;
  minDate: string | null;
  maxDate: string | null;
  actions: Action[];
  enabled: boolean;
}

export interface Profile extends Omit<ProfileInput, "visaPassword"> {
  id: number;
  hasPassword: boolean;
  currentAppointmentDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  gmailUser: string;
  hasGmailAppPassword: boolean;
  emailAdminDestination: string;
  intervalMinutes: number;
  heartbeatEnabled: boolean;
  heartbeatMinutes: number;
  lastHeartbeatAt: string | null;
  maxConcurrentRuns: number;
  runTimeoutMinutes: number;
  botDebug: boolean;
}

export interface SettingsInput
  extends Omit<Settings, "hasGmailAppPassword" | "lastHeartbeatAt"> {
  gmailAppPassword?: string;
}

export type RunStatus =
  | "running"
  | "success"
  | "failed"
  | "timeout"
  | "cancelled"
  | "interrupted";

export interface Run {
  id: number;
  profileId: number;
  trigger: string;
  status: RunStatus;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  result: BotResult | null;
  output?: string;
}

function normalizeEmailList(value: unknown): string {
  return String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(",");
}

const DEFAULT_SETTINGS: Record<string, string> = {
  gmail_user: "",
  email_admin_destination: "",
  interval_minutes: "5",
  heartbeat_enabled: "1",
  heartbeat_minutes: "1440",
  max_concurrent_runs: "2",
  run_timeout_minutes: "5",
  bot_debug: "0",
};

const profileSecretContext = (id: number) => `profile:${id}:visa_password`;
const GMAIL_SECRET_CONTEXT = "setting:gmail_app_password";

export class ValidationError extends Error {}

export async function openDatabase(): Promise<Db> {
  const db = await open({
    filename: process.env.DB_PATH || "./db.sqlite",
    driver: sqlite3.Database,
  });
  // WAL lets the UI, scheduler, and runner processes share one file.
  await db.run("PRAGMA journal_mode = WAL");
  await db.run("PRAGMA busy_timeout = 10000");
  await db.run("PRAGMA synchronous = NORMAL");
  return db;
}

export class Store {
  readonly db: Db;
  private readonly box: SecretBox;

  constructor(db: Db, box: SecretBox) {
    this.db = db;
    this.box = box;
  }

  async initialize(): Promise<void> {
    await new DatabaseService(this.db).initialize();

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS profile (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        visa_email TEXT NOT NULL,
        visa_password_enc TEXT NOT NULL,
        visa_process_id TEXT NOT NULL,
        email_destination TEXT NOT NULL DEFAULT '',
        min_date TEXT,
        max_date TEXT,
        actions TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 0,
        current_appointment_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS setting (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run (
        id INTEGER PRIMARY KEY,
        profile_id INTEGER NOT NULL,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        output TEXT NOT NULL DEFAULT '',
        result TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS run_profile_idx ON run (profile_id, id);
      CREATE INDEX IF NOT EXISTS log_process_idx ON log (visa_process_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS profile_process_idx
        ON profile (visa_process_id);
    `);

    const profileColumns: { name: string }[] = await this.db.all(
      "PRAGMA table_info(profile)",
    );
    if (profileColumns.some((column) => column.name === "interval_minutes")) {
      await this.db.exec("ALTER TABLE profile DROP COLUMN interval_minutes");
    }
    if (profileColumns.some((column) => column.name === "heartbeat")) {
      if (!(await this.getRawSetting("heartbeat_enabled"))) {
        const counts = await this.db.get<{ n: number; enabled_count: number }>(
          "SELECT COUNT(*) AS n, COALESCE(SUM(heartbeat), 0) AS enabled_count FROM profile",
        );
        await this.setRawSetting(
          "heartbeat_enabled",
          !counts?.n || Number(counts.enabled_count) > 0 ? "1" : "0",
        );
      }
      await this.db.exec("ALTER TABLE profile DROP COLUMN heartbeat");
    }
    if (
      !profileColumns.some(
        (column) => column.name === "current_appointment_date",
      )
    ) {
      await this.db.exec(
        "ALTER TABLE profile ADD COLUMN current_appointment_date TEXT",
      );
    }

    const runColumns: { name: string }[] = await this.db.all(
      "PRAGMA table_info(run)",
    );
    if (!runColumns.some((column) => column.name === "result")) {
      await this.db.exec("ALTER TABLE run ADD COLUMN result TEXT");
    }

    await this.verifyMasterKey();
  }

  // Fails fast at startup instead of on the first scheduled run when the
  // mounted key is not the one the database was encrypted with.
  private async verifyMasterKey(): Promise<void> {
    const check = await this.getRawSetting("key_check");
    if (!check) {
      await this.setRawSetting(
        "key_check",
        this.box.encrypt(KEY_CHECK_PLAINTEXT, "setting:key_check"),
      );
      return;
    }

    if (this.box.decrypt(check, "setting:key_check") !== KEY_CHECK_PLAINTEXT) {
      throw Error(
        "Master key check failed. The key file is not the one this database was encrypted with.",
      );
    }
  }

  // ---- Settings ----

  private async getRawSetting(key: string): Promise<string | undefined> {
    const row = await this.db.get<{ value: string }>(
      "SELECT value FROM setting WHERE key = ?",
      [key],
    );
    return row?.value;
  }

  private async setRawSetting(key: string, value: string): Promise<void> {
    await this.db.run(
      "INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  }

  private async getSetting(key: string): Promise<string> {
    return (await this.getRawSetting(key)) ?? DEFAULT_SETTINGS[key] ?? "";
  }

  async getSettings(): Promise<Settings> {
    return {
      gmailUser: await this.getSetting("gmail_user"),
      hasGmailAppPassword: !!(await this.getRawSetting("gmail_app_password")),
      emailAdminDestination: await this.getSetting("email_admin_destination"),
      intervalMinutes: Number(await this.getSetting("interval_minutes")),
      heartbeatEnabled: (await this.getSetting("heartbeat_enabled")) === "1",
      heartbeatMinutes: Number(await this.getSetting("heartbeat_minutes")),
      lastHeartbeatAt: await this.getLastHeartbeatAt(),
      maxConcurrentRuns: Number(await this.getSetting("max_concurrent_runs")),
      runTimeoutMinutes: Number(await this.getSetting("run_timeout_minutes")),
      botDebug: (await this.getSetting("bot_debug")) === "1",
    };
  }

  async updateSettings(input: SettingsInput): Promise<Settings> {
    const positiveInt = (value: unknown, field: string) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) {
        throw new ValidationError(`${field} must be a positive integer`);
      }
      return String(n);
    };

    await this.setRawSetting("gmail_user", String(input.gmailUser ?? "").trim());
    await this.setRawSetting(
      "email_admin_destination",
      normalizeEmailList(input.emailAdminDestination),
    );
    await this.setRawSetting(
      "interval_minutes",
      positiveInt(input.intervalMinutes, "Check interval"),
    );
    await this.setRawSetting(
      "heartbeat_enabled",
      input.heartbeatEnabled ? "1" : "0",
    );
    await this.setRawSetting(
      "heartbeat_minutes",
      positiveInt(input.heartbeatMinutes, "Heartbeat interval"),
    );
    await this.setRawSetting(
      "max_concurrent_runs",
      positiveInt(input.maxConcurrentRuns, "Max concurrent runs"),
    );
    await this.setRawSetting(
      "run_timeout_minutes",
      positiveInt(input.runTimeoutMinutes, "Run timeout"),
    );
    await this.setRawSetting("bot_debug", input.botDebug ? "1" : "0");
    if (input.gmailAppPassword) {
      await this.setRawSetting(
        "gmail_app_password",
        this.box.encrypt(input.gmailAppPassword, GMAIL_SECRET_CONTEXT),
      );
    }
    return this.getSettings();
  }

  async getLastHeartbeatAt(): Promise<string | null> {
    const row = await this.db.get<{ timestamp: string }>(
      "SELECT timestamp FROM heartbeat_notification ORDER BY id DESC LIMIT 1",
    );
    return row?.timestamp ?? null;
  }

  async getGmailAppPassword(): Promise<string> {
    const encrypted = await this.getRawSetting("gmail_app_password");
    return encrypted ? this.box.decrypt(encrypted, GMAIL_SECRET_CONTEXT) : "";
  }

  // ---- Admin password ----

  async hasAdminPassword(): Promise<boolean> {
    return !!(await this.getRawSetting("admin_password_hash"));
  }

  async setAdminPassword(password: string): Promise<void> {
    if (password.length < 10) {
      throw new ValidationError("Password must be at least 10 characters");
    }
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    await this.setRawSetting(
      "admin_password_hash",
      `scrypt:${salt.toString("base64")}:${hash.toString("base64")}`,
    );
  }

  async verifyAdminPassword(password: string): Promise<boolean> {
    const stored = await this.getRawSetting("admin_password_hash");
    if (!stored) {
      return false;
    }
    const [, salt, hash] = stored.split(":");
    const expected = Buffer.from(hash, "base64");
    const actual = crypto.scryptSync(password, Buffer.from(salt, "base64"), 64);
    return crypto.timingSafeEqual(expected, actual);
  }

  // ---- Profiles ----

  private toProfile(row: any): Profile {
    return {
      id: row.id,
      name: row.name,
      visaEmail: row.visa_email,
      visaProcessId: row.visa_process_id,
      emailDestination: row.email_destination,
      minDate: row.min_date,
      maxDate: row.max_date,
      actions: row.actions ? (row.actions.split(",") as Action[]) : [],
      enabled: !!row.enabled,
      currentAppointmentDate: row.current_appointment_date ?? null,
      hasPassword: !!row.visa_password_enc,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private validateProfile(input: ProfileInput, isNew: boolean): ProfileInput {
    const isoDate = /^\d{4}-\d{2}-\d{2}$/;
    const name = String(input.name ?? "").trim();
    const visaEmail = String(input.visaEmail ?? "").trim();
    const visaProcessId = String(input.visaProcessId ?? "").trim();
    const emailDestination = String(input.emailDestination ?? "").trim();
    const minDate = input.minDate || null;
    const maxDate = input.maxDate || null;
    const actions = Array.isArray(input.actions) ? input.actions : [];

    if (!name) throw new ValidationError("Name is required");
    if (!visaEmail) throw new ValidationError("Visa account email is required");
    if (isNew && !input.visaPassword) {
      throw new ValidationError("Visa account password is required");
    }
    if (!/^\d+$/.test(visaProcessId)) {
      throw new ValidationError("Visa process ID must be numeric");
    }
    for (const date of [minDate, maxDate]) {
      if (date && (!isoDate.test(date) || isNaN(+new Date(date)))) {
        throw new ValidationError(`Invalid date: ${date}`);
      }
    }
    if (minDate && maxDate && minDate > maxDate) {
      throw new ValidationError("Min date must be on or before max date");
    }
    const validActions = Object.values(Action) as string[];
    if (actions.some((a) => !validActions.includes(a))) {
      throw new ValidationError("Invalid action");
    }
    if (actions.includes(Action.Notify) && !emailDestination) {
      throw new ValidationError("Notify emails are required for notify action");
    }

    return {
      name,
      visaEmail,
      visaPassword: input.visaPassword || undefined,
      visaProcessId,
      emailDestination,
      minDate,
      maxDate,
      actions,
      enabled: !!input.enabled,
    };
  }

  async listProfiles(): Promise<Profile[]> {
    const rows = await this.db.all("SELECT * FROM profile ORDER BY name");
    return rows.map((row) => this.toProfile(row));
  }

  async getProfile(id: number): Promise<Profile | undefined> {
    const row = await this.db.get("SELECT * FROM profile WHERE id = ?", [id]);
    return row ? this.toProfile(row) : undefined;
  }

  async findProfileByProcessId(processId: string): Promise<Profile | undefined> {
    const row = await this.db.get(
      "SELECT * FROM profile WHERE visa_process_id = ?",
      [processId],
    );
    return row ? this.toProfile(row) : undefined;
  }

  async getVisaPassword(id: number): Promise<string> {
    const row = await this.db.get<{ visa_password_enc: string }>(
      "SELECT visa_password_enc FROM profile WHERE id = ?",
      [id],
    );
    if (!row) throw Error(`Profile ${id} not found`);
    return this.box.decrypt(row.visa_password_enc, profileSecretContext(id));
  }

  private async assertCanEnable(candidate: {
    id?: number;
    minDate: string | null;
    maxDate: string | null;
    currentAppointmentDate: string | null;
  }): Promise<void> {
    const window = profileSearchWindow(candidate);
    if (window.kind === "unknown") {
      throw new ValidationError(
        "Run this profile once first so we know the booked appointment date, or set a latest date.",
      );
    }
    const others = (await this.listProfiles()).filter(
      (profile) => profile.enabled && profile.id !== candidate.id,
    );
    const names: string[] = [];
    for (const other of others) {
      const otherWindow = profileSearchWindow(other);
      if (otherWindow.kind === "unknown") continue;
      if (windowsOverlap(window, otherWindow)) names.push(other.name);
    }
    if (names.length) {
      throw new ValidationError(
        `Date window overlaps enabled profile${names.length > 1 ? "s" : ""} ${names.join(", ")}.`,
      );
    }
  }

  async createProfile(rawInput: ProfileInput): Promise<Profile> {
    const input = this.validateProfile(rawInput, true);
    if (input.enabled) {
      await this.assertCanEnable({
        ...input,
        currentAppointmentDate: null,
      });
    }
    const now = new Date().toISOString();

    let id: number;
    try {
      const result = await this.db.run(
        `INSERT INTO profile (name, visa_email, visa_password_enc, visa_process_id, email_destination,
           min_date, max_date, actions, enabled, created_at, updated_at)
         VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.name,
          input.visaEmail,
          input.visaProcessId,
          input.emailDestination,
          input.minDate,
          input.maxDate,
          input.actions.join(","),
          input.enabled ? 1 : 0,
          now,
          now,
        ],
      );
      id = result.lastID!;
    } catch (error) {
      throw this.translateConstraintError(error);
    }

    // The ciphertext is bound to the row id, so it can only be written once
    // the id is known.
    try {
      await this.db.run(
        "UPDATE profile SET visa_password_enc = ? WHERE id = ?",
        [this.box.encrypt(input.visaPassword!, profileSecretContext(id)), id],
      );
    } catch (error) {
      await this.db.run("DELETE FROM profile WHERE id = ?", [id]);
      throw error;
    }
    return (await this.getProfile(id))!;
  }

  async updateProfile(id: number, rawInput: ProfileInput): Promise<Profile> {
    const existing = await this.getProfile(id);
    if (!existing) {
      throw new ValidationError("Profile not found");
    }
    const input = this.validateProfile(rawInput, false);
    if (input.enabled) {
      await this.assertCanEnable({
        id,
        minDate: input.minDate,
        maxDate: input.maxDate,
        currentAppointmentDate: existing.currentAppointmentDate,
      });
    }

    try {
      await this.db.run(
        `UPDATE profile SET name = ?, visa_email = ?, visa_process_id = ?, email_destination = ?,
           min_date = ?, max_date = ?, actions = ?, enabled = ?,
           updated_at = ?
         WHERE id = ?`,
        [
          input.name,
          input.visaEmail,
          input.visaProcessId,
          input.emailDestination,
          input.minDate,
          input.maxDate,
          input.actions.join(","),
          input.enabled ? 1 : 0,
          new Date().toISOString(),
          id,
        ],
      );
    } catch (error) {
      throw this.translateConstraintError(error);
    }

    if (input.visaPassword) {
      await this.db.run(
        "UPDATE profile SET visa_password_enc = ? WHERE id = ?",
        [this.box.encrypt(input.visaPassword, profileSecretContext(id)), id],
      );
    }
    return (await this.getProfile(id))!;
  }

  async setProfileEnabled(id: number, enabled: boolean): Promise<void> {
    if (enabled) {
      const profile = await this.getProfile(id);
      if (!profile) throw new ValidationError("Profile not found");
      await this.assertCanEnable(profile);
    }
    await this.db.run(
      "UPDATE profile SET enabled = ?, updated_at = ? WHERE id = ?",
      [enabled ? 1 : 0, new Date().toISOString(), id],
    );
  }

  async setCurrentAppointmentDate(
    id: number,
    date: string | null,
  ): Promise<void> {
    await this.db.run(
      "UPDATE profile SET current_appointment_date = ?, updated_at = ? WHERE id = ?",
      [date, new Date().toISOString(), id],
    );
  }

  async deleteProfile(id: number): Promise<void> {
    await this.db.run("DELETE FROM run WHERE profile_id = ?", [id]);
    await this.db.run("DELETE FROM profile WHERE id = ?", [id]);
  }

  private translateConstraintError(error: unknown): unknown {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      if (error.message.includes("visa_process_id")) {
        return new ValidationError(
          "A profile with that visa process ID already exists",
        );
      }
      return new ValidationError("A profile with that name already exists");
    }
    return error;
  }

  // ---- Runs & logs ----

  async createRun(profileId: number, trigger: string): Promise<number> {
    const result = await this.db.run(
      "INSERT INTO run (profile_id, trigger, status, started_at) VALUES (?, ?, 'running', ?)",
      [profileId, trigger, new Date().toISOString()],
    );
    return result.lastID!;
  }

  async finishRun(
    runId: number,
    status: RunStatus,
    exitCode: number | null,
    output: string,
    result: BotResult | null = null,
  ): Promise<void> {
    await this.db.run(
      "UPDATE run SET status = ?, exit_code = ?, output = ?, result = ?, finished_at = ? WHERE id = ?",
      [
        status,
        exitCode,
        output.slice(-RUN_OUTPUT_LIMIT),
        result ? JSON.stringify(result) : null,
        new Date().toISOString(),
        runId,
      ],
    );
  }

  async markStaleRunsInterrupted(): Promise<void> {
    await this.db.run(
      "UPDATE run SET status = 'interrupted', finished_at = ? WHERE status = 'running'",
      [new Date().toISOString()],
    );
  }

  async pruneRuns(): Promise<void> {
    const cutoff = new Date(
      Date.now() - RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    await this.db.run("DELETE FROM run WHERE started_at < ?", [cutoff]);
  }

  async getLatestRuns(): Promise<Map<number, Run>> {
    const rows = await this.db.all(
      `SELECT r.* FROM run r
       JOIN (SELECT profile_id, MAX(id) AS id FROM run GROUP BY profile_id) latest
         ON latest.id = r.id`,
    );
    return new Map(rows.map((row) => [row.profile_id, this.toRun(row)]));
  }

  async listRuns(profileId: number, limit: number): Promise<Run[]> {
    const rows = await this.db.all(
      "SELECT * FROM run WHERE profile_id = ? ORDER BY id DESC LIMIT ?",
      [profileId, limit],
    );
    return rows.map((row) => this.toRun(row));
  }

  async getRun(runId: number): Promise<Run | undefined> {
    const row = await this.db.get("SELECT * FROM run WHERE id = ?", [runId]);
    return row ? this.toRun(row, true) : undefined;
  }

  private toRun(row: any, withOutput = false): Run {
    let result: BotResult | null = null;
    if (row.result) {
      try {
        result = normalizeBotResult(JSON.parse(row.result));
      } catch {
        result = null;
      }
    }
    return {
      id: row.id,
      profileId: row.profile_id,
      trigger: row.trigger,
      status: row.status,
      exitCode: row.exit_code,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      result,
      ...(withOutput ? { output: row.output } : {}),
    };
  }

  async appendLog(processId: string, message: string): Promise<void> {
    await this.db.run("INSERT INTO log (visa_process_id, message) VALUES (?, ?)", [
      processId,
      message,
    ]);
  }

  async getLastLogMessages(): Promise<
    Map<string, { timestamp: string; message: string }>
  > {
    const rows = await this.db.all(
      `SELECT l.visa_process_id, l.timestamp, l.message FROM log l
       JOIN (SELECT visa_process_id, MAX(id) AS id FROM log
             WHERE visa_process_id IN (SELECT visa_process_id FROM profile)
             GROUP BY visa_process_id) latest
         ON latest.id = l.id`,
    );
    return new Map(
      rows.map((row) => [
        String(row.visa_process_id),
        { timestamp: row.timestamp, message: row.message },
      ]),
    );
  }

  async listLogs(
    processId: string,
    limit: number,
  ): Promise<{ id: number; timestamp: string; message: string }[]> {
    return this.db.all(
      "SELECT id, timestamp, message FROM log WHERE visa_process_id = ? ORDER BY id DESC LIMIT ?",
      [processId, limit],
    );
  }
}
