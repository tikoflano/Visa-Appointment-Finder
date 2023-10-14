import { Browser, BrowserContext, chromium } from "playwright";
import dotenv from "dotenv";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import nodemailer from "nodemailer";

dotenv.config();

enum Action {
  Notify = "notify",
  Reschedule = "reschedule",
}

(async () => {
  let browser: Browser | undefined, context: BrowserContext | undefined;

  try {
    const argv = yargs(hideBin(process.argv))
      .options({
        headless: {
          type: "boolean",
          alias: "h",
          describe: "Headless mode.",
          default: false,
        },
        action: {
          type: "array",
          alias: "a",
          choices: Object.values(Action),
          describe: "What to do when an appointment is found.",
          default: [] as Action[],
        },
        maxDate: {
          type: "string",
          alias: "max-date",
          describe:
            "If set, the appointment must be before this date. If not set, it will use your current appointment date. Format: MM/DD/YYYY",
          default: "",
        },
        minDate: {
          type: "string",
          alias: "min-date",
          describe:
            "If set, the appointment must be after or at this date. Format: MM/DD/YYYY",
          default: "",
        },
      })
      .strict()
      .parseSync();

    let maxDate: Date | undefined;
    let minDate: Date | undefined;

    // Validate input
    if (argv.maxDate) {
      maxDate = new Date(argv.maxDate);
      if (isNaN(+maxDate)) {
        throw Error("Invalid maxDate date provided");
      }
    }

    if (argv.minDate) {
      minDate = new Date(argv.minDate);
      if (isNaN(+minDate)) {
        throw Error("Invalid minDate provided");
      }
    }

    browser = await chromium.launch({
      headless: argv.headless,
    });
    context = await browser.newContext();
    const page = await context.newPage();

    const user_email = process.env.VISA_USER_EMAIL;
    const user_password = process.env.VISA_USER_PASSWORD;

    if (!user_email || !user_password) {
      throw Error("Missing credentials");
    }

    console.log("Process started");

    await page.goto("https://ais.usvisa-info.com/en-cl/niv/users/sign_in");

    // Fill login form
    await page.fill("#user_email", user_email);
    await page.fill("#user_password", user_password);
    await page.evaluate(() =>
      (document.querySelector("#policy_confirmed") as HTMLElement).click(),
    );
    await page.click(".button[type='submit']");

    // Check if logged in correctly
    const selectors = [
      "a[href='/en-cl/niv/users/sign_out']",
      "form .error",
      ".infoPopUp",
    ];

    const postLoginSelector = await Promise.race(
      selectors.map((selector) =>
        page
          .waitForSelector(selector, { state: "attached" })
          .then(() => selector),
      ),
    );

    if (postLoginSelector !== selectors[0]) {
      throw Error("Login failed");
    }

    console.log("Logged in successfully");

    await page.waitForURL("https://ais.usvisa-info.com/en-cl/niv/groups/*");

    if (!maxDate) {
      // Use current appointment date
      const getDirectionsLink = page.locator(
        `a[href="/en-cl/niv/schedule/${process.env.VISA_PROCESS_ID}/addresses/consulate"]`,
      );
      const consularAppointment = page
        .locator(".consular-appt")
        .filter({ has: getDirectionsLink });

      const consularAppointmentDetails = await consularAppointment.innerText();

      if (!consularAppointmentDetails) {
        throw Error("Current appointment not found");
      }

      maxDate = new Date(
        consularAppointmentDetails.substring(
          consularAppointmentDetails.indexOf(":") + 2,
          consularAppointmentDetails.lastIndexOf(","),
        ),
      );
    }

    console.log(`Searching for appointments before ${maxDate}`);

    // Get available appointments
    await page.goto(
      `https://ais.usvisa-info.com/en-cl/niv/schedule/${process.env.VISA_PROCESS_ID}/appointment`,
    );

    await page.click("input[type='submit']");

    const response = await page.waitForResponse(/appointment\/days/);
    const appointments: { date: string }[] = await response.json();

    if (!appointments.length) {
      throw Error("No appointments available");
    }

    const dates = appointments.map(({ date }) => new Date(date));

    let possibleDates = dates.filter((date) => date < maxDate!);

    if (minDate) {
      console.log(`Searching for appointments after ${minDate}`);
      possibleDates = possibleDates.filter((date) => date >= minDate!);
    }

    // Check if there is a date available
    if (!possibleDates.length) {
      console.log("No appointment available");
      return;
    }

    const firstDate = possibleDates[0];

    console.log(`Appointment available on ${firstDate}`);

    let extraDates = "";
    if (possibleDates.length > 1) {
      extraDates = possibleDates.slice(1).join(" / ");
      console.log(`Other available appointments: ${extraDates}`);
    }

    if (!argv.action.length) {
      console.log("No action taken");
      return;
    }

    if (argv.action.includes(Action.Notify)) {
      // Send email
      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        auth: {
          user: process.env.GMAIL_APP_USER,
          pass: process.env.GMAIL_APP_PASSWORD,
        },
      });

      await transporter.sendMail({
        from: `Visa Appointment Scheduler<${process.env.GMAIL_APP_USER}>`,
        to: process.env.EMAIL_DESTINATION,
        subject: "Visa appointment available",
        html:
          `There is a visa appointment available on ${firstDate}. 
        Go to https://ais.usvisa-info.com/en-cl/niv/schedule/${process.env.VISA_PROCESS_ID}/appointment to schedule it. ` +
          (extraDates ? `Other available appointments: ${extraDates}` : ""),
      });
      console.log("Email notification sent");
    }

    if (argv.action.includes(Action.Reschedule)) {
      console.log(`Rescheduling appointment to ${firstDate}`);

      const year = firstDate.getFullYear();
      const month = `${firstDate.getUTCMonth() + 1}`.padStart(2, "0");
      const day = `${firstDate.getUTCDate()}`.padStart(2, "0");

      await page
        .locator("#appointments_consulate_appointment_date")
        .evaluate(
          (el: HTMLInputElement, date: string) => (el.value = date),
          `${year}-${month}-${day}`,
        );

      await page.click("#appointments_consulate_appointment_date");
      await page.click("a.ui-state-default.ui-state-active");

      await page
        .locator("#appointments_consulate_appointment_time")
        .selectOption({ index: 1 });

      await page.click("#appointments_submit");
      await page.getByText("Confirm").click();
      console.log(
        `Rescheduling completed, the new appointment date is ${firstDate}`,
      );
    }
  } catch (error) {
    let message = "Unknown Error";

    if (error instanceof Error) {
      message = error.message;
    }

    console.error(message);
  } finally {
    // Teardown
    if (context) {
      await context.close();
    }

    if (browser) {
      await browser.close();
    }
  }
})();

Date.prototype.toString = function () {
  const dateOptions: Intl.DateTimeFormatOptions = {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
    weekday: "long",
  };

  return this.toLocaleDateString("en-US", dateOptions); // "June 1, 2019"
};
