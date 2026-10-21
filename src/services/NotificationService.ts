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
  text: string;
  html: string;
}

export interface HeartbeatReport {
  enabledProfiles: { name: string; visaProcessId: string }[];
  recentRuns: { name: string; status: string; startedAt: string }[];
  anySuccess: boolean;
}

export function composeAppointmentNotification(options: {
  processId: string;
  firstDate: Date;
  extraDates?: string;
}): MailContent {
  const first = formatDate(options.firstDate);
  const url = `https://ais.usvisa-info.com/en-cl/niv/schedule/${options.processId}/appointment`;
  const extra = options.extraDates
    ? ` Other available appointments: ${options.extraDates}`
    : "";
  const subject = "Visa appointment available";
  const summary = options.extraDates
    ? `Available ${first}. Other: ${options.extraDates}`
    : `Available ${first}`;
  const text = `There is a visa appointment available on ${first}. Go to ${url} to schedule it.${extra}`;
  return { subject, summary, text, html: text };
}

export function composeHeartbeatNotification(options: {
  report: HeartbeatReport;
}): MailContent {
  const healthy = options.report.anySuccess;
  const profileLines = options.report.enabledProfiles.length
    ? options.report.enabledProfiles
        .map((profile) => `${profile.name} (${profile.visaProcessId})`)
        .join("\n")
    : "None enabled";
  const runLines = options.report.recentRuns.length
    ? options.report.recentRuns
        .map((run) => `${run.startedAt} — ${run.name} — ${run.status}`)
        .join("\n")
    : "No runs recorded yet";
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
  const text = `Scheduled visa appointment checks are running.\n\nEnabled profiles:\n${profileLines}\n\nLast 5 runs:\n${runLines}\n\n${statusLine}`;
  const html = `<p>Scheduled visa appointment checks are running.</p>
        <p><strong>Enabled profiles</strong></p>
        <ul>${
          options.report.enabledProfiles.length
            ? options.report.enabledProfiles
                .map(
                  (profile) =>
                    `<li>${escapeHtml(profile.name)} (${escapeHtml(profile.visaProcessId)})</li>`,
                )
                .join("")
            : "<li>None enabled</li>"
        }</ul>
        <p><strong>Last 5 runs</strong></p>
        <ul>${
          options.report.recentRuns.length
            ? options.report.recentRuns
                .map(
                  (run) =>
                    `<li>${escapeHtml(run.startedAt)} — ${escapeHtml(run.name)} — ${escapeHtml(run.status)}</li>`,
                )
                .join("")
            : "<li>No runs recorded yet</li>"
        }</ul>
        <p><strong>${statusLine}</strong></p>`;
  return { subject, summary, text, html };
}

export function composeFailureAlarm(options: {
  profileName: string;
  visaEmail: string;
  visaProcessId: string;
  threshold: number;
  errors: { startedAt: string; status: string; error: string | null }[];
}): MailContent {
  const latest = options.errors[0];
  const latestError = latest?.error || latest?.status || "unknown error";
  const subject = `Visa check failed ${options.threshold} times in a row: ${options.profileName}`;
  const summary = `${options.profileName}: ${options.threshold} consecutive errors. Latest: ${latestError}`;
  const errorLines = options.errors.length
    ? options.errors
        .map((run) => `${run.startedAt} — ${run.error || run.status}`)
        .join("\n")
    : "No error details";
  const text = `The scheduler recorded ${options.threshold} consecutive errors for ${options.profileName}.
${options.visaEmail} · process ${options.visaProcessId}
Latest error: ${latestError}

Recent failures:
${errorLines}

Open the management UI to inspect the run and fix the profile.`;
  const html = `<p>The scheduler recorded <strong>${options.threshold}</strong> consecutive errors for <strong>${escapeHtml(
    options.profileName,
  )}</strong>.</p>
        <p>${escapeHtml(options.visaEmail)} · process ${escapeHtml(options.visaProcessId)}</p>
        <p>Latest error: ${escapeHtml(latestError)}</p>
        <p><strong>Recent failures</strong></p>
        <ul>${
          options.errors.length
            ? options.errors
                .map(
                  (run) =>
                    `<li>${escapeHtml(run.startedAt)} — ${escapeHtml(run.error || run.status)}</li>`,
                )
                .join("")
            : "<li>No error details</li>"
        }</ul>
        <p>Open the management UI to inspect the run and fix the profile.</p>`;
  return { subject, summary, text, html };
}

export function composeTestNotification(channel: "email" | "whatsapp"): MailContent {
  const via = channel === "whatsapp" ? "WhatsApp" : "email";
  const subject = `[TEST] Visa Appointment Finder (${via})`;
  const summary = `Test ${via} notification`;
  const text = `This is a test ${via} message from Visa Appointment Finder. If you received it, this channel is working.`;
  return { subject, summary, text, html: `<p>${text}</p>` };
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
    const content = composeHeartbeatNotification(options);
    await this.emailService.sendMail(
      options.destination,
      content.subject,
      content.html,
    );
    return content;
  }

  async sendFailureAlarm(options: {
    destination: string;
    profileName: string;
    visaEmail: string;
    visaProcessId: string;
    threshold: number;
    errors: { startedAt: string; status: string; error: string | null }[];
  }): Promise<MailContent> {
    const content = composeFailureAlarm(options);
    await this.emailService.sendMail(
      options.destination,
      content.subject,
      content.html,
    );
    return content;
  }

  async sendTestNotification(options: {
    destination: string;
    channel: "email" | "whatsapp";
  }): Promise<MailContent> {
    const content = composeTestNotification(options.channel);
    await this.emailService.sendMail(
      options.destination,
      content.subject,
      content.html,
    );
    return content;
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
    const content = composeAppointmentNotification(options);
    await this.emailService.sendMail(
      to,
      content.subject,
      content.html,
      options.bcc,
    );
    return content;
  }
}
