import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { Action, Config, ParsedConfig } from "../types";

export function parseCliArgs(): Config {
  return yargs(hideBin(process.argv))
    .options({
      headless: {
        type: "boolean",
        alias: "h",
        describe: "Headless mode.",
        default: false,
      },
      action: {
        type: "array",
        alias: "a",
        choices: Object.values(Action),
        describe: "What to do when an appointment is found.",
        default: [] as Action[],
      },
      maxDate: {
        type: "string",
        alias: "max-date",
        describe:
          "If set, the appointment must be before this date. If not set, it will use your current appointment date. Format: MM/DD/YYYY",
        default: "",
      },
      minDate: {
        type: "string",
        alias: "min-date",
        describe:
          "If set, the appointment must be after or at this date. Format: MM/DD/YYYY",
        default: "",
      },
      heartbeat: {
        type: "boolean",
        alias: "hb",
        describe: "Enable heartbeat notifications",
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
    maxDate = new Date(config.maxDate);
    if (isNaN(+maxDate)) {
      throw Error("Invalid maxDate date provided");
    }
  }

  if (config.minDate) {
    minDate = new Date(config.minDate);
    if (isNaN(+minDate)) {
      throw Error("Invalid minDate provided");
    }
  }

  return {
    headless: config.headless,
    action: config.action,
    maxDate,
    minDate,
    heartbeat: config.heartbeat,
  };
}

