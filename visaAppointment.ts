import { Browser, BrowserContext, chromium } from "playwright";
import dotenv from "dotenv";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import nodemailer from "nodemailer";
import sqlite3 from "sqlite3";
import { Database, open } from "sqlite";

dotenv.config();

enum Action {
  Notify = "notify",
  Reschedule = "reschedule",
}

let db: Database<sqlite3.Database, sqlite3.Statement>;

(async () => {
  db = await open({
    filename: "./db.sqlite",
    driver: sqlite3.Database,
  });

  let browser: Browser | undefined, context: BrowserContext | undefined;

  try {
    await db.run(
      `
      CREATE TABLE IF NOT EXISTS 
      log (
        id INTEGER PRIMARY KEY,
        timestamp DATE DEFAULT (datetime('now','localtime')),
        visa_process_id INTEGER,
        message TEXT
      );
    `,
    );

    await db.run(
      `
      CREATE TABLE IF NOT EXISTS 
      heartbeat_notification (
        id INTEGER PRIMARY KEY,
        timestamp DATE DEFAULT (datetime('now','localtime')),
        visa_process_id INTEGER
      );
    `,
    );

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
        heartbeat: {
          type: "boolean",
          alias: "hb",
          describe: "Enable heartbeat notifications",
          default: false,
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

    await logInDatabase("Process started");

    if (argv.heartbeat) {
      if (!process.env.HEARTBEAT_TIME || !process.env.HEARTBEAT_DESTINATION) {
        throw Error("HEARTBEAT_* environment variable missing");
      }

      const heartbeat_notification = await db.get(
        "SELECT * FROM heartbeat_notification WHERE visa_process_id = ? ORDER BY id DESC",
        [process.env.VISA_PROCESS_ID],
      );

      heartbeat_notification && console.log(
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
        await sendMail(
          process.env.HEARTBEAT_DESTINATION,
          "Visa appointment scheduler is running",
          "This is just to let you know that the script is currently running",
        );

        console.log("Heartbeat notifcation sent");

        await db.run(
          "INSERT INTO heartbeat_notification (visa_process_id) VALUES (?)",
          [process.env.VISA_PROCESS_ID],
        );
      } else {
        console.log("Heartbeat notifcation skipped");
      }
    }

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

    const form = page.locator("form")
    await form.waitFor();
    const formMethod = await form.evaluate((form: HTMLFormElement) => form.method);

    // Continue when it is a multi person appointment
    if(formMethod.toLowerCase() === "get") {
      console.log("Multi person appointment detected")
      await page.click("input[type='submit']");
    }

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
      await logInDatabase("No appointment available");
      return;
    }

    const firstDate = possibleDates[0];

    await logInDatabase(`Appointment available on ${firstDate}`);

    let extraDates = "";
    if (possibleDates.length > 1) {
      extraDates = possibleDates.slice(1).join(" / ");
      await logInDatabase(`Other available appointments: ${extraDates}`);
    }

    if (!argv.action.length) {
      await logInDatabase("No action taken");
      return;
    }

    if (argv.action.includes(Action.Notify)) {
      if (!process.env.EMAIL_DESTINATION) {
        throw Error("Destination address not set");
      }

      await sendMail(
        process.env.EMAIL_DESTINATION + "",
        "Visa appointment available",
        `There is a visa appointment available on ${firstDate}. 
        Go to https://ais.usvisa-info.com/en-cl/niv/schedule/${process.env.VISA_PROCESS_ID}/appointment to schedule it. ` +
          (extraDates ? `Other available appointments: ${extraDates}` : ""),
      );
      await logInDatabase("Email notification sent");
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
      await logInDatabase(
        `Rescheduling completed, the new appointment date is ${firstDate}`,
      );
    }
  } catch (error) {
    let message = "Unknown Error";

    if (error instanceof Error) {
      message = error.message;
    }

    await logInDatabase(message, true);
  } finally {
    // Teardown
    await db.close();

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

async function logInDatabase(message: string, error = false) {
  await db.run("INSERT INTO log (visa_process_id, message) VALUES (?, ?)", [
    process.env.VISA_PROCESS_ID,
    message,
  ]);

  console[error ? "error" : "log"](message);
}

async function sendMail(to: string, subject: string, html: string) {
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
    to,
    subject,
    html,
  });
}
