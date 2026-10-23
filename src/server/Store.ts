import crypto from "crypto";
import fs from "fs";
import sqlite3 from "sqlite3";
import { Database, open } from "sqlite";
import {
  BotResult,
  normalizeBotResult,
  profileSearchWindow,
  windowsOverlap,
  type RescheduleLimit,
} from "../botResult";
import { Action } from "../types";
import { SecretBox } from "./SecretBox";
import { INTAKE_WINDOW_MS } from "./intakeSchedule";
import {
  configuredOpenwaBaseUrl,
  parseIntakePhone,
  parseWhatsAppDestinations,
} from "./whatsapp";

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
  whatsappDestination: string;
  minDate: string | null;
  maxDate: string | null;
  actions: Action[];
  enabled: boolean;
}

export type IntakeStatus = "ready" | "pending" | "expired";

export interface Profile
  extends Omit<ProfileInput, "visaPassword" | "visaProcessId"> {
  id: number;
  /** Null while a WhatsApp intake has not been filled in yet. */
  visaProcessId: string | null;
  hasPassword: boolean;
  contactPhone: string;
  intakeStatus: IntakeStatus;
  intakeError: string | null;
  /** First prompt time. Polls read messages from here. */
  intakePromptMs: number | null;
  /** Start of the current 24-hour watch. Resend moves this forward. */
  intakeWindowStartedMs: number | null;
  intakeLastPollMs: number | null;
  intakeExpiresAt: string | null;
  currentAppointmentDate: string | null;
  /** Canonical AIS visa-class multiset, e.g. "H1B1x1,H4x4". */
  visaFingerprint: string | null;
  rescheduleRemaining: number | null;
  rescheduleMaximum: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  gmailUser: string;
  hasGmailAppPassword: boolean;
  emailAdminDestination: string;
  emailEnabled: boolean;
  openwaSessionId: string;
  whatsappGatewayReady: boolean;
  whatsappAdminDestination: string;
  whatsappEnabled: boolean;
  intervalMinutes: number;
  heartbeatEnabled: boolean;
  heartbeatMinutes: number;
  heartbeatTimeUtc: string;
  lastHeartbeatAt: string | null;
  maxConcurrentRuns: number;
  runTimeoutMinutes: number;
  failureAlarmThreshold: number;
  botDebug: boolean;
}

export interface SettingsInput
  extends Omit<
    Settings,
    | "hasGmailAppPassword"
    | "whatsappGatewayReady"
    | "lastHeartbeatAt"
    | "heartbeatMinutes"
    | "heartbeatTimeUtc"
  > {
  gmailAppPassword?: string;
  /** Kept for older clients. Scheduling uses heartbeatTimeUtc instead. */
  heartbeatMinutes?: number;
  /** HH:MM in UTC. Empty or omitted keeps the stored value; blank string stores 00:00. */
  heartbeatTimeUtc?: string;
}

export type NotificationKind =
  | "appointment"
  | "heartbeat"
  | "failure"
  | "test"
  | "intake";
export type NotificationStatus = "sent" | "failed" | "skipped";

export interface NotificationInput {
  kind: NotificationKind;
  channel?: string;
  status: NotificationStatus;
  profileId?: number | null;
  runId?: number | null;
  recipients: string;
  subject: string;
  summary: string;
  error?: string | null;
  dedupeKey?: string | null;
}

export interface NotificationRecord {
  id: number;
  sentAt: string;
  kind: NotificationKind;
  channel: string;
  status: NotificationStatus;
  profileId: number | null;
  profileName: string | null;
  runId: number | null;
  recipients: string;
  subject: string;
  summary: string;
  error: string | null;
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
  profileName: string | null;
  trigger: string;
  status: RunStatus;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  result: BotResult | null;
  output?: string;
}

export function isFailureRun(run: Pick<Run, "status" | "result">): boolean {
  if (run.status === "cancelled" || run.status === "running") return false;
  if (run.result?.outcome === "error") return true;
  return run.status === "failed" || run.status === "timeout" || run.status === "interrupted";
}

function integerOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

function epochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

function parseSkipMessageIds(value: unknown): string[] {
  if (!value || typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item)).filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeHeartbeatTimeUtc(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "00:00";
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match) {
    throw new ValidationError("Heartbeat time must be HH:MM in UTC");
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new ValidationError("Heartbeat time must be HH:MM in UTC");
  }
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
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
  email_enabled: "1",
  openwa_session_id: "",
  whatsapp_admin_destination: "",
  whatsapp_enabled: "1",
  interval_minutes: "5",
  heartbeat_enabled: "1",
  heartbeat_minutes: "1440",
  heartbeat_time_utc: "00:00",
  max_concurrent_runs: "2",
  run_timeout_minutes: "5",
  failure_alarm_threshold: "3",
  bot_debug: "0",
};

const profileSecretContext = (id: number) => `profile:${id}:visa_password`;
const GMAIL_SECRET_CONTEXT = "setting:gmail_app_password";

function readOpenwaApiKeyFile(): string {
  const file = process.env.OPENWA_API_KEY_FILE?.trim();
  if (!file) return "";
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

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
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS profile (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        visa_email TEXT NOT NULL,
        visa_password_enc TEXT NOT NULL,
        visa_process_id TEXT NOT NULL,
        email_destination TEXT NOT NULL DEFAULT '',
        whatsapp_destination TEXT NOT NULL DEFAULT '',
        min_date TEXT,
        max_date TEXT,
        actions TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 0,
        current_appointment_date TEXT,
        reschedule_remaining INTEGER,
        reschedule_maximum INTEGER,
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

      CREATE TABLE IF NOT EXISTS log (
        id INTEGER PRIMARY KEY,
        timestamp DATE DEFAULT (datetime('now','localtime')),
        visa_process_id INTEGER,
        message TEXT
      );

      CREATE TABLE IF NOT EXISTS heartbeat_notification (
        id INTEGER PRIMARY KEY,
        timestamp DATE DEFAULT (datetime('now','localtime')),
        visa_process_id INTEGER
      );

      CREATE TABLE IF NOT EXISTS notification (
        id INTEGER PRIMARY KEY,
        sent_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'email',
        status TEXT NOT NULL,
        profile_id INTEGER,
        run_id INTEGER,
        recipients TEXT NOT NULL DEFAULT '',
        subject TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        error TEXT,
        dedupe_key TEXT
      );

      CREATE INDEX IF NOT EXISTS run_profile_idx ON run (profile_id, id);
      CREATE INDEX IF NOT EXISTS log_process_idx ON log (visa_process_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS profile_process_idx
        ON profile (visa_process_id);
      CREATE INDEX IF NOT EXISTS notification_sent_idx ON notification (id DESC);
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
    if (
      !profileColumns.some((column) => column.name === "reschedule_remaining")
    ) {
      await this.db.exec(
        "ALTER TABLE profile ADD COLUMN reschedule_remaining INTEGER",
      );
    }
    if (
      !profileColumns.some((column) => column.name === "reschedule_maximum")
    ) {
      await this.db.exec(
        "ALTER TABLE profile ADD COLUMN reschedule_maximum INTEGER",
      );
    }
    if (
      !profileColumns.some((column) => column.name === "whatsapp_destination")
    ) {
      await this.db.exec(
        "ALTER TABLE profile ADD COLUMN whatsapp_destination TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!profileColumns.some((column) => column.name === "visa_fingerprint")) {
      await this.db.exec(
        "ALTER TABLE profile ADD COLUMN visa_fingerprint TEXT",
      );
    }
    const ensureColumn = async (name: string, ddl: string) => {
      const latest: { name: string }[] = await this.db.all(
        "PRAGMA table_info(profile)",
      );
      if (!latest.some((column) => column.name === name)) {
        await this.db.exec(`ALTER TABLE profile ADD COLUMN ${ddl}`);
      }
    };
    await ensureColumn(
      "contact_phone",
      "contact_phone TEXT NOT NULL DEFAULT ''",
    );
    await ensureColumn(
      "intake_status",
      "intake_status TEXT NOT NULL DEFAULT 'ready'",
    );
    await ensureColumn("intake_prompt_ms", "intake_prompt_ms INTEGER");
    await ensureColumn(
      "intake_window_started_ms",
      "intake_window_started_ms INTEGER",
    );
    await ensureColumn("intake_last_poll_ms", "intake_last_poll_ms INTEGER");
    await ensureColumn("intake_error", "intake_error TEXT");
    await ensureColumn(
      "intake_skip_message_ids",
      "intake_skip_message_ids TEXT NOT NULL DEFAULT ''",
    );
    // 1 for existing rows so a migration does not text people about old profiles.
    await ensureColumn(
      "intake_confirmed",
      "intake_confirmed INTEGER NOT NULL DEFAULT 1",
    );
    await this.relaxProfileVisaColumns();

    const runColumns: { name: string }[] = await this.db.all(
      "PRAGMA table_info(run)",
    );
    if (!runColumns.some((column) => column.name === "result")) {
      await this.db.exec("ALTER TABLE run ADD COLUMN result TEXT");
    }

    const notificationColumns: { name: string }[] = await this.db.all(
      "PRAGMA table_info(notification)",
    );
    if (
      !notificationColumns.some((column) => column.name === "dedupe_key")
    ) {
      await this.db.exec("ALTER TABLE notification ADD COLUMN dedupe_key TEXT");
    }

    await this.db.run(
      "DELETE FROM setting WHERE key IN ('openwa_base_url', 'openwa_api_key')",
    );

    await this.verifyMasterKey();
  }

  /**
   * Pending intakes have no visa email or process id yet. SQLite cannot
   * alter nullability, so copy the table once when those columns are NOT NULL.
   */
  private async relaxProfileVisaColumns(): Promise<void> {
    const columns: { name: string; notnull: number }[] = await this.db.all(
      "PRAGMA table_info(profile)",
    );
    const email = columns.find((column) => column.name === "visa_email");
    const processId = columns.find((column) => column.name === "visa_process_id");
    if (!email?.notnull && !processId?.notnull) return;

    await this.db.exec("BEGIN IMMEDIATE");
    try {
      await this.db.exec(`
        CREATE TABLE profile_next (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          visa_email TEXT,
          visa_password_enc TEXT NOT NULL DEFAULT '',
          visa_process_id TEXT,
          email_destination TEXT NOT NULL DEFAULT '',
          whatsapp_destination TEXT NOT NULL DEFAULT '',
          min_date TEXT,
          max_date TEXT,
          actions TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 0,
          current_appointment_date TEXT,
          reschedule_remaining INTEGER,
          reschedule_maximum INTEGER,
          visa_fingerprint TEXT,
          contact_phone TEXT NOT NULL DEFAULT '',
          intake_status TEXT NOT NULL DEFAULT 'ready',
          intake_prompt_ms INTEGER,
          intake_window_started_ms INTEGER,
          intake_last_poll_ms INTEGER,
          intake_error TEXT,
          intake_skip_message_ids TEXT NOT NULL DEFAULT '',
          intake_confirmed INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO profile_next (
          id, name, visa_email, visa_password_enc, visa_process_id, email_destination,
          whatsapp_destination, min_date, max_date, actions, enabled,
          current_appointment_date, reschedule_remaining, reschedule_maximum,
          visa_fingerprint, contact_phone, intake_status, intake_prompt_ms,
          intake_window_started_ms, intake_last_poll_ms, intake_error,
          intake_skip_message_ids, intake_confirmed, created_at, updated_at
        )
        SELECT
          id, name, visa_email, visa_password_enc, visa_process_id, email_destination,
          whatsapp_destination, min_date, max_date, actions, enabled,
          current_appointment_date, reschedule_remaining, reschedule_maximum,
          visa_fingerprint, contact_phone, intake_status, intake_prompt_ms,
          intake_window_started_ms, intake_last_poll_ms, intake_error,
          intake_skip_message_ids, intake_confirmed, created_at, updated_at
        FROM profile;
        DROP TABLE profile;
        ALTER TABLE profile_next RENAME TO profile;
        CREATE UNIQUE INDEX profile_process_idx ON profile (visa_process_id);
      `);
      await this.db.exec("COMMIT");
    } catch (error) {
      try {
        await this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw error;
    }
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
      emailEnabled: (await this.getSetting("email_enabled")) === "1",
      openwaSessionId: await this.getSetting("openwa_session_id"),
      whatsappGatewayReady: !!(
        configuredOpenwaBaseUrl() && readOpenwaApiKeyFile()
      ),
      whatsappAdminDestination: await this.getSetting(
        "whatsapp_admin_destination",
      ),
      whatsappEnabled: (await this.getSetting("whatsapp_enabled")) === "1",
      intervalMinutes: Number(await this.getSetting("interval_minutes")),
      heartbeatEnabled: (await this.getSetting("heartbeat_enabled")) === "1",
      heartbeatMinutes: Number(await this.getSetting("heartbeat_minutes")),
      heartbeatTimeUtc: await this.getSetting("heartbeat_time_utc"),
      lastHeartbeatAt: await this.getLastHeartbeatAt(),
      maxConcurrentRuns: Number(await this.getSetting("max_concurrent_runs")),
      runTimeoutMinutes: Number(await this.getSetting("run_timeout_minutes")),
      failureAlarmThreshold: Number(await this.getSetting("failure_alarm_threshold")),
      botDebug: (await this.getSetting("bot_debug")) === "1",
    };
  }

  async updateSettings(input: SettingsInput): Promise<Settings> {
    const emailEnabled = input.emailEnabled !== false;
    const whatsappEnabled = input.whatsappEnabled !== false;
    if (!emailEnabled && !whatsappEnabled) {
      throw new ValidationError(
        "At least one notification method must stay enabled",
      );
    }

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
    await this.setRawSetting("email_enabled", emailEnabled ? "1" : "0");
    try {
      await this.setRawSetting(
        "whatsapp_admin_destination",
        parseWhatsAppDestinations(input.whatsappAdminDestination),
      );
    } catch (error) {
      throw new ValidationError(
        error instanceof Error ? error.message : String(error),
      );
    }
    await this.setRawSetting("whatsapp_enabled", whatsappEnabled ? "1" : "0");
    await this.setRawSetting(
      "openwa_session_id",
      String(input.openwaSessionId ?? "").trim(),
    );
    await this.setRawSetting(
      "interval_minutes",
      positiveInt(input.intervalMinutes, "Check interval"),
    );
    await this.setRawSetting(
      "heartbeat_enabled",
      input.heartbeatEnabled ? "1" : "0",
    );
    if (input.heartbeatMinutes !== undefined) {
      await this.setRawSetting(
        "heartbeat_minutes",
        positiveInt(input.heartbeatMinutes, "Heartbeat interval"),
      );
    }
    await this.setRawSetting(
      "heartbeat_time_utc",
      input.heartbeatTimeUtc === undefined
        ? await this.getSetting("heartbeat_time_utc")
        : normalizeHeartbeatTimeUtc(input.heartbeatTimeUtc),
    );
    await this.setRawSetting(
      "max_concurrent_runs",
      positiveInt(input.maxConcurrentRuns, "Max concurrent runs"),
    );
    await this.setRawSetting(
      "run_timeout_minutes",
      positiveInt(input.runTimeoutMinutes, "Run timeout"),
    );
    await this.setRawSetting(
      "failure_alarm_threshold",
      positiveInt(input.failureAlarmThreshold, "Failure alarm"),
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

  async getOpenwaApiKey(): Promise<string> {
    return readOpenwaApiKeyFile();
  }

  async setOpenwaSessionId(sessionId: string): Promise<void> {
    await this.setRawSetting("openwa_session_id", sessionId.trim());
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
    const intakeStatus: IntakeStatus =
      row.intake_status === "pending" || row.intake_status === "expired"
        ? row.intake_status
        : "ready";
    const intakeWindowStartedMs = epochMs(row.intake_window_started_ms);
    return {
      id: row.id,
      name: row.name,
      visaEmail: row.visa_email || "",
      visaProcessId: row.visa_process_id ?? null,
      emailDestination: row.email_destination,
      whatsappDestination: row.whatsapp_destination || "",
      minDate: row.min_date,
      maxDate: row.max_date,
      actions: row.actions ? (row.actions.split(",") as Action[]) : [],
      enabled: !!row.enabled,
      contactPhone: row.contact_phone || "",
      intakeStatus,
      intakeError: row.intake_error ?? null,
      intakePromptMs: epochMs(row.intake_prompt_ms),
      intakeWindowStartedMs,
      intakeLastPollMs: epochMs(row.intake_last_poll_ms),
      intakeExpiresAt:
        intakeWindowStartedMs == null
          ? null
          : new Date(intakeWindowStartedMs + INTAKE_WINDOW_MS).toISOString(),
      currentAppointmentDate: row.current_appointment_date ?? null,
      visaFingerprint: row.visa_fingerprint ?? null,
      rescheduleRemaining: integerOrNull(row.reschedule_remaining),
      rescheduleMaximum: integerOrNull(row.reschedule_maximum),
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
    const emailDestination = normalizeEmailList(input.emailDestination);
    let whatsappDestination = "";
    try {
      whatsappDestination = parseWhatsAppDestinations(
        input.whatsappDestination,
      );
    } catch (error) {
      throw new ValidationError(
        error instanceof Error ? error.message : String(error),
      );
    }
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
    if (
      actions.includes(Action.Notify) &&
      !emailDestination &&
      !whatsappDestination
    ) {
      throw new ValidationError(
        "Notify emails or WhatsApp numbers are required for notify action",
      );
    }

    return {
      name,
      visaEmail,
      visaPassword: input.visaPassword || undefined,
      visaProcessId,
      emailDestination,
      whatsappDestination,
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
    if (!row.visa_password_enc) return "";
    return this.box.decrypt(row.visa_password_enc, profileSecretContext(id));
  }

  async assertCanEnable(candidate: {
    id?: number;
    minDate: string | null;
    maxDate: string | null;
    currentAppointmentDate: string | null;
    visaFingerprint: string | null;
  }): Promise<void> {
    const window = profileSearchWindow(candidate);
    if (window.kind === "unknown") {
      throw new ValidationError(
        "No booked appointment on AIS and no latest date set. Set a latest date, or book an appointment first.",
      );
    }
    if (!candidate.visaFingerprint) {
      throw new ValidationError(
        "Visa class fingerprint is missing. Enable again so we can re-check AIS.",
      );
    }
    const others = (await this.listProfiles()).filter(
      (profile) => profile.enabled && profile.id !== candidate.id,
    );
    const names: string[] = [];
    for (const other of others) {
      const otherWindow = profileSearchWindow(other);
      if (otherWindow.kind === "unknown") continue;
      if (!windowsOverlap(window, otherWindow)) continue;
      // Same (or unknown peer) fingerprint hunting the same days — refuse.
      if (
        !other.visaFingerprint ||
        other.visaFingerprint === candidate.visaFingerprint
      ) {
        names.push(other.name);
      }
    }
    if (names.length) {
      throw new ValidationError(
        `Date window overlaps enabled profile${names.length > 1 ? "s" : ""} ${names.join(", ")} with the same visa classes (${candidate.visaFingerprint}).`,
      );
    }
  }

  /**
   * Insert always starts disabled. Callers that want enabled must probe AIS
   * then call setProfileEnabled(true).
   */
  async createProfile(rawInput: ProfileInput): Promise<Profile> {
    const input = this.validateProfile(rawInput, true);
    const now = new Date().toISOString();

    let id: number;
    try {
      const result = await this.db.run(
        `INSERT INTO profile (name, visa_email, visa_password_enc, visa_process_id, email_destination,
           whatsapp_destination, min_date, max_date, actions, enabled, created_at, updated_at)
         VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          input.name,
          input.visaEmail,
          input.visaProcessId,
          input.emailDestination,
          input.whatsappDestination,
          input.minDate,
          input.maxDate,
          input.actions.join(","),
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

  /** Name and phone only. The visa account stays empty until a reply arrives. */
  async createIntake(name: string, phone: string): Promise<Profile> {
    const trimmed = String(name ?? "").trim();
    if (!trimmed) throw new ValidationError("Name is required");
    let contactPhone = "";
    try {
      contactPhone = parseIntakePhone(phone);
    } catch (error) {
      throw new ValidationError(
        error instanceof Error ? error.message : String(error),
      );
    }
    const pending = await this.db.get<{ id: number }>(
      "SELECT id FROM profile WHERE contact_phone = ? AND intake_status = 'pending'",
      [contactPhone],
    );
    if (pending) {
      throw new ValidationError(
        "That phone number already has a profile waiting for WhatsApp",
      );
    }
    const now = new Date().toISOString();
    let id: number;
    try {
      const result = await this.db.run(
        `INSERT INTO profile (
           name, visa_email, visa_password_enc, visa_process_id, email_destination,
           whatsapp_destination, actions, enabled, contact_phone, intake_status,
           created_at, updated_at
         ) VALUES (?, NULL, '', NULL, '', '', '', 0, ?, 'pending', ?, ?)`,
        [trimmed, contactPhone, now, now],
      );
      id = result.lastID!;
    } catch (error) {
      throw this.translateConstraintError(error);
    }
    return (await this.getProfile(id))!;
  }

  /**
   * Record a successful prompt. The first prompt time stays put so earlier
   * replies are still visible. Resend restarts the 24-hour window.
   */
  async markIntakePromptSent(id: number, nowMs: number): Promise<void> {
    await this.db.run(
      `UPDATE profile SET
         intake_status = 'pending',
         intake_prompt_ms = COALESCE(intake_prompt_ms, ?),
         intake_window_started_ms = ?,
         intake_last_poll_ms = NULL,
         intake_error = NULL,
         updated_at = ?
       WHERE id = ?`,
      [nowMs, nowMs, new Date().toISOString(), id],
    );
  }

  async setIntakeError(id: number, error: string): Promise<void> {
    await this.db.run(
      "UPDATE profile SET intake_error = ?, updated_at = ? WHERE id = ?",
      [error, new Date().toISOString(), id],
    );
  }

  async setIntakeLastPoll(id: number, nowMs: number): Promise<void> {
    await this.db.run(
      "UPDATE profile SET intake_last_poll_ms = ? WHERE id = ? AND intake_status = 'pending'",
      [nowMs, id],
    );
  }

  async listPendingIntakes(): Promise<Profile[]> {
    const rows = await this.db.all(
      "SELECT * FROM profile WHERE intake_status = 'pending' ORDER BY id",
    );
    return rows.map((row) => this.toProfile(row));
  }

  async intakeSkipMessageIds(id: number): Promise<Set<string>> {
    const row = await this.db.get<{ intake_skip_message_ids: string }>(
      "SELECT intake_skip_message_ids FROM profile WHERE id = ?",
      [id],
    );
    return new Set(parseSkipMessageIds(row?.intake_skip_message_ids));
  }

  /** Remember a template reply that was answered, and show the problem on the row. */
  async rememberIntakeReply(
    id: number,
    messageId: string,
    error: string,
  ): Promise<void> {
    const ids = [...(await this.intakeSkipMessageIds(id))];
    if (!ids.includes(messageId)) ids.push(messageId);
    await this.db.run(
      `UPDATE profile SET intake_skip_message_ids = ?, intake_error = ?, updated_at = ?
       WHERE id = ? AND intake_status = 'pending'`,
      [JSON.stringify(ids.slice(-200)), error, new Date().toISOString(), id],
    );
  }

  async completeIntake(id: number, rawInput: ProfileInput): Promise<Profile> {
    const existing = await this.getProfile(id);
    if (!existing) throw new ValidationError("Profile not found");
    if (existing.intakeStatus !== "pending") {
      throw new ValidationError("Profile is no longer waiting for WhatsApp");
    }
    const input = this.validateProfile(rawInput, true);
    const password = this.box.encrypt(
      input.visaPassword!,
      profileSecretContext(id),
    );
    let changes = 0;
    try {
      const result = await this.db.run(
        `UPDATE profile SET
           visa_email = ?, visa_password_enc = ?, visa_process_id = ?,
           email_destination = ?, whatsapp_destination = ?, min_date = ?, max_date = ?,
           actions = ?, enabled = 0, intake_status = 'ready', intake_error = NULL,
           intake_confirmed = 0, updated_at = ?
         WHERE id = ? AND intake_status = 'pending'`,
        [
          input.visaEmail,
          password,
          input.visaProcessId,
          input.emailDestination,
          input.whatsappDestination,
          input.minDate,
          input.maxDate,
          input.actions.join(","),
          new Date().toISOString(),
          id,
        ],
      );
      changes = result.changes ?? 0;
    } catch (error) {
      throw this.translateConstraintError(error);
    }
    if (!changes) {
      throw new ValidationError("Profile is no longer waiting for WhatsApp");
    }
    return (await this.getProfile(id))!;
  }

  /**
   * Ready profiles that were filled from WhatsApp and are still disabled.
   * The contact phone has not yet been told that an admin must enable them.
   */
  async listProfilesAwaitingEnableNotice(): Promise<Profile[]> {
    const rows = await this.db.all(
      `SELECT * FROM profile
       WHERE intake_confirmed = 0
         AND intake_status = 'ready'
         AND enabled = 0
         AND contact_phone != ''
       ORDER BY id`,
    );
    return rows.map((row) => this.toProfile(row));
  }

  async markIntakeConfirmed(id: number): Promise<void> {
    await this.db.run(
      "UPDATE profile SET intake_confirmed = 1, updated_at = ? WHERE id = ?",
      [new Date().toISOString(), id],
    );
  }

  /** Stop watching. Returns false when the row was already finished or expired. */
  async expireIntake(id: number, error: string): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE profile SET intake_status = 'expired', intake_error = ?, updated_at = ?
       WHERE id = ? AND intake_status = 'pending'`,
      [error, new Date().toISOString(), id],
    );
    return (result.changes ?? 0) === 1;
  }

  /**
   * Updates fields. Enabling is left to the caller via setProfileEnabled after
   * an AIS probe when turning a profile on. Saving the full form finishes an
   * intake that was still waiting.
   */
  async updateProfile(id: number, rawInput: ProfileInput): Promise<Profile> {
    const existing = await this.getProfile(id);
    if (!existing) {
      throw new ValidationError("Profile not found");
    }
    const input = this.validateProfile(
      rawInput,
      existing.intakeStatus !== "ready" || !existing.hasPassword,
    );
    // Keep current enabled flag here; enable transitions go through probe.
    const enabled = existing.enabled && input.enabled;
    if (enabled) {
      await this.assertCanEnable({
        id,
        minDate: input.minDate,
        maxDate: input.maxDate,
        currentAppointmentDate: existing.currentAppointmentDate,
        visaFingerprint: existing.visaFingerprint,
      });
    }

    const queueEnableNotice =
      existing.intakeStatus !== "ready" && !enabled && !!existing.contactPhone;
    try {
      await this.db.run(
        `UPDATE profile SET name = ?, visa_email = ?, visa_process_id = ?, email_destination = ?,
           whatsapp_destination = ?, min_date = ?, max_date = ?, actions = ?, enabled = ?,
           intake_status = 'ready', intake_error = NULL,
           intake_confirmed = CASE WHEN ? = 1 THEN 0 ELSE intake_confirmed END,
           updated_at = ?
         WHERE id = ?`,
        [
          input.name,
          input.visaEmail,
          input.visaProcessId,
          input.emailDestination,
          input.whatsappDestination,
          input.minDate,
          input.maxDate,
          input.actions.join(","),
          enabled ? 1 : 0,
          queueEnableNotice ? 1 : 0,
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
      if (profile.intakeStatus !== "ready" || !profile.visaProcessId || !profile.hasPassword) {
        throw new ValidationError(
          "This profile is still waiting for visa account details",
        );
      }
      await this.assertCanEnable(profile);
    }
    await this.db.run(
      `UPDATE profile SET enabled = ?, updated_at = ?,
         intake_confirmed = CASE WHEN ? = 1 THEN 1 ELSE intake_confirmed END
       WHERE id = ?`,
      [enabled ? 1 : 0, new Date().toISOString(), enabled ? 1 : 0, id],
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

  async setVisaFingerprint(
    id: number,
    fingerprint: string | null,
  ): Promise<void> {
    await this.db.run(
      "UPDATE profile SET visa_fingerprint = ?, updated_at = ? WHERE id = ?",
      [fingerprint, new Date().toISOString(), id],
    );
  }

  async setRescheduleLimit(id: number, limit: RescheduleLimit): Promise<void> {
    await this.db.run(
      `UPDATE profile
       SET reschedule_remaining = ?, reschedule_maximum = ?, updated_at = ?
       WHERE id = ?`,
      [limit.remaining, limit.maximum, new Date().toISOString(), id],
    );
  }

  async deleteProfile(id: number): Promise<void> {
    await this.db.run("DELETE FROM run WHERE profile_id = ?", [id]);
    await this.db.run(
      "UPDATE notification SET profile_id = NULL, run_id = NULL WHERE profile_id = ?",
      [id],
    );
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

  async getProfilesWithSuccessfulRuns(): Promise<Set<number>> {
    const rows = (await this.db.all(
      "SELECT DISTINCT profile_id FROM run WHERE status = 'success'",
    )) as { profile_id: number }[];
    return new Set(rows.map((row) => row.profile_id));
  }

  async listRuns(
    profileId: number | null,
    limit: number,
    range: {
      from?: string;
      to?: string;
      notified?: boolean;
      order?: "asc" | "desc";
    } = {},
  ): Promise<Run[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (profileId != null) {
      clauses.push("r.profile_id = ?");
      params.push(profileId);
    }
    if (range.from) {
      clauses.push("r.started_at >= ?");
      params.push(range.from);
    }
    if (range.to) {
      clauses.push("r.started_at <= ?");
      params.push(range.to);
    }
    if (range.notified === true) {
      clauses.push("json_extract(r.result, '$.notified') = 1");
    } else if (range.notified === false) {
      clauses.push(
        "(r.result IS NULL OR json_extract(r.result, '$.notified') IS NOT 1)",
      );
    }
    params.push(limit);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.db.all(
      `SELECT r.*, p.name AS profile_name
       FROM run r
       LEFT JOIN profile p ON p.id = r.profile_id
       ${where}
       ORDER BY r.id DESC LIMIT ?`,
      params,
    );
    const runs = rows.map((row) => this.toRun(row));
    return range.order === "asc" ? runs.reverse() : runs;
  }

  async getNotifiedRange(
    profileId: number | null,
    range: { from?: string; to?: string } = {},
  ): Promise<{ count: number; firstAt: string | null; lastAt: string | null }> {
    const clauses = ["json_extract(result, '$.notified') = 1"];
    const params: unknown[] = [];
    if (profileId != null) {
      clauses.push("profile_id = ?");
      params.push(profileId);
    }
    if (range.from) {
      clauses.push("started_at >= ?");
      params.push(range.from);
    }
    if (range.to) {
      clauses.push("started_at <= ?");
      params.push(range.to);
    }
    const row = await this.db.get<{
      count: number;
      firstAt: string | null;
      lastAt: string | null;
    }>(
      `SELECT COUNT(*) AS count, MIN(started_at) AS firstAt, MAX(started_at) AS lastAt
       FROM run WHERE ${clauses.join(" AND ")}`,
      params,
    );
    return {
      count: Number(row?.count ?? 0),
      firstAt: row?.firstAt ?? null,
      lastAt: row?.lastAt ?? null,
    };
  }

  async countConsecutiveFailures(profileId: number): Promise<{
    count: number;
    errors: Run[];
  }> {
    const runs = await this.listRuns(profileId, 50);
    const errors: Run[] = [];
    for (const run of runs) {
      if (run.status === "cancelled" || run.status === "running") continue;
      if (!isFailureRun(run)) break;
      errors.push(run);
    }
    return { count: errors.length, errors };
  }

  async getRun(runId: number): Promise<Run | undefined> {
    const row = await this.db.get(
      `SELECT r.*, p.name AS profile_name
       FROM run r
       LEFT JOIN profile p ON p.id = r.profile_id
       WHERE r.id = ?`,
      [runId],
    );
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
      profileName: row.profile_name ?? null,
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

  // ---- Notifications ----

  async insertNotification(input: NotificationInput): Promise<number> {
    const result = await this.db.run(
      `INSERT INTO notification
         (sent_at, kind, channel, status, profile_id, run_id, recipients, subject, summary, error, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        new Date().toISOString(),
        input.kind,
        input.channel || "email",
        input.status,
        input.profileId ?? null,
        input.runId ?? null,
        input.recipients,
        input.subject,
        input.summary,
        input.error ?? null,
        input.dedupeKey ?? null,
      ],
    );
    return result.lastID!;
  }

  async listNotifications(
    limit: number,
    range: {
      from?: string;
      to?: string;
      kind?: NotificationKind;
      status?: NotificationStatus;
      channel?: string;
    } = {},
  ): Promise<NotificationRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (range.from) {
      clauses.push("n.sent_at >= ?");
      params.push(range.from);
    }
    if (range.to) {
      clauses.push("n.sent_at <= ?");
      params.push(range.to);
    }
    if (range.kind) {
      clauses.push("n.kind = ?");
      params.push(range.kind);
    }
    if (range.status) {
      clauses.push("n.status = ?");
      params.push(range.status);
    }
    if (range.channel) {
      clauses.push("n.channel = ?");
      params.push(range.channel);
    }
    params.push(limit);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.db.all(
      `SELECT n.*, p.name AS profile_name
       FROM notification n
       LEFT JOIN profile p ON p.id = n.profile_id
       ${where}
       ORDER BY n.id DESC
       LIMIT ?`,
      params,
    );
    return rows.map((row) => this.toNotification(row));
  }

  /**
   * Skip when the last successful appointment send for this profile and
   * channel used the same date list, and no later successful check found
   * zero matching dates. A failed send does not count. An error or timeout
   * does not reset the key.
   */
  async shouldSkipAppointmentDedupe(
    profileId: number,
    channel: string,
    datesKey: string,
  ): Promise<boolean> {
    const last = await this.db.get<{ sent_at: string; dedupe_key: string }>(
      `SELECT sent_at, dedupe_key FROM notification
       WHERE profile_id = ? AND kind = 'appointment' AND channel = ?
         AND status = 'sent'
         AND dedupe_key IS NOT NULL AND dedupe_key != ''
       ORDER BY id DESC LIMIT 1`,
      [profileId, channel],
    );
    if (!last || last.dedupe_key !== datesKey) return false;

    const gap = await this.db.get<{ id: number }>(
      `SELECT id FROM run
       WHERE profile_id = ?
         AND status = 'success'
         AND finished_at > ?
         AND json_extract(result, '$.outcome') = 'none'
       LIMIT 1`,
      [profileId, last.sent_at],
    );
    return !gap;
  }

  /**
   * Claim today's UTC heartbeat slot. A failed send keeps the next day's
   * clock time and only delays the retries for this slot.
   */
  async beginScheduledHeartbeat(
    slotIso: string,
    now: Date,
  ): Promise<{ send: true; attemptNumber: number } | { send: false }> {
    const maxAttempts = 4;
    await this.db.exec("BEGIN IMMEDIATE");
    try {
      const sentSlot = await this.getRawSetting("heartbeat_sent_slot");
      if (sentSlot === slotIso) {
        await this.db.exec("COMMIT");
        return { send: false };
      }
      const attemptSlot = await this.getRawSetting("heartbeat_attempt_slot");
      const sameSlot = attemptSlot === slotIso;
      const attempts = sameSlot
        ? Number(await this.getRawSetting("heartbeat_attempt_count")) || 0
        : 0;
      const nextAt = sameSlot
        ? await this.getRawSetting("heartbeat_next_attempt_at")
        : undefined;
      if (attempts >= maxAttempts) {
        await this.db.exec("COMMIT");
        return { send: false };
      }
      if (nextAt && Date.parse(nextAt) > now.getTime()) {
        await this.db.exec("COMMIT");
        return { send: false };
      }
      const lease = new Date(now.getTime() + 20 * 60000).toISOString();
      await this.setRawSetting("heartbeat_attempt_slot", slotIso);
      if (!sameSlot) {
        await this.setRawSetting("heartbeat_attempt_count", "0");
      }
      await this.setRawSetting("heartbeat_next_attempt_at", lease);
      await this.db.exec("COMMIT");
      return { send: true, attemptNumber: attempts + 1 };
    } catch (error) {
      try {
        await this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw error;
    }
  }

  async recordHeartbeatRetry(
    slotIso: string,
    attemptNumber: number,
    nextAttemptAt: string,
  ): Promise<void> {
    await this.setRawSetting("heartbeat_attempt_slot", slotIso);
    await this.setRawSetting("heartbeat_attempt_count", String(attemptNumber));
    await this.setRawSetting("heartbeat_next_attempt_at", nextAttemptAt);
  }

  async recordScheduledHeartbeatSent(slotIso: string): Promise<void> {
    await this.db.exec("BEGIN IMMEDIATE");
    try {
      await this.setRawSetting("heartbeat_sent_slot", slotIso);
      await this.setRawSetting("heartbeat_attempt_slot", slotIso);
      await this.setRawSetting("heartbeat_attempt_count", "0");
      await this.setRawSetting("heartbeat_next_attempt_at", "");
      await this.db.run(
        "INSERT INTO heartbeat_notification (visa_process_id) VALUES (?)",
        [null],
      );
      await this.db.exec("COMMIT");
    } catch (error) {
      try {
        await this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw error;
    }
  }

  async insertHeartbeatStamp(): Promise<void> {
    await this.db.run(
      "INSERT INTO heartbeat_notification (visa_process_id) VALUES (?)",
      [null],
    );
  }

  async getHeartbeatReport(): Promise<{
    enabledProfiles: { name: string; visaProcessId: string }[];
    recentRuns: { name: string; status: string; startedAt: string }[];
    anySuccess: boolean;
  }> {
    const enabledProfiles = (await this.db.all(
      "SELECT name, visa_process_id AS visaProcessId FROM profile WHERE enabled = 1 ORDER BY name",
    )) as { name: string; visaProcessId: string }[];
    const recentRuns = (await this.db.all(
      `SELECT p.name, r.status, r.started_at AS startedAt
       FROM run r
       JOIN profile p ON p.id = r.profile_id
       ORDER BY r.id DESC
       LIMIT 5`,
    )) as { name: string; status: string; startedAt: string }[];
    return {
      enabledProfiles,
      recentRuns,
      anySuccess: recentRuns.some((run) => run.status === "success"),
    };
  }

  private toNotification(row: any): NotificationRecord {
    const kind: NotificationKind =
      row.kind === "heartbeat" ||
      row.kind === "failure" ||
      row.kind === "test" ||
      row.kind === "intake"
        ? row.kind
        : "appointment";
    return {
      id: row.id,
      sentAt: row.sent_at,
      kind,
      channel: row.channel || "email",
      status:
        row.status === "failed" || row.status === "skipped"
          ? row.status
          : "sent",
      profileId: row.profile_id ?? null,
      profileName: row.profile_name ?? null,
      runId: row.run_id ?? null,
      recipients: row.recipients || "",
      subject: row.subject || "",
      summary: row.summary || "",
      error: row.error ?? null,
    };
  }
}
