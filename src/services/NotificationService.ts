import { DatabaseService } from "./DatabaseService";
import { EmailService } from "./EmailService";
import { formatDate } from "../utils/dateUtils";

export class NotificationService {
  private databaseService: DatabaseService;
  private emailService: EmailService;

  constructor(
    databaseService: DatabaseService,
    emailService: EmailService,
  ) {
    this.databaseService = databaseService;
    this.emailService = emailService;
  }

  async sendHeartbeatNotification(): Promise<void> {
    if (!process.env.HEARTBEAT_TIME || !process.env.HEARTBEAT_DESTINATION) {
      throw Error("HEARTBEAT_* environment variable missing");
    }

    const heartbeat_notification = await this.databaseService.getLastHeartbeatNotification();

    heartbeat_notification &&
      console.log(
        `Last heartbeat notifcation was sent on ${heartbeat_notification["timestamp"]}`,
      );

    if (
      !heartbeat_notification ||
      Math.floor(
        (+new Date() - +new Date(heartbeat_notification["timestamp"])) /
          1000 /
          60,
      ) > parseInt(process.env.HEARTBEAT_TIME)
    ) {
      await this.emailService.sendMail(
        process.env.HEARTBEAT_DESTINATION,
        "Visa appointment scheduler is running",
        "This is just to let you know that the script is currently running",
      );

      console.log("Heartbeat notifcation sent");

      await this.databaseService.insertHeartbeatNotification();
    } else {
      console.log("Heartbeat notifcation skipped");
    }
  }

  async sendAppointmentNotification(
    firstDate: Date,
    extraDates?: string,
  ): Promise<void> {
    if (!process.env.EMAIL_DESTINATION) {
      throw Error("Destination address not set");
    }

    await this.emailService.sendMail(
      process.env.EMAIL_DESTINATION,
      "Visa appointment available",
      `There is a visa appointment available on ${formatDate(firstDate)}. 
        Go to https://ais.usvisa-info.com/en-cl/niv/schedule/${process.env.VISA_PROCESS_ID}/appointment to schedule it. ` +
        (extraDates ? `Other available appointments: ${extraDates}` : ""),
    );
    await this.databaseService.log("Email notification sent");
  }
}

