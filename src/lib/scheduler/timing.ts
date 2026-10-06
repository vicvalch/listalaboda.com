/**
 * Automatic RSVP reminder timing (LB-17, ADR-010 §6, §16). Pure functions and
 * constants only; no wall clock is read here.
 *
 * The database computes the authoritative due time
 * (`private.automatic_rsvp_reminder_due_at`); this mirror only labels
 * "programado para …" and builds the enable preview, like
 * `@/lib/guests/link` mirrors link expiry.
 *
 * - One reminder, `days_before` days before the wedding at 10:00 in the
 *   wedding's own IANA time zone (never the server's, the browser's or UTC).
 * - Sendable while `due ≤ now < due + 48 h`.
 * - No date or no time zone → nothing is due.
 */

export const AUTOMATIC_REMINDER_DAYS_BEFORE = [14, 21, 30] as const;
export type AutomaticReminderDaysBefore = (typeof AUTOMATIC_REMINDER_DAYS_BEFORE)[number];
export const DEFAULT_AUTOMATIC_REMINDER_DAYS_BEFORE: AutomaticReminderDaysBefore = 21;

/** Wedding-local send time. */
export const AUTOMATIC_REMINDER_LOCAL_HOUR = 10;
export const AUTOMATIC_REMINDER_WINDOW_HOURS = 48;
/** No automatic reminder within this many days of a recorded reminder or invitation email. */
export const AUTOMATIC_REMINDER_SUPPRESSION_DAYS = 7;

/** Runner and claim limits (ADR-010 §16). */
export const SCHEDULER_MAX_CLAIMS_PER_RUN = 50;
export const SCHEDULER_MAX_CLAIMS_PER_WEDDING = 25;
export const SCHEDULER_RUN_BUDGET_MS = 45_000;
/** The automatic runner's per-call provider deadline (ADR-010 §4). Manual email flows have none. */
export const SCHEDULER_PROVIDER_TIMEOUT_MS = 10_000;
export const SCHEDULER_MIN_SEND_SPACING_MS = 500;
export const SCHEDULER_MAX_ATTEMPTS = 3;
export const SCHEDULER_REPLAY_WINDOW_HOURS = 23;

const HOUR_MS = 60 * 60 * 1000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isAutomaticReminderDaysBefore(value: unknown): value is AutomaticReminderDaysBefore {
  return typeof value === "number" && (AUTOMATIC_REMINDER_DAYS_BEFORE as readonly number[]).includes(value);
}

/** Milliseconds `timeZone` is ahead of UTC at `instant` (DST included), or null for an unknown zone. */
function zoneOffsetMs(timeZone: string, instant: number): number | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(instant));
  } catch {
    return null;
  }
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  if (Number.isNaN(local)) return null;
  return local - Math.floor(instant / 1000) * 1000;
}

/**
 * The due instant: (wedding date − days_before) at 10:00 wedding-local time.
 * Null without a date, without a zone, or for an unknown zone.
 */
export function automaticReminderDueAt(
  weddingDate: string | null,
  timeZone: string | null,
  daysBefore: number,
): Date | null {
  const match = weddingDate ? ISO_DATE.exec(weddingDate) : null;
  if (!match || !timeZone) return null;
  const [, year, month, day] = match;
  // The wall-clock time we want, read as if it were UTC.
  const wall = Date.UTC(Number(year), Number(month) - 1, Number(day) - daysBefore, AUTOMATIC_REMINDER_LOCAL_HOUR);
  const firstOffset = zoneOffsetMs(timeZone, wall);
  if (firstOffset === null) return null;
  let instant = wall - firstOffset;
  // Re-read the offset at the candidate instant (daylight-saving edges).
  const secondOffset = zoneOffsetMs(timeZone, instant);
  if (secondOffset === null) return null;
  if (secondOffset !== firstOffset) instant = wall - secondOffset;
  return new Date(instant);
}

export type AutomaticReminderWindow = "before" | "open" | "closed";

/** Where `now` sits relative to the 48 h sending window that starts at `dueAt`. */
export function automaticReminderWindow(dueAt: Date, now: Date): AutomaticReminderWindow {
  if (now.getTime() < dueAt.getTime()) return "before";
  if (now.getTime() < dueAt.getTime() + AUTOMATIC_REMINDER_WINDOW_HOURS * HOUR_MS) return "open";
  return "closed";
}

/**
 * The provider idempotency key of one occurrence: always the same for every
 * attempt of that occurrence (ADR-010 §12). Never an attempt number,
 * timestamp, recipient, token or random value.
 */
export function automaticReminderIdempotencyKey(occurrenceId: string): string {
  return `lb-auto-rsvp-reminder:${occurrenceId}`;
}
