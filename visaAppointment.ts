import { Browser, BrowserContext, chromium } from "playwright";
import dotenv from "dotenv";
import twilio from "twilio";
import { MessageStatus } from "twilio/lib/rest/api/v2010/account/message";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

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
        date: {
          type: "string",
          alias: "d",
          describe:
            "Provide a current date. If not provided, the bot will parse your current appointment date. Fomat: MM/DD/YYYY",
          default: "",
        },
      })
      .parseSync();

    let currentDate: Date | undefined;

    // Validate input
    if (argv.date) {
      currentDate = new Date(argv.date);
      if (isNaN(+currentDate)) {
        throw Error("Invalid current date provided");
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

    if (currentDate) {
      console.log(`Appointment date manually set to ${currentDate}`);
    } else {
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
    const dates = await response.json();

    if (!dates.length) {
      throw Error("No appointments available");
    }

    const firstDate = new Date(dates[0].date);

    // Check if there is an earlier date available
    if (currentDate <= firstDate) {
      console.log(`No earlier date available, the earliest is ${firstDate}`);
    } else {
      const dateDiff = Math.round(
        (currentDate.getTime() - firstDate.getTime()) / (1000 * 3600 * 24),
      );

      console.log(
        `Earlier appointment available on ${firstDate} (${dateDiff} day(s) earlier)... GO GO GO!`,
      );

      // Send whatsapp notification
      const client = twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN,
      );

      let twilioMessage = await client.messages.create({
        body: `There is an earlier visa appointment available on ${firstDate} (${dateDiff} day(s) earlier than your current one). Go to https://ais.usvisa-info.com/en-cl/niv/schedule/${process.env.VISA_PROCESS_ID}/appointment to schedule it.`,
        from: `whatsapp:${process.env.TWILIO_WHATSAPP_PHONE_NUMBER}`,
        to: `whatsapp:${process.env.NOTIFICATION_PHONE_NUMBER}`,
      });

      try {
        await new Promise<MessageStatus>(async (resolve, reject) => {
          let fulfilled = false;

          const timer = setTimeout(() => {
            fulfilled = true;
            reject(twilioMessage.status);
          }, 10000);

          while (twilioMessage.status !== "delivered" && !fulfilled) {
            twilioMessage = await twilioMessage.fetch();
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }

          clearTimeout(timer);
          resolve(twilioMessage.status);
        });

        console.log("WhatsApp notification sent");
      } catch (messageStatus) {
        console.log(
          `The WhatsApp notification seems to have failed (status: ${messageStatus}). Visit https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn to check if it is set up correctly`,
        );
      }
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
