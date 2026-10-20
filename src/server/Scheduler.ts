import { ChildProcess, spawn } from "child_process";
import path from "path";
import { parseVisaResult } from "../botResult";
import { maybeSendFailureAlarm } from "./failureAlarm";
import { sendHeartbeat } from "./heartbeat";
import { Profile, RunStatus, Store } from "./Store";

const TICK_MS = 15 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const KILL_GRACE_MS = 10 * 1000;
const OUTPUT_BUFFER_LIMIT = 256 * 1024;

// Only these variables are inherited by runner processes. In particular the
// master key path and anything else in the server environment is not.
const INHERITED_ENV = ["PATH", "HOME", "TZ", "LANG", "PLAYWRIGHT_BROWSERS_PATH"];

const RUNNER_PATH = path.resolve(__dirname, "..", "index.js");

interface ActiveRun {
  runId: number;
  child: ChildProcess;
  cancelled: boolean;
  debug: boolean;
}

export type ProfileState = "running" | "queued" | "idle";

export class Scheduler {
  private readonly store: Store;
  private readonly active = new Map<number, ActiveRun>();
  private queue: { profileId: number; trigger: string; enqueuedAt: number }[] = [];
  private draining: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private lastPrune = 0;
  private heartbeatInFlight = false;

  constructor(store: Store) {
    this.store = store;
  }

  async start(): Promise<void> {
    await this.store.markStaleRunsInterrupted();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.queue = [];
    const finished = [...this.active.values()].map(
      (run) => new Promise((resolve) => run.child.once("close", resolve)),
    );
    for (const run of this.active.values()) {
      run.cancelled = true;
      this.signal(run.child, "SIGTERM");
    }
    await Promise.race([
      Promise.all(finished),
      new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS)),
    ]);
  }

  getState(profileId: number): ProfileState {
    if (this.active.has(profileId)) return "running";
    if (this.queue.some((item) => item.profileId === profileId)) return "queued";
    return "idle";
  }

  /** Returns false when the profile is already running or queued. */
  enqueue(profileId: number, trigger: string): boolean {
    if (this.getState(profileId) !== "idle") return false;
    this.queue.push({ profileId, trigger, enqueuedAt: Date.now() });
    this.drain();
    return true;
  }

  /**
   * When this enabled profile is next due: last run start + Check every.
   * Never-run profiles are due immediately. Disabled profiles have no next run.
   */
  static nextRunAt(
    enabled: boolean,
    lastStartedAt: string | null | undefined,
    intervalMs: number,
    now = Date.now(),
  ): string | null {
    if (!enabled) return null;
    const started = lastStartedAt ? Date.parse(lastStartedAt) : NaN;
    if (!Number.isFinite(started)) return new Date(now).toISOString();
    return new Date(started + intervalMs).toISOString();
  }

  /**
   * True when this profile is occupying the queue longer than the check
   * interval: still running past intervalMinutes, or waiting in queue that long.
   */
  isBehind(
    profileId: number,
    lastStartedAt: string | null | undefined,
    intervalMs: number,
  ): { behind: boolean; elapsedMs: number } {
    const now = Date.now();
    if (this.active.has(profileId)) {
      const started = lastStartedAt ? Date.parse(lastStartedAt) : NaN;
      const elapsedMs = Number.isFinite(started) ? now - started : 0;
      return { behind: elapsedMs > intervalMs, elapsedMs };
    }
    const item = this.queue.find((entry) => entry.profileId === profileId);
    if (!item) return { behind: false, elapsedMs: 0 };
    const elapsedMs = now - item.enqueuedAt;
    return { behind: elapsedMs > intervalMs, elapsedMs };
  }

  cancel(profileId: number): boolean {
    const queuedBefore = this.queue.length;
    this.queue = this.queue.filter((item) => item.profileId !== profileId);
    const run = this.active.get(profileId);
    if (run) {
      run.cancelled = true;
      this.signal(run.child, "SIGTERM");
      return true;
    }
    return this.queue.length !== queuedBefore;
  }

  private async tick(): Promise<void> {
    try {
      if (Date.now() - this.lastPrune > PRUNE_EVERY_MS) {
        this.lastPrune = Date.now();
        await this.store.pruneRuns();
      }

      const [profiles, latestRuns, settings] = await Promise.all([
        this.store.listProfiles(),
        this.store.getLatestRuns(),
        this.store.getSettings(),
      ]);
      const intervalMs = settings.intervalMinutes * 60 * 1000;
      for (const profile of profiles) {
        if (!profile.enabled) continue;
        const lastStart = latestRuns.get(profile.id)?.startedAt;
        const due =
          !lastStart || Date.now() - +new Date(lastStart) >= intervalMs;
        if (due) this.enqueue(profile.id, "schedule");
      }
    } catch (error) {
      console.error("Scheduler tick failed:", error);
    }
    void this.maybeHeartbeat();
  }

  private async maybeHeartbeat(): Promise<void> {
    if (this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    try {
      await sendHeartbeat(this.store);
    } catch (error) {
      console.error("Heartbeat failed:", error);
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  // Serialized so concurrent callers can't exceed the concurrency limit while
  // a launch is awaiting the database.
  private drain(): void {
    this.draining = this.draining.then(async () => {
      try {
        const { maxConcurrentRuns } = await this.store.getSettings();
        while (this.queue.length && this.active.size < maxConcurrentRuns) {
          const item = this.queue.shift()!;
          await this.launch(item.profileId, item.trigger);
        }
      } catch (error) {
        console.error("Failed to start queued runs:", error);
      }
    });
  }

  private async launch(profileId: number, trigger: string): Promise<void> {
    const profile = await this.store.getProfile(profileId);
    if (!profile) return;

    const runId = await this.store.createRun(profileId, trigger);
    let env: NodeJS.ProcessEnv;
    try {
      env = await this.buildEnv(profile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.finishRun(runId, "failed", null, `${message}\n`);
      this.queueFailureAlarm(profileId, "failed", null);
      return;
    }

    const { runTimeoutMinutes, botDebug } = await this.store.getSettings();
    const child = spawn(process.execPath, this.buildArgs(profile, botDebug), {
      env,
      cwd: path.resolve(__dirname, "..", ".."),
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so cancelling also kills the Chromium children.
      detached: true,
    });

    const run: ActiveRun = { runId, child, cancelled: false, debug: botDebug };
    this.active.set(profileId, run);

    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-OUTPUT_BUFFER_LIMIT);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-OUTPUT_BUFFER_LIMIT);
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      this.signal(child, "SIGTERM");
      setTimeout(() => this.signal(child, "SIGKILL"), KILL_GRACE_MS).unref();
    }, runTimeoutMinutes * 60 * 1000);

    let finished = false;
    const finish = async (exitCode: number | null, extra = "") => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      this.active.delete(profileId);

      let status: RunStatus = exitCode === 0 ? "success" : "failed";
      if (run.cancelled) status = "cancelled";
      else if (timedOut) status = "timeout";

      const output = (run.debug ? stderr : "") + extra;
      const parsed = parseVisaResult(stdout);
      if (parsed?.outcome === "error" && status === "success") {
        status = "failed";
      }

      try {
        await this.store.finishRun(runId, status, exitCode, output, parsed);
        if (parsed?.currentAppointment) {
          await this.store.setCurrentAppointmentDate(
            profileId,
            parsed.currentAppointment,
          );
        }
        this.queueFailureAlarm(profileId, status, parsed);
      } catch (error) {
        console.error(`Failed to record run ${runId}:`, error);
      }
      this.drain();
    };

    child.on("error", (error) => finish(null, `\n${error.message}\n`));
    child.on("close", (code) => finish(code));
  }

  private async buildEnv(profile: Profile): Promise<NodeJS.ProcessEnv> {
    const settings = await this.store.getSettings();
    const env: NodeJS.ProcessEnv = {};
    for (const key of INHERITED_ENV) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }

    return {
      ...env,
      VISA_USER_EMAIL: profile.visaEmail,
      VISA_USER_PASSWORD: await this.store.getVisaPassword(profile.id),
      VISA_PROCESS_ID: profile.visaProcessId,
      EMAIL_DESTINATION: profile.emailDestination,
      EMAIL_ADMIN_DESTINATION: settings.emailAdminDestination,
      GMAIL_APP_USER: settings.gmailUser,
      GMAIL_APP_PASSWORD: await this.store.getGmailAppPassword(),
    };
  }

  private buildArgs(profile: Profile, debug: boolean): string[] {
    const args = [RUNNER_PATH, "--headless"];
    for (const action of profile.actions) {
      args.push(`--action=${action}`);
    }
    // The runner accepts YYYY-MM-DD as well as MM/DD/YYYY.
    if (profile.minDate) args.push(`--minDate=${profile.minDate}`);
    if (profile.maxDate) args.push(`--maxDate=${profile.maxDate}`);
    if (debug) args.push("--debug");
    return args;
  }

  private queueFailureAlarm(
    profileId: number,
    status: RunStatus,
    result: ReturnType<typeof parseVisaResult>,
  ): void {
    void maybeSendFailureAlarm(this.store, profileId, status, result).catch(
      (error) => {
        console.error(`Failure alarm failed for profile ${profileId}:`, error);
      },
    );
  }

  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined || child.exitCode !== null) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }
}
