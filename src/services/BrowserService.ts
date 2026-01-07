import { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright-extra";

const StealthPlugin = require("puppeteer-extra-plugin-stealth");
chromium.use(StealthPlugin());

export class BrowserService {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;

  async launch(headless: boolean): Promise<void> {
    this.browser = await chromium.launch({
      headless,
    });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
  }

  getPage(): Page {
    if (!this.page) {
      throw Error("Browser not launched. Call launch() first.");
    }
    return this.page;
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
    }

    if (this.browser) {
      await this.browser.close();
    }
  }
}

