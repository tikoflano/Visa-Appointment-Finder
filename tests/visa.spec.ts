import { test } from "@playwright/test";
import "dotenv/config";
import twilio from "twilio";

interface dateOptions {
  timeZone: "UTC";
  month: "long";
  day: "numeric";
  year: "numeric";
}

test("get available days", async ({ page }) => {
  const cur_date = new Date(process.env.CUR_DATE);
  const user_email = process.env.VISA_USER_EMAIL;
  const user_password = process.env.VISA_USER_PASSWORD;

  if (!user_email || !user_password) {
    console.error("Missing credentials");
    return;
  }

  await page.goto("https://ais.usvisa-info.com/es-cl/niv/users/sign_in");
  await page.fill("#user_email", user_email);
  await page.fill("#user_password", user_password);
  await page.evaluate(() =>
    (document.querySelector("#policy_confirmed") as HTMLElement).click()
  );
  await page.click(".button[type='submit']");
  await page.goto(
    "https://ais.usvisa-info.com/es-cl/niv/schedule/39954283/appointment"
  );
  const response = await page.waitForResponse(/appointment\/days/);
  const body = await response.json();

  const first_date = new Date(body[0].date);

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
      process.env.TWILIO_ACCOUNT_ID,
      process.env.TWILIO_AUTH_TOKEN
    );

    await client.messages.create({
      body: `Your appointment is coming up on earlier at ${first_date_str}`,
      from: "whatsapp:+14155238886",
      to: `whatsapp:${process.env.NOTIFICATION_PHONE_NUMBER}`,
    });
  }
});
