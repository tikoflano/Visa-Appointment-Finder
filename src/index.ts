import { parseCliArgs, validateAndParseDates } from "./config/cli";
import { Action } from "./types";
import {
  emptyBotResult,
  formatVisaResult,
  toIsoDate,
  type BotResult,
} from "./botResult";
import { EmailService } from "./services/EmailService";
import { NotificationService } from "./services/NotificationService";
import { BrowserService } from "./services/BrowserService";
import { VisaAuthenticator } from "./visa/VisaAuthenticator";
import { AppointmentService } from "./visa/AppointmentService";
import { addDays, formatDate } from "./utils/dateUtils";

(async () => {
  const emailService = new EmailService();
  const notificationService = new NotificationService(null, emailService);
  const browserService = new BrowserService();
  const result: BotResult = emptyBotResult();

  try {
    const config = parseCliArgs();
    const parsedConfig = validateAndParseDates(config);
    console.log = parsedConfig.debug
      ? (...args: unknown[]) => console.error(...args)
      : () => {};

    await browserService.launch(parsedConfig.headless);
    const page = browserService.getPage();

    const user_email = process.env.VISA_USER_EMAIL;
    const user_password = process.env.VISA_USER_PASSWORD;

    if (!user_email || !user_password) {
      throw Error("Missing credentials");
    }

    const authenticator = new VisaAuthenticator(page);
    const appointmentService = new AppointmentService(page);

    await authenticator.login(user_email, user_password);

    await appointmentService.waitForHomePage();
    await appointmentService.checkIfVisaProcessExists();

    const booked = await appointmentService.getCurrentAppointmentDate();
    result.currentAppointment = booked ? toIsoDate(booked) : null;

    // filterAppointments excludes maxDate, so a user-provided max date is
    // pushed one day forward to make it inclusive.
    let maxDate: Date | undefined;
    if (parsedConfig.maxDate) {
      maxDate = addDays(parsedConfig.maxDate, 1);
      console.log(
        `Searching for appointments on or before ${formatDate(
          parsedConfig.maxDate,
        )}`,
      );
    } else {
      if (!booked) {
        throw new Error(
          "No current appointment found and no max date provided",
        );
      }
      maxDate = booked;
      console.log(`Searching for appointments before ${formatDate(maxDate)}`);
    }

    const dates = await appointmentService.findAvailableAppointments();
    const possibleDates = appointmentService.filterAppointments(
      dates,
      parsedConfig.minDate,
      maxDate,
    );
    result.dates = possibleDates.map(toIsoDate);

    if (!possibleDates.length) {
      result.ok = true;
      result.outcome = "none";
      return;
    }

    result.ok = true;
    result.outcome = "available";

    const firstDate = possibleDates[0];
    let extraDates = "";
    if (possibleDates.length > 1) {
      extraDates = possibleDates
        .slice(1)
        .map((d) => formatDate(d))
        .join(" / ");
    }

    if (parsedConfig.action.includes(Action.Notify)) {
      await notificationService.sendAppointmentNotification(
        firstDate,
        extraDates,
      );
      result.notified = true;
    }

    if (parsedConfig.action.includes(Action.Reschedule)) {
      await appointmentService.reschedule(firstDate);
      result.rescheduled = true;
      result.currentAppointment = toIsoDate(firstDate);
    }
  } catch (error) {
    result.ok = false;
    result.outcome = "error";
    result.error =
      error instanceof Error && error.message
        ? error.message
        : "Unknown error";
    process.exitCode = 1;
  } finally {
    process.stdout.write(formatVisaResult(result));
    await browserService.close();
  }
})();
