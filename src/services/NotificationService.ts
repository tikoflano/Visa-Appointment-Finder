import { EmailService } from "./EmailService";
import { formatDate } from "../utils/dateUtils";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface MailContent {
  subject: string;
  summary: string;
}

export interface HeartbeatReport {
  enabledProfiles: { name: string; visaProcessId: string }[];
  recentRuns: { name: string; status: string; startedAt: string }[];
  anySuccess: boolean;
}

export class NotificationService {
  private emailService: EmailService;

  constructor(emailService: EmailService) {
    this.emailService = emailService;
  }

  async sendHeartbeatNotification(options: {
    destination: string;
    report: HeartbeatReport;
  }): Promise<MailContent> {
    const healthy = options.report.anySuccess;
    const profileLines = options.report.enabledProfiles.length
      ? options.report.enabledProfiles
          .map(
            (profile) =>
              `<li>${escapeHtml(profile.name)} (${escapeHtml(profile.visaProcessId)})</li>`,
          )
          .join("")
      : "<li>None enabled</li>";
    const runLines = options.report.recentRuns.length
      ? options.report.recentRuns
          .map(
            (run) =>
              `<li>${escapeHtml(run.startedAt)} — ${escapeHtml(run.name)} — ${escapeHtml(run.status)}</li>`,
          )
          .join("")
      : "<li>No runs recorded yet</li>";
    const statusLine = healthy
      ? "At least one of the last 5 runs succeeded."
      : "None of the last 5 runs succeeded. An admin needs to check the management UI.";
    const subject = healthy
      ? "Visa appointment scheduler is running"
      : "Visa appointment scheduler needs attention";
    const enabled = options.report.enabledProfiles.length;
    const summary = healthy
      ? `Healthy · ${enabled} enabled profile${enabled === 1 ? "" : "s"}`
      : `Needs attention · ${enabled} enabled profile${enabled === 1 ? "" : "s"}`;

    await this.emailService.sendMail(
      options.destination,
      subject,
      `<p>Scheduled visa appointment checks are running.</p>
        <p><strong>Enabled profiles</strong></p>
        <ul>${profileLines}</ul>
        <p><strong>Last 5 runs</strong></p>
        <ul>${runLines}</ul>
        <p><strong>${statusLine}</strong></p>`,
    );
    return { subject, summary };
  }

  async sendFailureAlarm(options: {
    destination: string;
    profileName: string;
    visaEmail: string;
    visaProcessId: string;
    threshold: number;
    errors: { startedAt: string; status: string; error: string | null }[];
  }): Promise<MailContent> {
    const latest = options.errors[0];
    const latestError = latest?.error || latest?.status || "unknown error";
    const lines = options.errors.length
      ? options.errors
          .map(
            (run) =>
              `<li>${escapeHtml(run.startedAt)} — ${escapeHtml(run.error || run.status)}</li>`,
          )
          .join("")
      : "<li>No error details</li>";
    const subject = `Visa check failed ${options.threshold} times in a row: ${options.profileName}`;
    const summary = `${options.profileName}: ${options.threshold} consecutive errors. Latest: ${latestError}`;

    await this.emailService.sendMail(
      options.destination,
      subject,
      `<p>The scheduler recorded <strong>${options.threshold}</strong> consecutive errors for <strong>${escapeHtml(
        options.profileName,
      )}</strong>.</p>
        <p>${escapeHtml(options.visaEmail)} · process ${escapeHtml(options.visaProcessId)}</p>
        <p>Latest error: ${escapeHtml(latestError)}</p>
        <p><strong>Recent failures</strong></p>
        <ul>${lines}</ul>
        <p>Open the management UI to inspect the run and fix the profile.</p>`,
    );
    return { subject, summary };
  }

  async sendAppointmentNotification(options: {
    to: string;
    bcc?: string;
    processId: string;
    firstDate: Date;
    extraDates?: string;
  }): Promise<MailContent> {
    const to = options.to.trim();
    if (!to) {
      throw Error("Destination address not set");
    }
    const first = formatDate(options.firstDate);
    const subject = "Visa appointment available";
    const summary = options.extraDates
      ? `Available ${first}. Other: ${options.extraDates}`
      : `Available ${first}`;

    await this.emailService.sendMail(
      to,
      subject,
      `There is a visa appointment available on ${first}. 
        Go to https://ais.usvisa-info.com/en-cl/niv/schedule/${options.processId}/appointment to schedule it. ` +
        (options.extraDates
          ? `Other available appointments: ${options.extraDates}`
          : ""),
      options.bcc,
    );
    return { subject, summary };
  }
}
