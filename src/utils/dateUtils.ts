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

