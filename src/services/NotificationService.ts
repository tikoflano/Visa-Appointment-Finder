import { DatabaseService } from "./DatabaseService";
import { EmailService } from "./EmailService";
import { formatDate } from "../utils/dateUtils";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class NotificationService {
  private databaseService: DatabaseService | null;
  private emailService: EmailService;

  constructor(
    databaseService: DatabaseService | null,
    emailService: EmailService,
  ) {
    this.databaseService = databaseService;
    this.emailService = emailService;
  }

  async sendHeartbeatNotification(options: {
    force?: boolean;
    destination?: string;
    intervalMinutes?: number;
  } = {}): Promise<boolean> {
    const destination =
      options.destination || process.env.HEARTBEAT_DESTINATION;
    const intervalMinutes =
      options.intervalMinutes ?? parseInt(process.env.HEARTBEAT_TIME || "", 10);
    if (!destination || !Number.isFinite(intervalMinutes)) {
      throw Error("HEARTBEAT_* environment variable missing");
    }
    const databaseService = this.databaseService;
    if (!databaseService) {
      throw Error("Database is required to send a heartbeat");
    }

    const claimed = await databaseService.claimHeartbeatIfDue(
      intervalMinutes,
      !!options.force,
    );
    if (!claimed) {
      console.log("Heartbeat notification skipped");
      return false;
    }

    const report = await databaseService.getHeartbeatReport();
    const healthy = report.anySuccess;
    const profileLines = report.enabledProfiles.length
      ? report.enabledProfiles
          .map(
            (profile) =>
              `<li>${escapeHtml(profile.name)} (${escapeHtml(profile.visaProcessId)})</li>`,
          )
          .join("")
      : "<li>None enabled</li>";
    const runLines = report.recentRuns.length
      ? report.recentRuns
          .map(
            (run) =>
              `<li>${escapeHtml(run.startedAt)} — ${escapeHtml(run.name)} — ${escapeHtml(run.status)}</li>`,
          )
          .join("")
      : "<li>No runs recorded yet</li>";
    const statusLine = healthy
      ? "At least one of the last 5 runs succeeded."
      : "None of the last 5 runs succeeded. An admin needs to check the management UI.";

    await this.emailService.sendMail(
      destination,
      healthy
        ? "Visa appointment scheduler is running"
        : "Visa appointment scheduler needs attention",
      `<p>Scheduled visa appointment checks are running.</p>
        <p><strong>Enabled profiles</strong></p>
        <ul>${profileLines}</ul>
        <p><strong>Last 5 runs</strong></p>
        <ul>${runLines}</ul>
        <p><strong>${statusLine}</strong></p>`,
    );
    console.log("Heartbeat notification sent");
    return true;
  }

  async sendAppointmentNotification(
    firstDate: Date,
    extraDates?: string,
  ): Promise<void> {
    const destination = process.env.EMAIL_DESTINATION || undefined;
    const adminDestination = process.env.EMAIL_ADMIN_DESTINATION || undefined;

    const to = destination ?? adminDestination;
    if (!to) {
      throw Error("Destination address not set");
    }

    await this.emailService.sendMail(
      to,
      "Visa appointment available",
      `There is a visa appointment available on ${formatDate(firstDate)}. 
        Go to https://ais.usvisa-info.com/en-cl/niv/schedule/${process.env.VISA_PROCESS_ID}/appointment to schedule it. ` +
        (extraDates ? `Other available appointments: ${extraDates}` : ""),
      destination ? adminDestination : undefined,
    );
  }
}
