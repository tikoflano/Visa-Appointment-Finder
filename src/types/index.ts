export enum Action {
  Notify = "notify",
  Reschedule = "reschedule",
}

export interface Config {
  headless: boolean;
  reschedule: boolean;
  maxDate: string;
  minDate: string;
  debug: boolean;
}

export interface ParsedConfig {
  headless: boolean;
  reschedule: boolean;
  maxDate?: Date;
  minDate?: Date;
  debug: boolean;
}
