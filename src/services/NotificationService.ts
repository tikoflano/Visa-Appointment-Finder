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
  whatsapp: string;
}

export interface HeartbeatReport {
  enabledProfiles: { name: string; visaProcessId: string }[];
  recentRuns: { name: string; status: string; startedAt: string }[];
  anySuccess: boolean;
}

const ACCENT = {
  info: "#2457d6",
  ok: "#1d7a46",
  warn: "#a15c07",
  bad: "#b42318",
} as const;

function appointmentUrl(processId: string): string {
  return `https://ais.usvisa-info.com/en-cl/niv/schedule/${processId}/appointment`;
}

function wrapEmail(options: {
  kicker: string;
  title: string;
  body: string;
  accent?: string;
}): string {
  const accent = options.accent || ACCENT.info;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f6f8;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f6f8;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #dde1e8;">
          <tr>
            <td style="background:#16357a;padding:20px 24px;color:#ffffff;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;">
              <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.78;">${escapeHtml(options.kicker)}</div>
              <div style="font-size:20px;font-weight:650;letter-spacing:-0.03em;margin-top:4px;">${escapeHtml(options.title)}</div>
            </td>
          </tr>
          <tr>
            <td style="height:3px;background:${accent};font-size:0;line-height:0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:24px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.5;color:#1d2330;">
              ${options.body}
            </td>
          </tr>
          <tr>
            <td style="padding:14px 24px;background:#f5f6f8;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:12px;line-height:1.45;color:#6b7385;">
              Sent by Visa Appointment Finder
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function emailList(items: string[], empty: string): string {
  const rows = items.length
    ? items.map((item) => `<li style="margin:6px 0;">${item}</li>`).join("")
    : `<li style="margin:6px 0;color:#6b7385;">${escapeHtml(empty)}</li>`;
  return `<ul style="margin:0;padding:0 0 0 18px;">${rows}</ul>`;
}

function whatsappList(items: string[], empty: string): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${empty}`;
}

export function composeAppointmentNotification(options: {
  processId: string;
  dates: Date[];
}): MailContent {
  const formatted = options.dates.map((date) => formatDate(date));
  const first = formatted[0] || "an upcoming date";
  const extras = formatted.slice(1);
  const url = appointmentUrl(options.processId);
  const subject = "Visa appointment available";
  const summary = extras.length
    ? `Available ${first}. Other: ${extras.join(" / ")}`
    : `Available ${first}`;

  const extraText = extras.length
    ? `\n\nOther available appointments:\n${extras.map((date) => `- ${date}`).join("\n")}`
    : "";
  const text = `There is a visa appointment available on ${first}.${extraText}\n\nGo to ${url} to schedule it.`;

  const extraHtml = extras.length
    ? `<p style="margin:20px 0 8px;font-size:13px;font-weight:650;color:#1d2330;">Other available appointments</p>
        ${emailList(extras.map((date) => escapeHtml(date)), "")}`
    : "";
  const html = wrapEmail({
    kicker: "AIS · Chile",
    title: "Visa appointment available",
    accent: ACCENT.ok,
    body: `<p style="margin:0 0 16px;">A matching date opened on the Santiago consulate calendar.</p>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 4px;">
          <tr>
            <td style="padding:14px 16px;background:#eef7f1;border-left:4px solid ${ACCENT.ok};">
              <div style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${ACCENT.ok};font-weight:650;">Earliest date</div>
              <div style="font-size:20px;font-weight:650;letter-spacing:-0.03em;color:#0b1738;margin-top:4px;">${escapeHtml(first)}</div>
            </td>
          </tr>
        </table>
        ${extraHtml}
        <p style="margin:24px 0 0;">
          <a href="${escapeHtml(url)}" style="display:inline-block;background:#2457d6;color:#ffffff;text-decoration:none;padding:12px 18px;font-weight:650;font-size:14px;">Schedule appointment</a>
        </p>
        <p style="margin:12px 0 0;font-size:12px;line-height:1.5;color:#6b7385;">
          Or open this link:<br>
          <a href="${escapeHtml(url)}" style="color:#2457d6;word-break:break-all;">${escapeHtml(url)}</a>
        </p>`,
  });

  const whatsapp = [
    "*Visa appointment available*",
    "",
    "A matching date opened on AIS Chile:",
    "",
    `*${first}*`,
    ...(extras.length
      ? ["", "Other available appointments:", ...extras.map((date) => `- ${date}`)]
      : []),
    "",
    "Schedule it here:",
    url,
  ].join("\n");

  return { subject, summary, text, html, whatsapp };
}

export function composeHeartbeatNotification(options: {
  report: HeartbeatReport;
}): MailContent {
  const healthy = options.report.anySuccess;
  const profileLines = options.report.enabledProfiles.map(
    (profile) => `${profile.name} (${profile.visaProcessId})`,
  );
  const runLines = options.report.recentRuns.map(
    (run) => `${run.startedAt} — ${run.name} — ${run.status}`,
  );
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
  const text = `Scheduled visa appointment checks are running.\n\nEnabled profiles:\n${whatsappList(profileLines, "None enabled")}\n\nLast 5 runs:\n${whatsappList(runLines, "No runs recorded yet")}\n\n${statusLine}`;
  const statusColor = healthy ? ACCENT.ok : ACCENT.warn;
  const html = wrapEmail({
    kicker: "Scheduler",
    title: subject,
    accent: statusColor,
    body: `<p style="margin:0 0 16px;">Scheduled visa appointment checks are running.</p>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 20px;">
          <tr>
            <td style="padding:12px 14px;background:${healthy ? "#eef7f1" : "#fbf3e6"};border-left:4px solid ${statusColor};">
              <div style="font-size:13px;font-weight:650;color:${statusColor};">${escapeHtml(statusLine)}</div>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 8px;font-size:13px;font-weight:650;">Enabled profiles</p>
        ${emailList(
          options.report.enabledProfiles.map(
            (profile) =>
              `${escapeHtml(profile.name)} <span style="color:#6b7385;">(${escapeHtml(profile.visaProcessId)})</span>`,
          ),
          "None enabled",
        )}
        <p style="margin:20px 0 8px;font-size:13px;font-weight:650;">Last 5 runs</p>
        ${emailList(
          options.report.recentRuns.map(
            (run) =>
              `${escapeHtml(run.startedAt)} — ${escapeHtml(run.name)} — ${escapeHtml(run.status)}`,
          ),
          "No runs recorded yet",
        )}`,
  });
  const whatsapp = [
    `*${subject}*`,
    "",
    "Scheduled visa appointment checks are running.",
    "",
    `_${statusLine}_`,
    "",
    "*Enabled profiles*",
    whatsappList(
      options.report.enabledProfiles.map(
        (profile) => `${profile.name} (\`${profile.visaProcessId}\`)`,
      ),
      "None enabled",
    ),
    "",
    "*Last 5 runs*",
    whatsappList(runLines, "No runs recorded yet"),
  ].join("\n");
  return { subject, summary, text, html, whatsapp };
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
  const errorLines = options.errors.map(
    (run) => `${run.startedAt} — ${run.error || run.status}`,
  );
  const text = `The scheduler recorded ${options.threshold} consecutive errors for ${options.profileName}.
${options.visaEmail} · process ${options.visaProcessId}
Latest error: ${latestError}

Recent failures:
${whatsappList(errorLines, "No error details")}

Open the management UI to inspect the run and fix the profile.`;
  const html = wrapEmail({
    kicker: "Failure alarm",
    title: `Check failed ${options.threshold} times in a row`,
    accent: ACCENT.bad,
    body: `<p style="margin:0 0 16px;">The scheduler recorded <strong>${options.threshold}</strong> consecutive errors for <strong>${escapeHtml(options.profileName)}</strong>.</p>
        <p style="margin:0 0 16px;color:#6b7385;">${escapeHtml(options.visaEmail)} · process ${escapeHtml(options.visaProcessId)}</p>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 20px;">
          <tr>
            <td style="padding:12px 14px;background:#fdecea;border-left:4px solid ${ACCENT.bad};">
              <div style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${ACCENT.bad};font-weight:650;">Latest error</div>
              <div style="margin-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#1d2330;">${escapeHtml(latestError)}</div>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 8px;font-size:13px;font-weight:650;">Recent failures</p>
        ${emailList(
          options.errors.map(
            (run) =>
              `${escapeHtml(run.startedAt)} — ${escapeHtml(run.error || run.status)}`,
          ),
          "No error details",
        )}
        <p style="margin:20px 0 0;">Open the management UI to inspect the run and fix the profile.</p>`,
  });
  const whatsapp = [
    `*Visa check failed ${options.threshold} times in a row*`,
    "",
    `The scheduler recorded *${options.threshold}* consecutive errors for *${options.profileName}*.`,
    "",
    `${options.visaEmail} · process \`${options.visaProcessId}\``,
    "",
    "Latest error:",
    "```",
    latestError,
    "```",
    "",
    "*Recent failures*",
    whatsappList(errorLines, "No error details"),
    "",
    "Open the management UI to inspect the run and fix the profile.",
  ].join("\n");
  return { subject, summary, text, html, whatsapp };
}

export function composeTestNotification(
  channel: "email" | "whatsapp",
): MailContent {
  const via = channel === "whatsapp" ? "WhatsApp" : "email";
  const subject = `[TEST] Visa Appointment Finder (${via})`;
  const summary = `Test ${via} notification`;
  const text = `This is a test ${via} message from Visa Appointment Finder. If you received it, this channel is working.`;
  const html = wrapEmail({
    kicker: "Test",
    title: "Visa Appointment Finder",
    accent: ACCENT.info,
    body: `<p style="margin:0 0 12px;">This is a test ${via} message.</p>
        <p style="margin:0;color:#6b7385;">If you received it, this channel is working.</p>`,
  });
  const whatsapp = [
    "*Test* from Visa Appointment Finder",
    "",
    "This is a test WhatsApp message.",
    "If you received it, this channel is working.",
  ].join("\n");
  return { subject, summary, text, html, whatsapp };
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
      content.text,
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
      content.text,
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
      content.text,
    );
    return content;
  }

  async sendAppointmentNotification(options: {
    to: string;
    bcc?: string;
    processId: string;
    dates: Date[];
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
      content.text,
      options.bcc,
    );
    return content;
  }
}
