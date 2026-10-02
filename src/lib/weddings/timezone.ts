/**
 * Wedding time zones. Pure functions only; no wall clock is read here.
 *
 * A wedding's time zone is an IANA identifier ("America/Costa_Rica"), never
 * an offset ("-06:00"): offsets change with daylight saving time and don't
 * name a place. It exists for one purpose: to know which calendar day it is
 * where the wedding happens, so "atrasado" can be derived. It is never
 * inferred (not from the browser, the server, the IP or UTC); a wedding
 * without one simply has no overdue classification.
 *
 * The database validates every stored zone against Postgres's tz catalog and
 * stays authoritative; this module gives the form its options and a useful
 * message before a round-trip.
 */

const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
export const TIME_ZONE_MAX_LENGTH = 64;

let selectable: readonly string[] | null = null;

/**
 * The zones offered in the wedding form: the runtime's (ICU) canonical IANA
 * location zones, alphabetical. Computed once per process.
 */
export function selectableTimeZones(): readonly string[] {
  selectable ??= Object.freeze([...Intl.supportedValuesOf("timeZone")].sort());
  return selectable;
}

/**
 * A zone identifier the app accepts: one of the selectable zones, or any
 * other identifier the runtime knows under exactly that spelling (e.g.
 * "UTC"). Offsets, abbreviations, wrong casing and unknown names are
 * rejected; Intl is lenient about casing and aliases, so its own canonical
 * name must match what would be stored.
 */
export function isSupportedTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > TIME_ZONE_MAX_LENGTH) return false;
  if (!IANA_NAME.test(value)) return false;
  if (selectableTimeZones().includes(value)) return true;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone === value;
  } catch {
    return false;
  }
}

/**
 * The calendar date (`YYYY-MM-DD`) at instant `now` in `timeZone`: "today"
 * where the wedding is. Uses the IANA rules (daylight saving included) via
 * Intl; never the process time zone, never UTC slicing. Null for an unknown
 * zone, so a bad value fails closed (no overdue classification).
 */
export function weddingLocalToday(timeZone: string, now: Date): string | null {
  if (Number.isNaN(now.getTime())) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
  } catch {
    return null;
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (!year || !month || !day || !/^\d{4}$/.test(year)) return null;
  return `${year}-${month}-${day}`;
}

/** How a zone appears in the picker: "America/Costa Rica". The value stays the identifier. */
export function timeZoneLabel(timeZone: string): string {
  return timeZone.replaceAll("_", " ");
}
