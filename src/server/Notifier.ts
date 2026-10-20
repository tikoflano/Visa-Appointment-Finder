import { BotResult } from "../botResult";
import { EmailService } from "../services/EmailService";
import { NotificationService } from "../services/NotificationService";
import { Action } from "../types";
import { formatDate, parseDateAsUtc } from "../utils/dateUtils";
import {
  isFailureRun,
  NotificationInput,
  RunStatus,
  Settings,
  Store,
  ValidationError,
} from "./Store";

const TICK_MS = 15 * 1000;

function recipientsList(to: string, bcc?: string): string {
  const primary = to.trim();
  const copy = (bcc || "").trim();
  return copy ? `${primary}; bcc ${copy}` : primary;
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
   * Send the appointment email when the profile asked to be notified and the
   * bot found dates. Returns the result with `notified` set. A send failure
   * leaves AIS outcome as-is and records the SMTP error on the result.
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

    const to = profile.emailDestination.trim();
    if (!to) {
      console.warn(
        `Profile ${profile.name} has notify enabled but no notify emails`,
      );
      return result;
    }

    const firstDate = parseDateAsUtc(result.dates[0]);
    const extraDates = result.dates
      .slice(1)
      .map((iso) => formatDate(parseDateAsUtc(iso)))
      .join(" / ");
    const summary = extraDates
      ? `${profile.name}: ${formatDate(firstDate)}. Other: ${extraDates}`
      : `${profile.name}: ${formatDate(firstDate)}`;

    const mailer = await this.mailer();
    if (!mailer) {
      const error = "Gmail credentials are not configured";
      console.warn(`Profile ${profile.name} found dates, but ${error}`);
      await this.logNotification({
        kind: "appointment",
        status: "failed",
        profileId,
        runId,
        recipients: recipientsList(to),
        subject: "Visa appointment available",
        summary,
        error,
      });
      return { ...result, notified: false, error: result.error || error };
    }

    const bcc = mailer.settings.emailAdminDestination || undefined;
    try {
      const sent = await mailer.notify.sendAppointmentNotification({
        to,
        bcc,
        processId: profile.visaProcessId,
        firstDate,
        extraDates: extraDates || undefined,
      });
      await this.logNotification({
        kind: "appointment",
        status: "sent",
        profileId,
        runId,
        recipients: recipientsList(to, bcc),
        subject: sent.subject,
        summary: sent.summary,
      });
      return { ...result, notified: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Appointment notification failed for ${profile.name}:`,
        error,
      );
      await this.logNotification({
        kind: "appointment",
        status: "failed",
        profileId,
        runId,
        recipients: recipientsList(to, bcc),
        subject: "Visa appointment available",
        summary,
        error: message,
      });
      return { ...result, notified: false, error: result.error || message };
    }
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
    const configured =
      !!settings.emailAdminDestination &&
      !!settings.gmailUser &&
      settings.hasGmailAppPassword;

    if (options.force) {
      if (!settings.emailAdminDestination) {
        throw new ValidationError("Admin notification emails are required");
      }
      if (!settings.gmailUser || !settings.hasGmailAppPassword) {
        throw new ValidationError("Gmail credentials are not configured");
      }
    } else {
      if (!settings.heartbeatEnabled) {
        return { sent: false, lastHeartbeatAt: settings.lastHeartbeatAt };
      }
      if (!configured) {
        console.warn(
          "Heartbeat is enabled but Gmail or admin notification emails are not configured",
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

    const mailer = await this.mailer();
    if (!mailer) {
      throw new ValidationError("Gmail credentials are not configured");
    }

    const claimed = await this.store.claimHeartbeatIfDue(
      settings.heartbeatMinutes,
      !!options.force,
    );
    if (!claimed) {
      return { sent: false, lastHeartbeatAt: settings.lastHeartbeatAt };
    }

    const report = await this.store.getHeartbeatReport();
    const destination = settings.emailAdminDestination;
    try {
      const sent = await mailer.notify.sendHeartbeatNotification({
        destination,
        report,
      });
      await this.logNotification({
        kind: "heartbeat",
        status: "sent",
        recipients: destination,
        subject: sent.subject,
        summary: sent.summary,
      });
      return { sent: true, lastHeartbeatAt: await this.store.getLastHeartbeatAt() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.logNotification({
        kind: "heartbeat",
        status: "failed",
        recipients: destination,
        subject: "Visa appointment scheduler is running",
        summary: "Heartbeat email failed",
        error: message,
      });
      throw error;
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

    if (
      !settings.emailAdminDestination ||
      !settings.gmailUser ||
      !settings.hasGmailAppPassword
    ) {
      console.warn(
        `Profile ${profileId} hit ${count} consecutive failures, but Gmail or admin notification emails are not configured`,
      );
      return;
    }

    const profile = await this.store.getProfile(profileId);
    if (!profile) return;

    const mailer = await this.mailer();
    if (!mailer) return;

    const destination = settings.emailAdminDestination;
    const latest = errors[0];
    try {
      const sent = await mailer.notify.sendFailureAlarm({
        destination,
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
        status: "sent",
        profileId,
        runId: latest?.id ?? null,
        recipients: destination,
        subject: sent.subject,
        summary: sent.summary,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.logNotification({
        kind: "failure",
        status: "failed",
        profileId,
        runId: latest?.id ?? null,
        recipients: destination,
        subject: `Visa check failed ${threshold} times in a row: ${profile.name}`,
        summary: `${profile.name}: ${threshold} consecutive errors`,
        error: message,
      });
      throw error;
    }
  }

  private async logNotification(input: NotificationInput): Promise<void> {
    try {
      await this.store.insertNotification(input);
    } catch (error) {
      console.error("Failed to record notification:", error);
    }
  }

  private async mailer(): Promise<{
    settings: Settings;
    notify: NotificationService;
  } | null> {
    const settings = await this.store.getSettings();
    if (!settings.gmailUser || !settings.hasGmailAppPassword) return null;
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
}
