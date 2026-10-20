export enum Action {
  Notify = "notify",
  Reschedule = "reschedule",
}

export interface Config {
  headless: boolean;
  action: Action[];
  maxDate: string;
  minDate: string;
  debug: boolean;
}

export interface ParsedConfig {
  headless: boolean;
  action: Action[];
  maxDate?: Date;
  minDate?: Date;
  debug: boolean;
}

