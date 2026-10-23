export const INTAKE_WINDOW_MS = 24 * 60 * 60 * 1000;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * Next time this intake should be checked. `afterMs` is the last check, or
 * the window start when nothing has been checked yet.
 *
 * Slots: every minute through 10 minutes, every 5 minutes through 70 minutes,
 * then every hour until the 24-hour mark, which is itself a final check.
 */
export function nextIntakePollAt(
  windowStartedMs: number,
  afterMs: number,
): number | null {
  const end = windowStartedMs + INTAKE_WINDOW_MS;
  for (const slot of intakePollSlots(windowStartedMs, end)) {
    if (slot > afterMs) return slot;
  }
  return null;
}

function intakePollSlots(windowStartedMs: number, end: number): number[] {
  const slots: number[] = [];
  for (
    let t = windowStartedMs + MINUTE;
    t <= windowStartedMs + 10 * MINUTE;
    t += MINUTE
  ) {
    slots.push(t);
  }
  for (
    let t = windowStartedMs + 15 * MINUTE;
    t <= windowStartedMs + 70 * MINUTE;
    t += 5 * MINUTE
  ) {
    slots.push(t);
  }
  for (let t = windowStartedMs + 70 * MINUTE + HOUR; t < end; t += HOUR) {
    slots.push(t);
  }
  slots.push(end);
  return slots;
}
