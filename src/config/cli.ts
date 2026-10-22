import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { Config, ParsedConfig } from "../types";
import { parseDateAsUtc } from "../utils/dateUtils";

export function parseCliArgs(): Config {
  return yargs(hideBin(process.argv))
    .options({
      headless: {
        type: "boolean",
        alias: "h",
        describe: "Headless mode.",
        default: false,
      },
      reschedule: {
        type: "boolean",
        describe:
          "Book the first matching date. The server decides whether to pass this.",
        default: false,
      },
      probe: {
        type: "boolean",
        describe:
          "Validate credentials and read booked date plus visa classes only. Skip the appointment calendar.",
        default: false,
      },
      maxDate: {
        type: "string",
        alias: "max-date",
        describe:
          "If set, the appointment must be on or before this date. If not set, the appointment must be before your current appointment date. Format: MM/DD/YYYY",
        default: "",
      },
      minDate: {
        type: "string",
        alias: "min-date",
        describe:
          "If set, the appointment must be on or after this date. Format: MM/DD/YYYY",
        default: "",
      },
      debug: {
        type: "boolean",
        describe: "Print step-by-step bot messages on stderr.",
        default: false,
      },
    })
    .strict()
    .parseSync();
}

export function validateAndParseDates(config: Config): ParsedConfig {
  let maxDate: Date | undefined;
  let minDate: Date | undefined;

  if (config.maxDate) {
    maxDate = parseDateAsUtc(config.maxDate);
    if (isNaN(+maxDate)) {
      throw Error("Invalid maxDate date provided");
    }
  }

  if (config.minDate) {
    minDate = parseDateAsUtc(config.minDate);
    if (isNaN(+minDate)) {
      throw Error("Invalid minDate provided");
    }
  }

  return {
    headless: config.headless,
    reschedule: config.reschedule,
    probe: config.probe,
    maxDate,
    minDate,
    debug: config.debug,
  };
}
