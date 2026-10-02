import { formText } from "@/lib/forms/result";
import { es } from "@/lib/i18n/messages/es";
import { isSupportedTimeZone } from "@/lib/weddings/timezone";

/**
 * UX validation for the wedding form. The database stays authoritative
 * (non-blank name, 200-char cap, `date` type, city CHECK, time-zone
 * trigger); this mirrors only what gives the user a useful Spanish message
 * before a round-trip.
 */

export type WeddingField = "name" | "weddingDate" | "city" | "timeZone";

export type WeddingInput = Readonly<{
  name: string;
  weddingDate: string | null;
  /** Trimmed; null when blank. */
  city: string | null;
  /** IANA identifier; null when not set (no overdue classification). */
  timeZone: string | null;
}>;

export type WeddingInputResult =
  | Readonly<{ ok: true; input: WeddingInput }>
  | Readonly<{ ok: false; fieldErrors: Partial<Record<WeddingField, string>> }>;

export const WEDDING_NAME_MAX_LENGTH = 200;
export const WEDDING_CITY_MAX_LENGTH = 120;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Control characters (C0, DEL, C1): plain text only.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/** A real calendar date in `YYYY-MM-DD` form (what `<input type="date">` sends). */
export function isIsoCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < 1900 || year > 2999) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function parseWeddingInput(raw: {
  name: string;
  weddingDate: string;
  city: string;
  timeZone: string;
}): WeddingInputResult {
  const messages = es.weddingNew.validation;
  const fieldErrors: Partial<Record<WeddingField, string>> = {};

  const name = raw.name.trim();
  if (!name) fieldErrors.name = messages.nameRequired;
  else if (name.length > WEDDING_NAME_MAX_LENGTH) fieldErrors.name = messages.nameTooLong;

  const date = raw.weddingDate.trim();
  if (date && !isIsoCalendarDate(date)) fieldErrors.weddingDate = messages.dateInvalid;

  const city = parseCity(raw.city);
  if (!city.ok) fieldErrors.city = city.error;

  // Never aliased or re-cased: the identifier is stored exactly as chosen.
  const timeZone = raw.timeZone.trim();
  if (timeZone && !isSupportedTimeZone(timeZone)) fieldErrors.timeZone = messages.timeZoneInvalid;

  if (!city.ok || Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return {
    ok: true,
    input: { name, weddingDate: date || null, city: city.city, timeZone: timeZone || null },
  };
}

/** The wedding form's raw fields (echoed back on failure; nothing sensitive). */
export function weddingFormValues(formData: FormData): Record<WeddingField, string> {
  return {
    name: formText(formData, "name"),
    weddingDate: formText(formData, "weddingDate"),
    city: formText(formData, "city"),
    timeZone: formText(formData, "timeZone"),
  };
}

/** Catalog message for a field the database rejected; null for other failures. */
export function weddingFieldErrorMessage(
  reason: string,
): Partial<Record<WeddingField, string>> | null {
  const messages = es.weddingNew.validation;
  switch (reason) {
    case "invalid_name":
      return { name: messages.nameRequired };
    case "invalid_date":
      return { weddingDate: messages.dateInvalid };
    case "invalid_city":
      return { city: messages.cityInvalid };
    case "invalid_time_zone":
      return { timeZone: messages.timeZoneInvalid };
    default:
      return null;
  }
}

export type CityResult =
  | Readonly<{ ok: true; city: string | null }>
  | Readonly<{ ok: false; error: string }>;

/**
 * The optional wedding city: plain text, kept as typed (no lowercasing, no
 * geocoding). Trimmed; blank means "no city" (null). Mirrors the database
 * CHECK (1–120 characters, no control characters), which stays authoritative.
 */
export function parseCity(raw: string): CityResult {
  const messages = es.weddingNew.validation;
  const value = raw.trim();
  if (!value) return { ok: true, city: null };
  if ([...value].length > WEDDING_CITY_MAX_LENGTH) return { ok: false, error: messages.cityTooLong };
  if (CONTROL_CHARACTERS.test(value)) return { ok: false, error: messages.cityInvalid };
  return { ok: true, city: value };
}

// ------------------------------------------------------------ display name

export const DISPLAY_NAME_MAX_LENGTH = 80;

export type DisplayNameResult =
  | Readonly<{ ok: true; displayName: string | null }>
  | Readonly<{ ok: false; error: string }>;

/**
 * A member's wedding-scoped display name. Trimmed; blank means "no name"
 * (null). Mirrors the database CHECK (1–80 characters, no control
 * characters), which stays authoritative.
 */
export function parseDisplayName(raw: string): DisplayNameResult {
  const messages = es.members.displayName;
  const value = raw.trim();
  if (!value) return { ok: true, displayName: null };
  if ([...value].length > DISPLAY_NAME_MAX_LENGTH) return { ok: false, error: messages.tooLong };
  if (CONTROL_CHARACTERS.test(value)) return { ok: false, error: messages.invalid };
  return { ok: true, displayName: value };
}
