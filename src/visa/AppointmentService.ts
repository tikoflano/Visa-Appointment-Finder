import { Page } from "playwright";
import {
  abbreviateVisaClass,
  parseRescheduleLimit,
  type RescheduleLimit,
} from "../botResult";
import { formatDate, parseDateAsUtc } from "../utils/dateUtils";

export class AppointmentService {
  private page: Page;
  rescheduleLimit: RescheduleLimit | null = null;

  constructor(page: Page) {
    this.page = page;
  }

  private processId(): string {
    const id = process.env.VISA_PROCESS_ID;
    if (!id) throw new Error("Missing VISA_PROCESS_ID");
    return id;
  }

  private processCard() {
    const id = this.processId();
    return this.page.locator(".application").filter({
      has: this.page.locator(
        `a[href="/en-cl/niv/schedule/${id}/continue_actions"]`,
      ),
    });
  }

  private async getFormMethod(): Promise<string> {
    const form = this.page.locator("form");
    await form.waitFor();
    return await form.evaluate((f: HTMLFormElement) => f.method);
  }

  async waitForHomePage(): Promise<void> {
    await this.page.waitForURL(
      "https://ais.usvisa-info.com/en-cl/niv/groups/*",
    );
    console.log("Home page loaded");
  }

  async checkIfVisaProcessExists(): Promise<void> {
    const visaProcess = this.page.locator(
      `a[href="/en-cl/niv/schedule/${this.processId()}/continue_actions"]`,
    );
    try {
      await visaProcess.waitFor({ state: "visible", timeout: 1000 });
      console.log("Visa process found");
    } catch (error) {
      throw new Error("Visa process not found");
    }
  }

  async getCurrentAppointmentDate(): Promise<Date | undefined> {
    const getDirectionsLink = this.page.locator(
      `a[href="/en-cl/niv/schedule/${this.processId()}/addresses/consulate"]`,
    );
    const consularAppointment = this.processCard()
      .locator(".consular-appt")
      .filter({ has: getDirectionsLink });

    try {
      const consularAppointmentDetails = await consularAppointment.innerText({
        timeout: 1000,
      });

      return parseDateAsUtc(
        consularAppointmentDetails.substring(
          consularAppointmentDetails.indexOf(":") + 2,
          consularAppointmentDetails.lastIndexOf(","),
        ),
      );
    } catch (error) {
      console.log("Current appointment not found");
      return undefined;
    }
  }

  /**
   * Abbreviated Visa Class codes for applicants on this process card.
   * Finds the column by thead "Visa Class" (Petition and other columns shift the index).
   * Uses textContent so Foundation's show-for-medium column still works.
   */
  async getVisaClasses(): Promise<string[]> {
    const card = this.processCard();
    await card.first().waitFor({ state: "attached", timeout: 5000 });

    const labels = await card.locator("table").evaluate((table) => {
      const headers = [...table.querySelectorAll("thead th")].map((th) =>
        (th.textContent || "").trim().toLowerCase(),
      );
      const index = headers.findIndex((label) => label === "visa class");
      if (index < 0) return { error: "Visa Class column not found", labels: [] as string[] };
      const labels = [...table.querySelectorAll("tbody tr")].map((row) => {
        const cells = row.querySelectorAll("td");
        return cells[index]?.textContent?.trim() || "";
      });
      return { error: null as string | null, labels };
    });

    if (labels.error) {
      throw new Error(labels.error);
    }

    const classes: string[] = [];
    for (const label of labels.labels) {
      const code = abbreviateVisaClass(label);
      if (code) classes.push(code);
    }
    if (!classes.length) {
      throw new Error("No visa classes found for this process");
    }
    console.log(`Visa classes: ${classes.join(", ")}`);
    return classes;
  }

  async handleCheckboxSteps(): Promise<void> {
    let method = await this.getFormMethod();

    // Continue while the form uses GET (checkbox confirmation steps).
    // One of these is the Scheduling Limit Warning: check "I understand",
    // then Continue. The warning text states the cancellation/reschedule cap.
    while (method.toLowerCase() === "get") {
      console.log("Checkbox step detected");
      const pageText = await this.page.locator("body").innerText();
      const limit = parseRescheduleLimit(pageText);
      if (limit) {
        this.rescheduleLimit = limit;
        console.log(
          `Reschedule limit: ${limit.remaining} of ${limit.maximum} remaining`,
        );
      }

      const checkboxes = this.page.locator("input[type=checkbox]");
      const checkboxesCount = await checkboxes.count();

      for (let i = 0; i < checkboxesCount; i++) {
        if (!(await checkboxes.nth(i).isChecked())) {
          const parent = checkboxes.nth(i).locator("xpath=..");
          await parent.click();
        }
      }

      await this.page.click("input[type='submit']");

      method = await this.getFormMethod();
    }
  }

  async findAvailableAppointments(): Promise<Date[]> {
    // Get available appointments
    await this.page.goto(
      `https://ais.usvisa-info.com/en-cl/niv/schedule/${this.processId()}/appointment`,
    );

    await this.handleCheckboxSteps();

    const response = await this.page.waitForResponse(/appointment\/days/);
    const appointments: { date: string }[] = await response.json();

    return appointments.map(({ date }) => new Date(date));
  }

  filterAppointments(dates: Date[], minDate?: Date, maxDate?: Date): Date[] {
    let possibleDates = dates;

    if (maxDate) {
      possibleDates = possibleDates.filter((date) => date < maxDate);
    }

    if (minDate) {
      console.log(
        `Searching for appointments on or after ${formatDate(minDate)}`,
      );
      possibleDates = possibleDates.filter((date) => date >= minDate);
    }

    return possibleDates;
  }

  async reschedule(date: Date): Promise<void> {
    console.log(`Rescheduling appointment to ${date}`);

    const year = date.getUTCFullYear();
    const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
    const day = `${date.getUTCDate()}`.padStart(2, "0");

    await this.page
      .locator("#appointments_consulate_appointment_date")
      .evaluate(
        (el: HTMLInputElement, dateStr: string) => (el.value = dateStr),
        `${year}-${month}-${day}`,
      );

    await this.page.click("#appointments_consulate_appointment_date");
    await this.page.click("a.ui-state-default.ui-state-active");

    await this.page
      .locator("#appointments_consulate_appointment_time")
      .selectOption({ index: 1 });

    await this.page.click("#appointments_submit");
    await this.page.getByText("Confirm").click();
  }
}
