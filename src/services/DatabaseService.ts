import { Database } from "sqlite";
import sqlite3 from "sqlite3";

export class DatabaseService {
  private db: Database<sqlite3.Database, sqlite3.Statement>;

  constructor(db: Database<sqlite3.Database, sqlite3.Statement>) {
    this.db = db;
  }

  async initialize(): Promise<void> {
    await this.db.run(
      `
      CREATE TABLE IF NOT EXISTS 
      log (
        id INTEGER PRIMARY KEY,
        timestamp DATE DEFAULT (datetime('now','localtime')),
        visa_process_id INTEGER,
        message TEXT
      );
    `,
    );

    await this.db.run(
      `
      CREATE TABLE IF NOT EXISTS 
      heartbeat_notification (
        id INTEGER PRIMARY KEY,
        timestamp DATE DEFAULT (datetime('now','localtime')),
        visa_process_id INTEGER
      );
    `,
    );
  }

  async log(message: string, error = false): Promise<void> {
    await this.db.run("INSERT INTO log (visa_process_id, message) VALUES (?, ?)", [
      process.env.VISA_PROCESS_ID,
      message,
    ]);

    console[error ? "error" : "log"](message);
  }

  async claimHeartbeatIfDue(
    intervalMinutes: number,
    force = false,
  ): Promise<boolean> {
    await this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!force) {
        const last = await this.db.get<{ timestamp: string }>(
          "SELECT timestamp FROM heartbeat_notification ORDER BY id DESC LIMIT 1",
        );
        if (last) {
          const elapsedMinutes = Math.floor(
            (Date.now() - +new Date(last.timestamp)) / 60000,
          );
          if (elapsedMinutes < intervalMinutes) {
            await this.db.exec("COMMIT");
            return false;
          }
        }
      }
      await this.db.run(
        "INSERT INTO heartbeat_notification (visa_process_id) VALUES (?)",
        [process.env.VISA_PROCESS_ID ?? null],
      );
      await this.db.exec("COMMIT");
      return true;
    } catch (error) {
      try {
        await this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw error;
    }
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

  async close(): Promise<void> {
    await this.db.close();
  }
}

