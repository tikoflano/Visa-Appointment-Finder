import { Page } from "playwright";
import { formatDate } from "../utils/dateUtils";

export class AppointmentService {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  private async getFormMethod(): Promise<string> {
    const form = this.page.locator("form");
    await form.waitFor();
    return await form.evaluate((f: HTMLFormElement) => f.method);
  }

  async getCurrentAppointmentDate(): Promise<Date> {
    const getDirectionsLink = this.page.locator(
      `a[href="/en-cl/niv/schedule/${process.env.VISA_PROCESS_ID}/addresses/consulate"]`,
    );
    const consularAppointment = this.page
      .locator(".consular-appt")
      .filter({ has: getDirectionsLink });

    const consularAppointmentDetails = await consularAppointment.innerText();

    if (!consularAppointmentDetails) {
      throw Error("Current appointment not found");
    }

    return new Date(
      consularAppointmentDetails.substring(
        consularAppointmentDetails.indexOf(":") + 2,
        consularAppointmentDetails.lastIndexOf(","),
      ),
    );
  }

  async handleCheckboxSteps(): Promise<void> {
    let method = await this.getFormMethod();

    // Continue while the form uses GET (checkbox confirmation steps)
    while (method.toLowerCase() === "get") {
      console.log("Checkbox step detected");
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
      `https://ais.usvisa-info.com/en-cl/niv/schedule/${process.env.VISA_PROCESS_ID}/appointment`,
    );

    await this.handleCheckboxSteps();

    const response = await this.page.waitForResponse(/appointment\/days/);
    const appointments: { date: string }[] = await response.json();

    if (!appointments.length) {
      throw Error("No appointments available");
    }

    return appointments.map(({ date }) => new Date(date));
  }

  filterAppointments(
    dates: Date[],
    minDate?: Date,
    maxDate?: Date,
  ): Date[] {
    let possibleDates = dates;

    if (maxDate) {
      possibleDates = possibleDates.filter((date) => date < maxDate);
    }

    if (minDate) {
      console.log(`Searching for appointments after ${minDate}`);
      possibleDates = possibleDates.filter((date) => date >= minDate);
    }

    return possibleDates;
  }

  async reschedule(date: Date): Promise<void> {
    console.log(`Rescheduling appointment to ${date}`);

    const year = date.getFullYear();
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

