export enum Action {
  Notify = "notify",
  Reschedule = "reschedule",
}

export interface Config {
  headless: boolean;
  reschedule: boolean;
  /** Login and read booked date + visa classes only; skip calendar search. */
  probe: boolean;
  maxDate: string;
  minDate: string;
  debug: boolean;
}

export interface ParsedConfig {
  headless: boolean;
  reschedule: boolean;
  probe: boolean;
  maxDate?: Date;
  minDate?: Date;
  debug: boolean;
}
