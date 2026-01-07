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

  async getLastHeartbeatNotification(): Promise<any> {
    return await this.db.get(
      "SELECT * FROM heartbeat_notification WHERE visa_process_id = ? ORDER BY id DESC",
      [process.env.VISA_PROCESS_ID],
    );
  }

  async insertHeartbeatNotification(): Promise<void> {
    await this.db.run(
      "INSERT INTO heartbeat_notification (visa_process_id) VALUES (?)",
      [process.env.VISA_PROCESS_ID],
    );
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

