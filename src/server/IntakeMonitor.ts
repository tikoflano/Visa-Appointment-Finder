import { Action } from "../types";
import {
  intakeExpiredReply,
  intakeInvalidReply,
  intakePromptText,
  intakeSavedReply,
  parseIntakeReply,
  type IntakeReplyFields,
} from "./intakeReply";
import { INTAKE_WINDOW_MS, nextIntakePollAt } from "./intakeSchedule";
import { Notifier } from "./Notifier";
import { Profile, Store, ValidationError } from "./Store";
import {
  configuredOpenwaBaseUrl,
  OpenwaClient,
  openwaConfigured,
  WhatsAppService,
} from "./whatsapp";

const MIN_WAIT_MS = 1_000;
const IDLE_WAIT_MS = 60_000;

export class IntakeMonitor {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private running = false;
  private rerun = false;
  /** Profiles deleted while a poll is in flight. */
  private cancelled = new Set<number>();

  constructor(
    private readonly store: Store,
    private readonly notifier: Notifier,
  ) {}

  start(): void {
    this.stopped = false;
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Drop a profile from the poller immediately, including a poll already in flight. */
  cancel(id: number): void {
    this.cancelled.add(id);
    this.kick();
  }

  restore(id: number): void {
    this.cancelled.delete(id);
    this.kick();
  }

  /** Wake the loop soon, including after a new intake is created. */
  kick(): void {
    this.rerun = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.running && !this.stopped) void this.tick();
  }

  async sendPrompt(profile: Profile): Promise<void> {
    const now = Date.now();
    const whatsapp = await this.whatsapp();
    await whatsapp.sendText(
      profile.contactPhone,
      intakePromptText(),
      `intake-prompt:${profile.id}:${now}`,
    );
    await this.store.markIntakePromptSent(profile.id, now);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    let wait = IDLE_WAIT_MS;
    try {
      do {
        this.rerun = false;
        wait = await this.pollDue();
      } while (this.rerun && !this.stopped);
    } catch (error) {
      console.error(
        "WhatsApp intake poll failed:",
        error instanceof Error ? error.message : error,
      );
      wait = IDLE_WAIT_MS;
    } finally {
      this.running = false;
    }
    if (this.stopped) return;
    if (this.rerun) {
      void this.tick();
      return;
    }
    this.timer = setTimeout(() => void this.tick(), wait);
  }

  private async pollDue(): Promise<number> {
    await this.forgetCancelled();
    const noticeWait = await this.deliverEnableNotices();
    const pending = await this.store.listPendingIntakes();
    const now = Date.now();
    let soonest = now + (noticeWait ?? IDLE_WAIT_MS);
    for (const profile of pending) {
      if (profile.intakeWindowStartedMs == null) continue;
      const next = await this.advance(profile, now);
      if (next != null && next < soonest) soonest = next;
    }
    return Math.max(MIN_WAIT_MS, Math.min(IDLE_WAIT_MS, soonest - Date.now()));
  }

  /**
   * Poll when the schedule says this intake is due, then expire it once the
   * 24-hour window has no checks left.
   */
  private async advance(profile: Profile, now: number): Promise<number | null> {
    if (this.cancelled.has(profile.id)) return null;
    const started = profile.intakeWindowStartedMs;
    if (started == null) return null;
    let next = nextIntakePollAt(
      started,
      profile.intakeLastPollMs ?? started,
    );
    if (next != null && now >= next) {
      try {
        await this.pollProfile(profile);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`WhatsApp intake poll failed for profile ${profile.id}:`, message);
        await this.store.setIntakeError(profile.id, message);
      }
      if (this.cancelled.has(profile.id)) return null;
      await this.store.setIntakeLastPoll(profile.id, now);
      next = nextIntakePollAt(started, now);
    }
    if (this.cancelled.has(profile.id)) return null;
    if (next == null && now >= started + INTAKE_WINDOW_MS) {
      await this.expire(profile);
      return null;
    }
    return next;
  }

  private async pollProfile(profile: Profile): Promise<void> {
    const since = profile.intakePromptMs ?? profile.intakeWindowStartedMs;
    if (since == null || !profile.contactPhone) return;
    let whatsapp: WhatsAppService;
    let client: OpenwaClient;
    let sessionId: string;
    try {
      const gateway = await this.gateway();
      whatsapp = gateway.whatsapp;
      client = gateway.client;
      sessionId = gateway.sessionId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.setIntakeError(profile.id, message);
      return;
    }

    // Same-account replies are stored as outgoing, so this is not incoming-only.
    const messages = await client.listChatMessages(
      sessionId,
      profile.contactPhone,
      since,
    );
    if (this.cancelled.has(profile.id)) return;
    const skip = await this.store.intakeSkipMessageIds(profile.id);
    for (const message of messages) {
      if (this.cancelled.has(profile.id)) return;
      if (!message.body.trim() || skip.has(message.id)) continue;
      const parsed = parseIntakeReply(message.body);
      if (parsed.kind === "ignore") continue;
      if (parsed.kind === "invalid") {
        await this.reject(whatsapp, profile, message.id, parsed.problems);
        continue;
      }
      const saved = await this.tryComplete(
        whatsapp,
        profile,
        message.id,
        parsed.fields,
      );
      if (saved) return;
    }
  }

  private async tryComplete(
    whatsapp: WhatsAppService,
    profile: Profile,
    messageId: string,
    fields: IntakeReplyFields,
  ): Promise<boolean> {
    if (this.cancelled.has(profile.id)) return false;
    const notify =
      !!fields.emailDestination || !!fields.whatsappDestination;
    try {
      const saved = await this.store.completeIntake(profile.id, {
        name: profile.name,
        visaEmail: fields.visaEmail,
        visaPassword: fields.visaPassword,
        visaProcessId: fields.visaProcessId,
        emailDestination: fields.emailDestination,
        whatsappDestination: fields.whatsappDestination,
        minDate: fields.minDate,
        maxDate: fields.maxDate,
        actions: notify ? [Action.Notify] : [],
        enabled: false,
      });
      try {
        await this.sendEnableNotice(saved);
      } catch (error) {
        console.error(
          `Enable confirmation failed for profile ${profile.id}:`,
          error instanceof Error ? error.message : error,
        );
      }
      return true;
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      if (this.cancelled.has(profile.id)) return false;
      const still = await this.store.getProfile(profile.id);
      if (!still || still.intakeStatus !== "pending") return false;
      await this.reject(whatsapp, profile, messageId, [error.message]);
      return false;
    }
  }

  /**
   * Tell the intake phone the profile is saved and still disabled.
   * A failed send stays unconfirmed and is retried while the profile is off.
   */
  private async deliverEnableNotices(): Promise<number | null> {
    const waiting = await this.store.listProfilesAwaitingEnableNotice();
    if (!waiting.length) return null;
    let failed = false;
    for (const profile of waiting) {
      try {
        await this.sendEnableNotice(profile);
      } catch (error) {
        failed = true;
        console.error(
          `Enable confirmation failed for profile ${profile.id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return failed ? 15_000 : null;
  }

  private async sendEnableNotice(profile: Profile): Promise<void> {
    if (this.cancelled.has(profile.id) || !profile.contactPhone || profile.enabled) return;
    const current = await this.store.getProfile(profile.id);
    if (!current || this.cancelled.has(current.id) || current.enabled || !current.contactPhone) {
      return;
    }
    const whatsapp = await this.whatsapp();
    if (this.cancelled.has(current.id)) return;
    await whatsapp.sendText(
      current.contactPhone,
      intakeSavedReply(current.name),
      `intake-saved:${current.id}`,
    );
    if (this.cancelled.has(current.id)) return;
    await this.store.markIntakeConfirmed(current.id);
  }

  private async reject(
    whatsapp: WhatsAppService,
    profile: Profile,
    messageId: string,
    problems: string[],
  ): Promise<void> {
    if (this.cancelled.has(profile.id)) return;
    await whatsapp.sendText(
      profile.contactPhone,
      intakeInvalidReply(problems),
      `intake-invalid:${profile.id}:${messageId}`,
    );
    await this.store.rememberIntakeReply(
      profile.id,
      messageId,
      problems.join("; "),
    );
  }

  private async expire(profile: Profile): Promise<void> {
    if (this.cancelled.has(profile.id)) return;
    const notice = "Monitoring stopped after 24 hours with no valid reply";
    const changed = await this.store.expireIntake(profile.id, notice);
    if (!changed) return;
    try {
      const { whatsapp } = await this.gateway();
      await whatsapp.sendText(
        profile.contactPhone,
        intakeExpiredReply(profile.name),
        `intake-expired:${profile.id}:user`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Intake stop notice failed for profile ${profile.id}:`,
        message,
      );
      await this.store.setIntakeError(profile.id, `${notice}. ${message}`);
    }
    await this.notifier.notifyIntakeExpired(profile);
  }

  private async forgetCancelled(): Promise<void> {
    for (const id of this.cancelled) {
      const profile = await this.store.getProfile(id);
      if (!profile) this.cancelled.delete(id);
    }
  }

  private async gateway(): Promise<{
    whatsapp: WhatsAppService;
    client: OpenwaClient;
    sessionId: string;
  }> {
    const settings = await this.store.getSettings();
    const baseUrl = configuredOpenwaBaseUrl();
    const apiKey = await this.store.getOpenwaApiKey();
    if (!openwaConfigured(settings) || !baseUrl || !apiKey) {
      throw new ValidationError("Link WhatsApp in Settings before using intake");
    }
    return {
      sessionId: settings.openwaSessionId,
      client: new OpenwaClient({ baseUrl, apiKey }),
      whatsapp: new WhatsAppService({
        baseUrl,
        apiKey,
        sessionId: settings.openwaSessionId,
      }),
    };
  }

  private async whatsapp(): Promise<WhatsAppService> {
    return (await this.gateway()).whatsapp;
  }
}
