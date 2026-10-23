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
import { parseDateAsUtc } from "../utils/dateUtils";
import { intakeExpiredAdminText } from "./intakeReply";
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
  displayWhatsAppId,
  openwaConfigured,
  parseWhatsAppChatIds,
  WhatsAppService,
} from "./whatsapp";

const TICK_MS = 15 * 1000;
const HEARTBEAT_RETRY_BACKOFF_MINUTES = [1, 5, 10];

export function latestHeartbeatSlot(now: Date, timeUtc: string): Date {
  const match = /^(\d{2}):(\d{2})$/.exec(timeUtc) || ["", "00", "00"];
  const slot = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      Number(match[1]),
      Number(match[2]),
      0,
      0,
    ),
  );
  if (slot.getTime() > now.getTime()) {
    slot.setUTCDate(slot.getUTCDate() - 1);
  }
  return slot;
}

export function heartbeatRetryDelayMinutes(attemptNumber: number): number | null {
  return HEARTBEAT_RETRY_BACKOFF_MINUTES[attemptNumber - 1] ?? null;
}

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

const APPOINTMENT_DEDUPE_REASON =
  "Same date list as the last successful send on this channel";

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
    const content = composeTestNotification();

    if (options.channel === "email") {
      if (!saved.emailEnabled) {
        throw new ValidationError("Email notifications are turned off");
      }
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
        await notify.sendTestNotification({ destination });
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

    if (!saved.whatsappEnabled) {
      throw new ValidationError("WhatsApp notifications are turned off");
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
      await client.sendToMany(chats, content.whatsapp, `visa-test-${Date.now()}`);
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
   * Send a test to every notify email and WhatsApp number on a profile.
   * Passed destinations override the saved profile for this request only.
   * Admin copies are not included.
   */
  async sendProfileTest(
    profileId: number,
    options: {
      emailDestination?: string;
      whatsappDestination?: string;
    } = {},
  ): Promise<{
    sent: boolean;
    channels: {
      channel: "email" | "whatsapp";
      status: "sent" | "failed";
      recipients: string;
      error?: string;
    }[];
  }> {
    const profile = await this.store.getProfile(profileId);
    if (!profile) throw new ValidationError("Profile not found");

    const emailTo = normalizeEmailList(
      options.emailDestination !== undefined
        ? options.emailDestination
        : profile.emailDestination,
    );
    const whatsappSource =
      options.whatsappDestination !== undefined
        ? options.whatsappDestination
        : profile.whatsappDestination;
    let chats: string[] = [];
    if (String(whatsappSource ?? "").trim()) {
      try {
        chats = parseWhatsAppChatIds(whatsappSource);
      } catch (error) {
        throw new ValidationError(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (!emailTo && !chats.length) {
      throw new ValidationError(
        "Add a notify email or WhatsApp number to send a test",
      );
    }

    const settings = await this.store.getSettings();
    if (!settings.emailEnabled && !settings.whatsappEnabled) {
      throw new ValidationError(
        "At least one notification method must stay enabled",
      );
    }
    const channels: {
      channel: "email" | "whatsapp";
      status: "sent" | "failed";
      recipients: string;
      error?: string;
    }[] = [];

    if (emailTo) {
      const content = composeTestNotification({
        processId: profile.visaProcessId || "",
      });
      if (!settings.emailEnabled) {
        channels.push({
          channel: "email",
          status: "failed",
          recipients: emailTo,
          error: "Email notifications are turned off",
        });
      } else if (!this.emailReady(settings)) {
        const error = "Gmail credentials are not configured";
        await this.logNotification({
          kind: "test",
          channel: "email",
          status: "failed",
          profileId,
          recipients: emailTo,
          subject: content.subject,
          summary: content.summary,
          error,
        });
        channels.push({
          channel: "email",
          status: "failed",
          recipients: emailTo,
          error,
        });
      } else {
        try {
          const mailer = await this.mailer();
          if (!mailer) throw new Error("Gmail credentials are not configured");
          const sent = await mailer.notify.sendTestNotification({
            destination: emailTo,
            processId: profile.visaProcessId || "",
          });
          await this.logNotification({
            kind: "test",
            channel: "email",
            status: "sent",
            profileId,
            recipients: emailTo,
            subject: sent.subject,
            summary: sent.summary,
          });
          channels.push({
            channel: "email",
            status: "sent",
            recipients: emailTo,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.logNotification({
            kind: "test",
            channel: "email",
            status: "failed",
            profileId,
            recipients: emailTo,
            subject: content.subject,
            summary: content.summary,
            error: message,
          });
          channels.push({
            channel: "email",
            status: "failed",
            recipients: emailTo,
            error: message,
          });
        }
      }
    }

    if (chats.length) {
      const content = composeTestNotification({
        processId: profile.visaProcessId || "",
      });
      const recipients = chats.join(", ");
      if (!settings.whatsappEnabled) {
        channels.push({
          channel: "whatsapp",
          status: "failed",
          recipients,
          error: "WhatsApp notifications are turned off",
        });
      } else {
      const sessionId = settings.openwaSessionId.trim();
      const baseUrl = configuredOpenwaBaseUrl();
      const apiKey = await this.store.getOpenwaApiKey();
      let setupError: string | null = null;
      if (!baseUrl || !apiKey) {
        setupError = "OpenWA is not configured on this host";
      } else if (!sessionId) {
        setupError = "Link WhatsApp before sending a test";
      }
      if (setupError) {
        await this.logNotification({
          kind: "test",
          channel: "whatsapp",
          status: "failed",
          profileId,
          recipients,
          subject: content.subject,
          summary: content.summary,
          error: setupError,
        });
        channels.push({
          channel: "whatsapp",
          status: "failed",
          recipients,
          error: setupError,
        });
      } else {
        try {
          const client = new WhatsAppService({
            baseUrl,
            apiKey,
            sessionId,
          });
          await client.sendToMany(
            chats,
            content.whatsapp,
            `visa-test-${profileId}-${Date.now()}`,
          );
          await this.logNotification({
            kind: "test",
            channel: "whatsapp",
            status: "sent",
            profileId,
            recipients,
            subject: content.subject,
            summary: content.summary,
          });
          channels.push({
            channel: "whatsapp",
            status: "sent",
            recipients,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.logNotification({
            kind: "test",
            channel: "whatsapp",
            status: "failed",
            profileId,
            recipients,
            subject: content.subject,
            summary: content.summary,
            error: message,
          });
          channels.push({
            channel: "whatsapp",
            status: "failed",
            recipients,
            error: message,
          });
        }
      }
    }
    }

    if (!channels.some((channel) => channel.status === "sent")) {
      throw new ValidationError(
        channels
          .map((channel) => channel.error)
          .filter(Boolean)
          .join(". ") || "Test notification could not be sent",
      );
    }
    return { sent: true, channels };
  }

  /**
   * Notify when the profile asked for it and the bot found dates. Returns the
   * result with `notified` set if any channel sent. A send failure leaves the
   * AIS outcome as-is. Repeat dates are skipped per channel until a later
   * successful check finds no matching dates.
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

    const dates = result.dates.map((iso) => parseDateAsUtc(iso));
    const content = composeAppointmentNotification({
      processId: profile.visaProcessId || "",
      dates,
    });
    const datesKey = appointmentDatesKey(result.dates);
    const settings = await this.store.getSettings();

    let anySent = false;
    let lastError: string | null = null;

    const emailTo =
      settings.emailEnabled ? profile.emailDestination.trim() : "";
    if (emailTo) {
      const outcome = await this.sendAppointmentEmail({
        profile,
        runId,
        content,
        datesKey,
        dates,
        to: emailTo,
        bcc: settings.emailAdminDestination || undefined,
      });
      if (outcome === "sent") anySent = true;
      if (outcome === "failed") lastError = lastError || "email failed";
    }

    const waRecipients = settings.whatsappEnabled
      ? uniqueIds(
          parseWhatsAppChatIds(profile.whatsappDestination),
          parseWhatsAppChatIds(settings.whatsappAdminDestination),
        )
      : [];
    if (waRecipients.length) {
      const outcome = await this.sendWhatsApp({
        kind: "appointment",
        profileId,
        runId,
        recipients: waRecipients.join(", "),
        subject: content.subject,
        summary: content.summary,
        text: content.whatsapp,
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
    const emailReady = settings.emailEnabled && this.emailReady(settings);
    const whatsappReady =
      settings.whatsappEnabled && this.whatsappReady(settings);
    const adminEmail = settings.emailEnabled
      ? settings.emailAdminDestination.trim()
      : "";
    const adminWhatsapp = settings.whatsappEnabled
      ? parseWhatsAppChatIds(settings.whatsappAdminDestination)
      : [];

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
      await this.deliverHeartbeat({
        emailReady,
        whatsappReady,
        adminEmail,
        adminWhatsapp,
        settings,
      });
      await this.store.insertHeartbeatStamp();
      return { sent: true, lastHeartbeatAt: await this.store.getLastHeartbeatAt() };
    }

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

    const now = new Date();
    const slot = latestHeartbeatSlot(now, settings.heartbeatTimeUtc || "00:00");
    const slotIso = slot.toISOString();
    const claim = await this.store.beginScheduledHeartbeat(slotIso, now);
    if (!claim.send) {
      return { sent: false, lastHeartbeatAt: settings.lastHeartbeatAt };
    }

    try {
      await this.deliverHeartbeat({
        emailReady,
        whatsappReady,
        adminEmail,
        adminWhatsapp,
        settings,
      });
    } catch (error) {
      const delay = heartbeatRetryDelayMinutes(claim.attemptNumber);
      const nextAttemptAt = delay
        ? new Date(Date.now() + delay * 60000).toISOString()
        : "";
      await this.store.recordHeartbeatRetry(
        slotIso,
        claim.attemptNumber,
        nextAttemptAt,
      );
      throw error;
    }

    await this.store.recordScheduledHeartbeatSent(slotIso);
    return { sent: true, lastHeartbeatAt: await this.store.getLastHeartbeatAt() };
  }

  private async deliverHeartbeat(options: {
    emailReady: boolean;
    whatsappReady: boolean;
    adminEmail: string;
    adminWhatsapp: string[];
    settings: Settings;
  }): Promise<void> {
    const { emailReady, whatsappReady, adminEmail, adminWhatsapp, settings } =
      options;
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
        text: content.whatsapp,
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
  }

  /**
   * Tell admin destinations that a WhatsApp intake stopped after 24 hours.
   * The contact phone is notified separately and is not gated by the channel switches.
   */
  async notifyIntakeExpired(profile: Profile): Promise<void> {
    const settings = await this.store.getSettings();
    const phone = displayWhatsAppId(profile.contactPhone);
    const text = intakeExpiredAdminText(profile.name, phone);
    const subject = `WhatsApp intake stopped for ${profile.name}`;
    const emailReady = settings.emailEnabled && this.emailReady(settings);
    const whatsappReady =
      settings.whatsappEnabled && this.whatsappReady(settings);
    const adminEmail = settings.emailEnabled
      ? settings.emailAdminDestination.trim()
      : "";
    const adminWhatsapp = settings.whatsappEnabled
      ? parseWhatsAppChatIds(settings.whatsappAdminDestination)
      : [];

    if (emailReady && adminEmail) {
      try {
        const email = new EmailService({
          user: settings.gmailUser,
          pass: await this.store.getGmailAppPassword(),
        });
        const html = `<p>${escapeHtml(text)}</p>`;
        await email.sendMail(adminEmail, subject, html, text);
        await this.logNotification({
          kind: "intake",
          channel: "email",
          status: "sent",
          profileId: profile.id,
          recipients: adminEmail,
          subject,
          summary: text,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.logNotification({
          kind: "intake",
          channel: "email",
          status: "failed",
          profileId: profile.id,
          recipients: adminEmail,
          subject,
          summary: text,
          error: message,
        });
      }
    }

    if (whatsappReady && adminWhatsapp.length) {
      await this.sendWhatsApp({
        kind: "intake",
        profileId: profile.id,
        recipients: adminWhatsapp.join(", "),
        subject,
        summary: text,
        text,
        settings,
        chats: adminWhatsapp,
      });
    }
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

    const emailReady = settings.emailEnabled && this.emailReady(settings);
    const whatsappReady =
      settings.whatsappEnabled && this.whatsappReady(settings);
    const adminEmail = settings.emailEnabled
      ? settings.emailAdminDestination.trim()
      : "";
    const adminWhatsapp = settings.whatsappEnabled
      ? parseWhatsAppChatIds(settings.whatsappAdminDestination)
      : [];
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
      visaProcessId: profile.visaProcessId || "",
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
          visaProcessId: profile.visaProcessId || "",
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
        text: content.whatsapp,
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
    dates: Date[];
    to: string;
    bcc?: string;
  }): Promise<"sent" | "skipped" | "failed"> {
    const { profile, runId, content, datesKey, dates, to, bcc } = options;
    if (
      await this.store.shouldSkipAppointmentDedupe(
        profile.id,
        "email",
        datesKey,
      )
    ) {
      await this.logNotification({
        kind: "appointment",
        channel: "email",
        status: "skipped",
        profileId: profile.id,
        runId,
        recipients: recipientsList(to, bcc),
        subject: content.subject,
        summary: content.summary,
        error: APPOINTMENT_DEDUPE_REASON,
        dedupeKey: datesKey,
      });
      return "skipped";
    }

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
        processId: profile.visaProcessId || "",
        dates,
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
      if (
        await this.store.shouldSkipAppointmentDedupe(
          options.profileId,
          "whatsapp",
          options.datesKey,
        )
      ) {
        await this.logNotification({
          kind: "appointment",
          channel: "whatsapp",
          status: "skipped",
          profileId: options.profileId,
          runId: options.runId ?? null,
          recipients: options.recipients,
          subject: options.subject,
          summary: options.summary,
          error: APPOINTMENT_DEDUPE_REASON,
          dedupeKey: options.datesKey,
        });
        return "skipped";
      }
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
