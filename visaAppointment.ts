import { chromium } from "playwright";
import dotenv from "dotenv";
import twilio from "twilio";

dotenv.config();

interface dateOptions {
  timeZone: "UTC";
  month: "long";
  day: "numeric";
  year: "numeric";
}

(async () => {
  const browser = await chromium.launch({
    headless: process.argv[2] !== "--headed",
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  const cur_date = new Date(process.env.CUR_DATE + "");
  const user_email = process.env.VISA_USER_EMAIL;
  const user_password = process.env.VISA_USER_PASSWORD;

  if (!user_email || !user_password) {
    console.error("Missing credentials");
    return;
  }

  await page.goto("https://ais.usvisa-info.com/es-cl/niv/users/sign_in");

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

  await page.waitForURL("https://ais.usvisa-info.com/es-cl/niv/groups/*");

  await page.goto(
    `https://ais.usvisa-info.com/es-cl/niv/schedule/${process.env.VISA_PROCESS_ID}/appointment`,
  );

  await page.click("input[type='submit']");

  const response = await page.waitForResponse(/appointment\/days/);
  const dates = await response.json();

  if (!dates.length) {
    console.log("No dates available");
    process.exit();
  }

  const first_date = new Date(dates[0].date);

  const dateOptions: dateOptions = {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  };
  const first_date_str = first_date.toLocaleDateString("en-US", dateOptions); // "June 1, 2019"

  if (cur_date <= first_date) {
    console.log("No newer date available", first_date_str);
  } else {
    console.log("Newer dates available... GO GO GO!", first_date_str);

    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN,
    );

    await client.messages.create({
      body: `New visa appointment date available on ${first_date_str}. Go to https://ais.usvisa-info.com/es-cl/niv/schedule/${process.env.VISA_PROCESS_ID}/appointment`,
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_PHONE_NUMBER}`,
      to: `whatsapp:${process.env.NOTIFICATION_PHONE_NUMBER}`,
    });
  }

  // Teardown
  await context.close();
  await browser.close();
})();
