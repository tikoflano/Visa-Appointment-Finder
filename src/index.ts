import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { Database, open } from "sqlite";
import { parseCliArgs, validateAndParseDates } from "./config/cli";
import { Action } from "./types";
import { DatabaseService } from "./services/DatabaseService";
import { EmailService } from "./services/EmailService";
import { NotificationService } from "./services/NotificationService";
import { BrowserService } from "./services/BrowserService";
import { VisaAuthenticator } from "./visa/VisaAuthenticator";
import { AppointmentService } from "./visa/AppointmentService";
import { formatDate } from "./utils/dateUtils";

dotenv.config();

(async () => {
  const db = await open({
    filename: "./db.sqlite",
    driver: sqlite3.Database,
  });

  const emailService = new EmailService();
  const databaseService = new DatabaseService(db);
  const notificationService = new NotificationService(
    databaseService,
    emailService,
  );
  const browserService = new BrowserService();

  let processCompletedSuccessfully = false;
  let heartbeatEnabled = false;

  try {
    await databaseService.initialize();

    const config = parseCliArgs();
    const parsedConfig = validateAndParseDates(config);
    heartbeatEnabled = parsedConfig.heartbeat;

    await browserService.launch(parsedConfig.headless);
    const page = browserService.getPage();

    const user_email = process.env.VISA_USER_EMAIL;
    const user_password = process.env.VISA_USER_PASSWORD;

    if (!user_email || !user_password) {
      throw Error("Missing credentials");
    }

    await databaseService.log("Process started");

    const authenticator = new VisaAuthenticator(page);
    await authenticator.login(user_email, user_password);

    const appointmentService = new AppointmentService(page);

    let maxDate = parsedConfig.maxDate;
    if (!maxDate) {
      maxDate = await appointmentService.getCurrentAppointmentDate();
    }

    console.log(`Searching for appointments before ${maxDate}`);

    const dates = await appointmentService.findAvailableAppointments();
    const possibleDates = appointmentService.filterAppointments(
      dates,
      parsedConfig.minDate,
      maxDate,
    );

    // Check if there is a date available
    if (!possibleDates.length) {
      await databaseService.log("No appointment available");
      processCompletedSuccessfully = true;
      return;
    }

    const firstDate = possibleDates[0];

    await databaseService.log(`Appointment available on ${formatDate(firstDate)}`);

    let extraDates = "";
    if (possibleDates.length > 1) {
      extraDates = possibleDates
        .slice(1)
        .map((d) => formatDate(d))
        .join(" / ");
      await databaseService.log(`Other available appointments: ${extraDates}`);
    }

    if (!parsedConfig.action.length) {
      await databaseService.log("No action taken");
      processCompletedSuccessfully = true;
      return;
    }

    if (parsedConfig.action.includes(Action.Notify)) {
      await notificationService.sendAppointmentNotification(firstDate, extraDates);
    }

    if (parsedConfig.action.includes(Action.Reschedule)) {
      await appointmentService.reschedule(firstDate);
      await databaseService.log(
        `Rescheduling completed, the new appointment date is ${formatDate(firstDate)}`,
      );
    }

    processCompletedSuccessfully = true;
  } catch (error) {
    let message = "Unknown Error";

    if (error instanceof Error) {
      message = error.message;
    }

    await databaseService.log(message, true);
  } finally {
    // Send heartbeat notification if enabled and process completed successfully
    if (heartbeatEnabled && processCompletedSuccessfully) {
      await notificationService.sendHeartbeatNotification();
    }

    // Teardown
    await databaseService.close();
    await browserService.close();
  }
})();

