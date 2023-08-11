import { Browser, BrowserContext, chromium } from "playwright";
import dotenv from "dotenv";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import nodemailer from "nodemailer";

dotenv.config();

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
        notification: {
          type: "boolean",
          describe: "Send email notification.",
          default: true,
        },
        date: {
          type: "string",
          alias: "d",
          describe:
            "Set the current appointment date. If not set, the bot will get your current one. Fomat: MM/DD/YYYY",
          default: "",
        },
        minDate: {
          type: "string",
          alias: ["m", "min-date"],
          describe:
            "If set, the available appointment must be later than this date. Fomat: MM/DD/YYYY",
          default: "",
        },
      })
      .parseSync();

    let currentDate: Date | undefined;
    let minDate: Date | undefined;

    // Validate input
    if (argv.date) {
      currentDate = new Date(argv.date);
      if (isNaN(+currentDate)) {
        throw Error("Invalid current date provided");
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

    if (currentDate) {
      console.log(`Appointment date manually set to ${currentDate}`);
    } else {
      // Get current appointment date
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

      currentDate = new Date(
        consularAppointmentDetails.substring(
          consularAppointmentDetails.indexOf(":") + 2,
          consularAppointmentDetails.lastIndexOf(","),
        ),
      );

      console.log(`Your current appointment is on ${currentDate}`);
    }

    // Get available dates
    await page.goto(
      `https://ais.usvisa-info.com/en-cl/niv/schedule/${process.env.VISA_PROCESS_ID}/appointment`,
    );

    await page.click("input[type='submit']");

    const response = await page.waitForResponse(/appointment\/days/);
    const datesStr: { date: string }[] = await response.json();

    if (!datesStr.length) {
      throw Error("No appointments available");
    }

    const dates = datesStr.map(({ date }) => new Date(date));

    let earlierDates = dates.filter((date) => date < currentDate!);

    if (minDate) {
      console.log(`Min date to consider is ${minDate}`);
      earlierDates = earlierDates.filter((date) => date >= minDate!);
    }

    // Check if there is an earlier date available
    if (!earlierDates.length) {
      console.log("No earlier date available");
      return;
    }

    const firstDate = earlierDates[0];

    const dateDiff = Math.round(
      (currentDate.getTime() - firstDate.getTime()) / (1000 * 3600 * 24),
    );

    console.log(
      `Earlier appointment available on ${firstDate} (${dateDiff} day(s) earlier)`,
    );

    let extraDates = "";
    if (earlierDates.length > 1) {
      extraDates = earlierDates.slice(1).join(",");
      console.log(`Other available dates: ${extraDates}`);
    }

    if (argv.notification) {
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
        subject: "Earlier visa appointment available",
        html:
          `There is an earlier visa appointment available on ${firstDate} (${dateDiff} day(s) earlier than your current one). 
        Go to https://ais.usvisa-info.com/en-cl/niv/schedule/${process.env.VISA_PROCESS_ID}/appointment to schedule it. ` +
          (extraDates ? `Other available dates: ${extraDates}` : ""),
      });
      console.log("Email notification sent");
    } else {
      console.log("Email notification skipped");
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
