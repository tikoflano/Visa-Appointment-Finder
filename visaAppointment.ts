import { chromium } from "playwright";
import dotenv from "dotenv";
import twilio from "twilio";

dotenv.config();

(async () => {
  const browser = await chromium.launch({
    headless: process.argv[2] !== "--headed",
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  const user_email = process.env.VISA_USER_EMAIL;
  const user_password = process.env.VISA_USER_PASSWORD;

  if (!user_email || !user_password) {
    console.error("Missing credentials");
    return;
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
  const selectors = ["span.visa-type-indicator", "form .error", ".infoPopUp"];

  const postLoginSelector = await Promise.race(
    selectors.map((selector) =>
      page.waitForSelector(selector).then(() => selector),
    ),
  );

  if (postLoginSelector !== selectors[0]) {
    console.log("Login failed");
    process.exit(1);
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
    console.log("Current appointment not found");
    process.exit();
  }

  const currentDate = new Date(
    consularAppointmentDetails.substring(
      consularAppointmentDetails.indexOf(":") + 2,
      consularAppointmentDetails.lastIndexOf(","),
    ),
  );

  console.log(`Your current appointment is on ${currentDate}`);

  // Get available dates
  await page.goto(
    `https://ais.usvisa-info.com/en-cl/niv/schedule/${process.env.VISA_PROCESS_ID}/appointment`,
  );

  await page.click("input[type='submit']");

  const response = await page.waitForResponse(/appointment\/days/);
  const dates = await response.json();

  if (!dates.length) {
    console.log("No dates available");
    process.exit();
  }

  const firstDate = new Date(dates[0].date);

  // Check if there is an earlier date available
  if (currentDate <= firstDate) {
    console.log("No earlier date available", firstDate);
  } else {
    const dateDiff =
      (currentDate.getTime() - firstDate.getTime()) / (1000 * 3600 * 24);

    console.log(
      `Appointment available ${dateDiff} days(s) earlier... GO GO GO!`,
      firstDate,
    );

    // Send whatsapp notification
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN,
    );

    await client.messages.create({
      body: `There is a visa appointment available on ${firstDate}, ${dateDiff} days(s) earlier than your current one. Go to https://ais.usvisa-info.com/en-cl/niv/schedule/${process.env.VISA_PROCESS_ID}/appointment to schedule it`,
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_PHONE_NUMBER}`,
      to: `whatsapp:${process.env.NOTIFICATION_PHONE_NUMBER}`,
    });
  }

  // Teardown
  await context.close();
  await browser.close();
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
