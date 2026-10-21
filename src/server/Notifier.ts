import { BotResult } from "../botResult";
import { EmailService } from "../services/EmailService";
import {
  composeAppointmentNotification,
  composeFailureAlarm,
  composeHeartbeatNotification,
  composeTestNotification,
  NotificationService,
} from "../services/NotificationService";
import { Action } from "../types";
import { formatDate, parseDateAsUtc } from "../utils/dateUtils";
import {
  isFailureRun,
  NotificationInput,
  Profile,
  RunStatus,
  Settings,
  Store,
  ValidationError,
} from "./Store";
import {
  configuredOpenwaBaseUrl,
  openwaConfigured,
  parseWhatsAppChatIds,
  WhatsAppService,
} from "./whatsapp";

const TICK_MS = 15 * 1000;

function normalizeEmailList(value: unknown): string {
  return String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(",");
}

function recipientsList(to: string, bcc?: string): string {
  const primary = to.trim();
  const copy = (bcc || "").trim();
  return copy ? `${primary}; bcc ${copy}` : primary;
}

function uniqueIds(...groups: string[][]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const group of groups) {
    for (const id of group) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function appointmentDatesKey(dates: string[]): string {
  return [...dates].sort().join(",");
}

export class Notifier {
  private readonly store: Store;
  private timer: NodeJS.Timeout | undefined;
  private heartbeatInFlight = false;

  constructor(store: Store) {
    this.store = store;
  }

  async start(): Promise<void> {
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Send a labeled test to admin email or WhatsApp. Form values override
   * stored settings for this request only and are not saved.
   */
  async sendTest(options: {
    channel: "email" | "whatsapp";
    gmailUser?: string;
    gmailAppPassword?: string;
    emailAdminDestination?: string;
    openwaSessionId?: string;
    whatsappAdminDestination?: string;
  }): Promise<{ sent: boolean; channel: string; recipients: string }> {
    const saved = await this.store.getSettings();
    const content = composeTestNotification(options.channel);

    if (options.channel === "email") {
      const user = String(options.gmailUser ?? saved.gmailUser).trim();
      const pass =
        String(options.gmailAppPassword ?? "").trim() ||
        (await this.store.getGmailAppPassword());
      const destination = normalizeEmailList(
        options.emailAdminDestination ?? saved.emailAdminDestination,
      );
      if (!user || !pass) {
        throw new ValidationError("Gmail user and app password are required");
      }
      if (!destination) {
        throw new ValidationError("Admin notification emails are required");
      }
      try {
        const notify = new NotificationService(
          new EmailService({ user, pass }),
        );
        await notify.sendTestNotification({ destination, channel: "email" });
        await this.logNotification({
          kind: "test",
          channel: "email",
          status: "sent",
          recipients: destination,
          subject: content.subject,
          summary: content.summary,
        });
        return { sent: true, channel: "email", recipients: destination };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.logNotification({
          kind: "test",
          channel: "email",
          status: "failed",
          recipients: destination,
          subject: content.subject,
          summary: content.summary,
          error: message,
        });
        throw new ValidationError(message);
      }
    }

    let chats: string[];
    try {
      chats = parseWhatsAppChatIds(
        options.whatsappAdminDestination ?? saved.whatsappAdminDestination,
      );
    } catch (error) {
      throw new ValidationError(
        error instanceof Error ? error.message : String(error),
      );
    }
    const sessionId = String(
      options.openwaSessionId ?? saved.openwaSessionId,
    ).trim();
    const baseUrl = configuredOpenwaBaseUrl();
    const apiKey = await this.store.getOpenwaApiKey();
    if (!baseUrl || !apiKey) {
      throw new ValidationError("OpenWA is not configured on this host");
    }
    if (!sessionId) {
      throw new ValidationError("Link WhatsApp before sending a test");
    }
    if (!chats.length) {
      throw new ValidationError("Admin WhatsApp numbers are required");
    }
    const recipients = chats.join(", ");
    try {
      const client = new WhatsAppService({
        baseUrl,
        apiKey,
        sessionId,
      });
      await client.sendToMany(chats, content.text, `visa-test-${Date.now()}`);
      await this.logNotification({
        kind: "test",
        channel: "whatsapp",
        status: "sent",
        recipients,
        subject: content.subject,
        summary: content.summary,
      });
      return { sent: true, channel: "whatsapp", recipients };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.logNotification({
        kind: "test",
        channel: "whatsapp",
        status: "failed",
        recipients,
        subject: content.subject,
        summary: content.summary,
        error: message,
      });
      throw new ValidationError(message);
    }
  }

  /**
   * Notify when the profile asked for it and the bot found dates. Returns the
   * result with `notified` set if any channel sent. A send failure leaves the
   * AIS outcome as-is. Repeat dates are skipped per channel.
   */
  async notifyForRun(
    profileId: number,
    runId: number,
    status: RunStatus,
    result: BotResult | null,
  ): Promise<BotResult | null> {
    if (!result?.dates.length) return result;
    if (status === "cancelled" || status === "running") return result;

    const profile = await this.store.getProfile(profileId);
    if (!profile?.actions.includes(Action.Notify)) return result;

    const firstDate = parseDateAsUtc(result.dates[0]);
    const extraDates =
      result.dates
        .slice(1)
        .map((iso) => formatDate(parseDateAsUtc(iso)))
        .join(" / ") || undefined;
    const content = composeAppointmentNotification({
      processId: profile.visaProcessId,
      firstDate,
      extraDates,
    });
    const datesKey = appointmentDatesKey(result.dates);
    const settings = await this.store.getSettings();

    let anySent = false;
    let lastError: string | null = null;

    const emailTo = profile.emailDestination.trim();
    if (emailTo) {
      const outcome = await this.sendAppointmentEmail({
        profile,
        runId,
        content,
        datesKey,
        firstDate,
        extraDates,
        to: emailTo,
        bcc: settings.emailAdminDestination || undefined,
      });
      if (outcome === "sent") anySent = true;
      if (outcome === "failed") lastError = lastError || "email failed";
    }

    const waRecipients = uniqueIds(
      parseWhatsAppChatIds(profile.whatsappDestination),
      parseWhatsAppChatIds(settings.whatsappAdminDestination),
    );
    if (waRecipients.length) {
      const outcome = await this.sendWhatsApp({
        kind: "appointment",
        profileId,
        runId,
        recipients: waRecipients.join(", "),
        subject: content.subject,
        summary: content.summary,
        text: content.text,
        datesKey,
        settings,
      });
      if (outcome === "sent") anySent = true;
      if (outcome === "failed") lastError = lastError || "whatsapp failed";
    }

    if (!emailTo && !profile.whatsappDestination.trim()) {
      console.warn(
        `Profile ${profile.name} has notify enabled but no notify emails or WhatsApp numbers`,
      );
    }

    if (!anySent && lastError) {
      return { ...result, notified: false, error: result.error || lastError };
    }
    return { ...result, notified: anySent };
  }

  queueFailureAlarm(
    profileId: number,
    status: RunStatus,
    result: BotResult | null,
  ): void {
    void this.maybeSendFailureAlarm(profileId, status, result).catch(
      (error) => {
        console.error(
          `Failure alarm failed for profile ${profileId}:`,
          error,
        );
      },
    );
  }

  async sendHeartbeat(
    options: { force?: boolean } = {},
  ): Promise<{ sent: boolean; lastHeartbeatAt: string | null }> {
    const settings = await this.store.getSettings();
    const emailReady = this.emailReady(settings);
    const whatsappReady = this.whatsappReady(settings);
    const adminEmail = settings.emailAdminDestination.trim();
    const adminWhatsapp = parseWhatsAppChatIds(
      settings.whatsappAdminDestination,
    );

    if (options.force) {
      if (!adminEmail && !adminWhatsapp.length) {
        throw new ValidationError(
          "Admin notification emails or WhatsApp numbers are required",
        );
      }
      if (!emailReady && !whatsappReady) {
        if (adminEmail && !emailReady) {
          throw new ValidationError("Gmail credentials are not configured");
        }
        throw new ValidationError("OpenWA is not configured");
      }
    } else {
      if (!settings.heartbeatEnabled) {
        return { sent: false, lastHeartbeatAt: settings.lastHeartbeatAt };
      }
      if (!emailReady && !whatsappReady) {
        console.warn(
          "Heartbeat is enabled but neither Gmail nor OpenWA is configured",
        );
        return { sent: false, lastHeartbeatAt: settings.lastHeartbeatAt };
      }
      if (!adminEmail && !adminWhatsapp.length) {
        console.warn(
          "Heartbeat is enabled but no admin notification emails or WhatsApp numbers are set",
        );
        return { sent: false, lastHeartbeatAt: settings.lastHeartbeatAt };
      }
      if (settings.lastHeartbeatAt) {
        const elapsedMinutes = Math.floor(
          (Date.now() - +new Date(settings.lastHeartbeatAt)) / 60000,
        );
        if (elapsedMinutes < settings.heartbeatMinutes) {
          return { sent: false, lastHeartbeatAt: settings.lastHeartbeatAt };
        }
      }
    }

    const claimed = await this.store.claimHeartbeatIfDue(
      settings.heartbeatMinutes,
      !!options.force,
    );
    if (!claimed) {
      return { sent: false, lastHeartbeatAt: settings.lastHeartbeatAt };
    }

    const report = await this.store.getHeartbeatReport();
    const content = composeHeartbeatNotification({ report });
    let anySent = false;
    let lastError: string | null = null;

    if (emailReady && adminEmail) {
      const mailer = await this.mailer();
      try {
        if (!mailer) throw new Error("Gmail credentials are not configured");
        await mailer.notify.sendHeartbeatNotification({
          destination: adminEmail,
          report,
        });
        await this.logNotification({
          kind: "heartbeat",
          channel: "email",
          status: "sent",
          recipients: adminEmail,
          subject: content.subject,
          summary: content.summary,
        });
        anySent = true;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await this.logNotification({
          kind: "heartbeat",
          channel: "email",
          status: "failed",
          recipients: adminEmail,
          subject: content.subject,
          summary: content.summary,
          error: lastError,
        });
      }
    }

    if (whatsappReady && adminWhatsapp.length) {
      const outcome = await this.sendWhatsApp({
        kind: "heartbeat",
        recipients: adminWhatsapp.join(", "),
        subject: content.subject,
        summary: content.summary,
        text: content.text,
        settings,
        chats: adminWhatsapp,
      });
      if (outcome === "sent") anySent = true;
      if (outcome === "failed") {
        lastError = lastError || "whatsapp failed";
      }
    }

    if (!anySent) {
      throw new Error(lastError || "Heartbeat could not be sent");
    }
    return { sent: true, lastHeartbeatAt: await this.store.getLastHeartbeatAt() };
  }

  private tick(): void {
    void this.maybeHeartbeat();
  }

  private async maybeHeartbeat(): Promise<void> {
    if (this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    try {
      await this.sendHeartbeat();
    } catch (error) {
      console.error("Heartbeat failed:", error);
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private async maybeSendFailureAlarm(
    profileId: number,
    status: RunStatus,
    result: BotResult | null,
  ): Promise<void> {
    if (!isFailureRun({ status, result })) return;

    const settings = await this.store.getSettings();
    const threshold = settings.failureAlarmThreshold;
    if (!Number.isInteger(threshold) || threshold < 1) return;

    const { count, errors } = await this.store.countConsecutiveFailures(
      profileId,
    );
    if (count !== threshold) return;

    const profile = await this.store.getProfile(profileId);
    if (!profile) return;

    const emailReady = this.emailReady(settings);
    const whatsappReady = this.whatsappReady(settings);
    const adminEmail = settings.emailAdminDestination.trim();
    const adminWhatsapp = parseWhatsAppChatIds(
      settings.whatsappAdminDestination,
    );
    if (
      (!emailReady || !adminEmail) &&
      (!whatsappReady || !adminWhatsapp.length)
    ) {
      console.warn(
        `Profile ${profileId} hit ${count} consecutive failures, but neither email nor WhatsApp admin notifications are configured`,
      );
      return;
    }

    const latest = errors[0];
    const content = composeFailureAlarm({
      profileName: profile.name,
      visaEmail: profile.visaEmail,
      visaProcessId: profile.visaProcessId,
      threshold,
      errors: errors.map((run) => ({
        startedAt: run.startedAt,
        status: run.status,
        error: run.result?.error ?? null,
      })),
    });

    if (emailReady && adminEmail) {
      const mailer = await this.mailer();
      try {
        if (!mailer) throw new Error("Gmail credentials are not configured");
        await mailer.notify.sendFailureAlarm({
          destination: adminEmail,
          profileName: profile.name,
          visaEmail: profile.visaEmail,
          visaProcessId: profile.visaProcessId,
          threshold,
          errors: errors.map((run) => ({
            startedAt: run.startedAt,
            status: run.status,
            error: run.result?.error ?? null,
          })),
        });
        await this.logNotification({
          kind: "failure",
          channel: "email",
          status: "sent",
          profileId,
          runId: latest?.id ?? null,
          recipients: adminEmail,
          subject: content.subject,
          summary: content.summary,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.logNotification({
          kind: "failure",
          channel: "email",
          status: "failed",
          profileId,
          runId: latest?.id ?? null,
          recipients: adminEmail,
          subject: content.subject,
          summary: content.summary,
          error: message,
        });
      }
    }

    if (whatsappReady && adminWhatsapp.length) {
      await this.sendWhatsApp({
        kind: "failure",
        profileId,
        runId: latest?.id ?? null,
        recipients: adminWhatsapp.join(", "),
        subject: content.subject,
        summary: content.summary,
        text: content.text,
        settings,
        chats: adminWhatsapp,
      });
    }
  }

  private async sendAppointmentEmail(options: {
    profile: Profile;
    runId: number;
    content: { subject: string; summary: string };
    datesKey: string;
    firstDate: Date;
    extraDates?: string;
    to: string;
    bcc?: string;
  }): Promise<"sent" | "skipped" | "failed"> {
    const { profile, runId, content, datesKey, firstDate, extraDates, to, bcc } =
      options;
    const previous = await this.store.lastSentDedupeKey(
      profile.id,
      "appointment",
      "email",
    );
    if (previous === datesKey) return "skipped";

    const mailer = await this.mailer();
    if (!mailer) {
      const error = "Gmail credentials are not configured";
      console.warn(`Profile ${profile.name} found dates, but ${error}`);
      await this.logNotification({
        kind: "appointment",
        channel: "email",
        status: "failed",
        profileId: profile.id,
        runId,
        recipients: recipientsList(to),
        subject: content.subject,
        summary: content.summary,
        error,
        dedupeKey: datesKey,
      });
      return "failed";
    }

    try {
      await mailer.notify.sendAppointmentNotification({
        to,
        bcc,
        processId: profile.visaProcessId,
        firstDate,
        extraDates,
      });
      await this.logNotification({
        kind: "appointment",
        channel: "email",
        status: "sent",
        profileId: profile.id,
        runId,
        recipients: recipientsList(to, bcc),
        subject: content.subject,
        summary: content.summary,
        dedupeKey: datesKey,
      });
      return "sent";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Appointment notification failed for ${profile.name}:`,
        error,
      );
      await this.logNotification({
        kind: "appointment",
        channel: "email",
        status: "failed",
        profileId: profile.id,
        runId,
        recipients: recipientsList(to, bcc),
        subject: content.subject,
        summary: content.summary,
        error: message,
        dedupeKey: datesKey,
      });
      return "failed";
    }
  }

  private async sendWhatsApp(options: {
    kind: NotificationInput["kind"];
    profileId?: number | null;
    runId?: number | null;
    recipients: string;
    subject: string;
    summary: string;
    text: string;
    datesKey?: string;
    settings: Settings;
    chats?: string[];
  }): Promise<"sent" | "skipped" | "failed"> {
    const chats = options.chats ?? parseWhatsAppChatIds(options.recipients);
    if (
      options.kind === "appointment" &&
      options.profileId &&
      options.datesKey
    ) {
      const previous = await this.store.lastSentDedupeKey(
        options.profileId,
        "appointment",
        "whatsapp",
      );
      if (previous === options.datesKey) return "skipped";
    }

    if (!this.whatsappReady(options.settings)) {
      const error = "OpenWA is not configured";
      await this.logNotification({
        kind: options.kind,
        channel: "whatsapp",
        status: "failed",
        profileId: options.profileId ?? null,
        runId: options.runId ?? null,
        recipients: options.recipients,
        subject: options.subject,
        summary: options.summary,
        error,
        dedupeKey: options.datesKey,
      });
      return "failed";
    }

    try {
      const client = await this.whatsapp(options.settings);
      if (!client) throw new Error("OpenWA is not configured");
      const keyPrefix = [
        "visa",
        options.kind,
        options.profileId ?? "admin",
        options.runId ?? Date.now(),
      ].join("-");
      await client.sendToMany(chats, options.text, keyPrefix);
      await this.logNotification({
        kind: options.kind,
        channel: "whatsapp",
        status: "sent",
        profileId: options.profileId ?? null,
        runId: options.runId ?? null,
        recipients: options.recipients,
        subject: options.subject,
        summary: options.summary,
        dedupeKey: options.datesKey,
      });
      return "sent";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${options.kind} WhatsApp notification failed:`, error);
      await this.logNotification({
        kind: options.kind,
        channel: "whatsapp",
        status: "failed",
        profileId: options.profileId ?? null,
        runId: options.runId ?? null,
        recipients: options.recipients,
        subject: options.subject,
        summary: options.summary,
        error: message,
        dedupeKey: options.datesKey,
      });
      return "failed";
    }
  }

  private async logNotification(input: NotificationInput): Promise<void> {
    try {
      await this.store.insertNotification(input);
    } catch (error) {
      console.error("Failed to record notification:", error);
    }
  }

  private emailReady(settings: Settings): boolean {
    return !!(settings.gmailUser && settings.hasGmailAppPassword);
  }

  private whatsappReady(settings: Settings): boolean {
    return openwaConfigured(settings);
  }

  private async mailer(): Promise<{
    settings: Settings;
    notify: NotificationService;
  } | null> {
    const settings = await this.store.getSettings();
    if (!this.emailReady(settings)) return null;
    return {
      settings,
      notify: new NotificationService(
        new EmailService({
          user: settings.gmailUser,
          pass: await this.store.getGmailAppPassword(),
        }),
      ),
    };
  }

  private async whatsapp(settings: Settings): Promise<WhatsAppService | null> {
    if (!this.whatsappReady(settings)) return null;
    return new WhatsAppService({
      baseUrl: configuredOpenwaBaseUrl(),
      apiKey: await this.store.getOpenwaApiKey(),
      sessionId: settings.openwaSessionId,
    });
  }
}
