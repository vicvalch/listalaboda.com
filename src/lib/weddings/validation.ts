import { es } from "@/lib/i18n/messages/es";

/**
 * UX validation for the wedding form. The database stays authoritative
 * (non-blank name, 200-char cap, `date` type); this mirrors only what gives
 * the user a useful Spanish message before a round-trip.
 */

export type WeddingField = "name" | "weddingDate";

export type WeddingInput = Readonly<{ name: string; weddingDate: string | null }>;

export type WeddingInputResult =
  | Readonly<{ ok: true; input: WeddingInput }>
  | Readonly<{ ok: false; fieldErrors: Partial<Record<WeddingField, string>> }>;

export const WEDDING_NAME_MAX_LENGTH = 200;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

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

export function parseWeddingInput(raw: { name: string; weddingDate: string }): WeddingInputResult {
  const messages = es.weddingNew.validation;
  const fieldErrors: Partial<Record<WeddingField, string>> = {};

  const name = raw.name.trim();
  if (!name) fieldErrors.name = messages.nameRequired;
  else if (name.length > WEDDING_NAME_MAX_LENGTH) fieldErrors.name = messages.nameTooLong;

  const date = raw.weddingDate.trim();
  if (date && !isIsoCalendarDate(date)) fieldErrors.weddingDate = messages.dateInvalid;

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return { ok: true, input: { name, weddingDate: date || null } };
}
