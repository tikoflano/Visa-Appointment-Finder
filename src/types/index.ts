export enum Action {
  Notify = "notify",
  Reschedule = "reschedule",
}

export interface Config {
  headless: boolean;
  reschedule: boolean;
  /** Login and read booked date + visa classes only; skip calendar search. */
  probe: boolean;
  /** Specific ISO date to book when reschedule is set. Empty = first match. */
  targetDate: string;
  maxDate: string;
  minDate: string;
  debug: boolean;
}

export interface ParsedConfig {
  headless: boolean;
  reschedule: boolean;
  probe: boolean;
  targetDate?: Date;
  maxDate?: Date;
  minDate?: Date;
  debug: boolean;
}
