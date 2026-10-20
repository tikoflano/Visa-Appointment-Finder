import { addDays, parseDateAsUtc } from "./utils/dateUtils";

export const VISA_RESULT_PREFIX = "VISA_RESULT ";

export type BotOutcome = "none" | "available" | "error";

export interface BotResult {
  ok: boolean;
  outcome: BotOutcome;
  currentAppointment: string | null;
  dates: string[];
  error: string | null;
  notified: boolean;
  rescheduled: boolean;
}

export function emptyBotResult(): BotResult {
  return {
    ok: false,
    outcome: "error",
    currentAppointment: null,
    dates: [],
    error: null,
    notified: false,
    rescheduled: false,
  };
}

export function formatVisaResult(result: BotResult): string {
  return `${VISA_RESULT_PREFIX}${JSON.stringify(result)}\n`;
}

export function parseVisaResult(stdout: string): BotResult | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith(VISA_RESULT_PREFIX)) continue;
    try {
      return normalizeBotResult(
        JSON.parse(line.slice(VISA_RESULT_PREFIX.length)),
      );
    } catch {
      return null;
    }
  }
  return null;
}

export function normalizeBotResult(raw: unknown): BotResult {
  const value = (raw ?? {}) as Partial<BotResult>;
  const outcome: BotOutcome =
    value.outcome === "none" ||
    value.outcome === "available" ||
    value.outcome === "error"
      ? value.outcome
      : "error";
  const dates = Array.isArray(value.dates)
    ? value.dates.filter((date): date is string => typeof date === "string")
    : [];
  return {
    ok: outcome !== "error",
    outcome,
    currentAppointment:
      typeof value.currentAppointment === "string"
        ? value.currentAppointment
        : null,
    dates,
    error:
      outcome === "error"
        ? typeof value.error === "string" && value.error
          ? value.error
          : "Unknown error"
        : null,
    notified: !!value.notified,
    rescheduled: !!value.rescheduled,
  };
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addIsoDays(iso: string, days: number): string {
  return toIsoDate(addDays(parseDateAsUtc(iso), days));
}

export type SearchWindow =
  | { kind: "window"; start: string | null; endExclusive: string }
  | { kind: "unknown" };

export function profileSearchWindow(profile: {
  minDate: string | null;
  maxDate: string | null;
  currentAppointmentDate: string | null;
}): SearchWindow {
  if (profile.maxDate) {
    return {
      kind: "window",
      start: profile.minDate,
      endExclusive: addIsoDays(profile.maxDate, 1),
    };
  }
  if (!profile.currentAppointmentDate) {
    return { kind: "unknown" };
  }
  return {
    kind: "window",
    start: profile.minDate,
    endExclusive: profile.currentAppointmentDate,
  };
}

export function windowsOverlap(
  left: Extract<SearchWindow, { kind: "window" }>,
  right: Extract<SearchWindow, { kind: "window" }>,
): boolean {
  const startLeft = left.start ?? "0000-01-01";
  const startRight = right.start ?? "0000-01-01";
  return startLeft < right.endExclusive && startRight < left.endExclusive;
}
