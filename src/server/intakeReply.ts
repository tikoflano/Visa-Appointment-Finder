import { parseWhatsAppDestinations } from "./whatsapp";

/** Required keys, in order. `to` may be omitted entirely. */
const KEYS_BEFORE_TO = [
  "login_email",
  "login_password",
  "process_id",
  "from",
] as const;
const KEYS_AFTER_TO = ["notification_emails", "notification_phones"] as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface IntakeReplyFields {
  visaEmail: string;
  visaPassword: string;
  visaProcessId: string;
  minDate: string;
  maxDate: string;
  emailDestination: string;
  /** Only the numbers written in notification_phones. */
  whatsappDestination: string;
}

export type IntakeReplyResult =
  | { kind: "ignore" }
  | { kind: "invalid"; problems: string[] }
  | { kind: "ok"; fields: IntakeReplyFields };

export function intakePromptText(): string {
  return [
    "Reply with this block only, with the blanks filled in. Any other message is ignored.",
    "If a value is missing or invalid, you will get a reply that says what to fix.",
    "",
    "VISA-PROFILE",
    "login_email: ",
    "login_password: ",
    "process_id: ",
    "from: ",
    "to: ",
    "notification_emails: ",
    "notification_phones: ",
    "",
    "How to fill each field:",
    "> *login_email*: email used to login to AIS",
    "> *login_password*: password to login to AIS",
    "> *process_id*: Log in to AIS, click the green Continue button for your current process, then copy the number from the address bar. Example: https://ais.usvisa-info.com/en-cl/niv/schedule/71289258/continue_actions — the process id is 71289258",
    "> *from*: earliest date to search, inclusive, YYYY-MM-DD or YYYY/MM/DD",
    "> *to*: latest date to search, inclusive, YYYY-MM-DD or YYYY/MM/DD. Leave empty, or omit this line, to use the current appointment date",
    "> *notification_emails*: comma-separated list (CSV) of emails to notify. Example: ada@example.com, bob@example.com. Leave empty for no email notifications. The login email is not included unless you write it here",
    "> *notification_phones*: comma-separated list (CSV) of WhatsApp numbers to notify. Example: 56911111111, 56922222222. Leave empty for no WhatsApp notifications. This chat's number is not included unless you write it here",
  ].join("\n");
}

export function intakeInvalidReply(problems: string[]): string {
  return [
    "Could not save this profile:",
    ...problems.map((problem) => `- ${problem}`),
    "Send the VISA-PROFILE block again.",
  ].join("\n");
}

export function intakeSavedReply(name: string): string {
  return `Profile ${name} has been created. It is waiting for an admin to enable it.`;
}

export function intakeExpiredReply(name: string): string {
  return `Monitoring for ${name} has stopped. No valid reply arrived within 24 hours.`;
}

export function intakeExpiredAdminText(name: string, phone: string): string {
  return `WhatsApp monitoring for ${name} (${phone}) has stopped. No valid reply arrived within 24 hours.`;
}

export function parseIntakeReply(text: string): IntakeReplyResult {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");
  const values = readTemplate(lines);
  if (!values) {
    if (lines.some((line) => line.trim() === "VISA-PROFILE")) {
      return {
        kind: "invalid",
        problems: [
          "Use the exact field names from the prompt: login_email, login_password, process_id, from, to, notification_emails, notification_phones",
        ],
      };
    }
    return { kind: "ignore" };
  }

  const problems: string[] = [];
  const visaEmail = values.login_email.trim();
  const visaPassword = values.login_password;
  const visaProcessId = values.process_id.trim();
  const rawMinDate = values.from.trim();
  const rawMaxDate = values.to.trim();
  const minDate = normalizeDate(rawMinDate);
  const maxDate = normalizeDate(rawMaxDate);

  // Our own prompt (or an unfilled copy) is not a reply.
  if (
    !visaEmail &&
    !visaPassword &&
    !visaProcessId &&
    !rawMinDate &&
    !rawMaxDate &&
    !values.notification_emails.trim() &&
    !values.notification_phones.trim()
  ) {
    return { kind: "ignore" };
  }

  if (!visaEmail) problems.push("Visa account email is required");
  else if (!EMAIL.test(visaEmail)) problems.push("Visa account email is invalid");
  if (!visaPassword) problems.push("Visa account password is required");
  if (!/^\d+$/.test(visaProcessId)) {
    problems.push("Visa process ID must be numeric");
  }
  if (!minDate) {
    problems.push("Earliest date must be YYYY-MM-DD or YYYY/MM/DD");
  }
  if (rawMaxDate && !maxDate) {
    problems.push(
      "Latest date must be YYYY-MM-DD or YYYY/MM/DD, or empty to use the current appointment",
    );
  }
  if (minDate && maxDate && minDate > maxDate) {
    problems.push("Earliest date must be on or before latest date");
  }

  let emailDestination = "";
  const emails = values.notification_emails
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (emails.length) {
    const bad = emails.filter((email) => !EMAIL.test(email));
    if (bad.length) {
      problems.push(`Invalid email in notification_emails: ${bad.join(", ")}`);
    } else {
      emailDestination = emails.join(",");
    }
  }

  let whatsappDestination = "";
  if (values.notification_phones) {
    try {
      whatsappDestination = parseWhatsAppDestinations(values.notification_phones);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`notification_phones: ${message}`);
    }
  }

  if (problems.length) return { kind: "invalid", problems };
  return {
    kind: "ok",
    fields: {
      visaEmail,
      visaPassword,
      visaProcessId,
      minDate,
      maxDate,
      emailDestination,
      whatsappDestination,
    },
  };
}

/**
 * Find the VISA-PROFILE block even when the user pasted the whole prompt
 * (intro text above and field help below).
 */
function readTemplate(lines: string[]): Record<string, string> | null {
  const start = lines.findIndex((line) => line.trim() === "VISA-PROFILE");
  if (start < 0) return null;
  let index = start + 1;
  const values: Record<string, string> = {};

  for (const key of KEYS_BEFORE_TO) {
    const parsed = readKeyLine(lines[index], key);
    if (parsed == null) return null;
    values[key] = parsed;
    index++;
  }

  const toLine = readKeyLine(lines[index], "to");
  if (toLine != null) {
    values.to = toLine;
    index++;
  } else {
    values.to = "";
  }

  for (const key of KEYS_AFTER_TO) {
    const parsed = readKeyLine(lines[index], key);
    if (parsed == null) return null;
    values[key] = parsed;
    index++;
  }

  return values;
}

function readKeyLine(line: string | undefined, key: string): string | null {
  if (line == null) return null;
  const prefix = `${key}:`;
  if (!line.startsWith(prefix)) return null;
  const raw = line.slice(prefix.length);
  const value = raw.startsWith(" ") ? raw.slice(1) : raw;
  return key === "login_password" ? value : value.trim();
}

/** Accept YYYY-MM-DD or YYYY/MM/DD; store as YYYY-MM-DD. Empty stays empty. */
function normalizeDate(value: string): string {
  if (!value) return "";
  const normalized = value.includes("/") ? value.replace(/\//g, "-") : value;
  if (!ISO_DATE.test(normalized)) return "";
  const [year, month, day] = normalized.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return "";
  }
  return normalized;
}
