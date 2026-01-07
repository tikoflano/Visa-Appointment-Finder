import { Page } from "playwright";

export class VisaAuthenticator {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async login(email: string, password: string): Promise<void> {
    if (!email || !password) {
      throw Error("Missing credentials");
    }

    await this.page.goto("https://ais.usvisa-info.com/en-cl/niv/users/sign_in");

    // Fill login form
    await this.page.fill("#user_email", email);
    await this.page.fill("#user_password", password);
    await this.page.evaluate(() =>
      (document.querySelector("#policy_confirmed") as HTMLElement).click(),
    );
    await this.page.click(".button[type='submit']");

    // Check if logged in correctly
    const selectors = [
      "a[href='/en-cl/niv/users/sign_out']",
      "form .error",
      ".infoPopUp",
    ];

    const postLoginSelector = await Promise.race(
      selectors.map((selector) =>
        this.page
          .waitForSelector(selector, { state: "attached" })
          .then(() => selector),
      ),
    );

    if (postLoginSelector !== selectors[0]) {
      throw Error("Login failed");
    }

    console.log("Logged in successfully");

    await this.page.waitForURL("https://ais.usvisa-info.com/en-cl/niv/groups/*");
  }
}

