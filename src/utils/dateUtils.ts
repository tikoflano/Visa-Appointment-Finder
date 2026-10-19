export function formatDate(date: Date): string {
  const dateOptions: Intl.DateTimeFormatOptions = {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
    weekday: "long",
  };

  return date.toLocaleDateString("en-US", dateOptions);
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

// The appointments API returns YYYY-MM-DD dates, which JS parses as UTC
// midnight. All other dates must be normalized the same way to be comparable.
export function parseDateAsUtc(value: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return new Date(value.trim());
  }

  const local = new Date(value);
  return new Date(
    Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()),
  );
}

