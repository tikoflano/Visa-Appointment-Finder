export enum Action {
  Notify = "notify",
  Reschedule = "reschedule",
}

export interface Config {
  headless: boolean;
  action: Action[];
  maxDate: string;
  minDate: string;
  heartbeat: boolean;
}

export interface ParsedConfig {
  headless: boolean;
  action: Action[];
  maxDate?: Date;
  minDate?: Date;
  heartbeat: boolean;
}

