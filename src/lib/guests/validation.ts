import { es } from "@/lib/i18n/messages/es";

/**
 * UX validation for the guest list forms. The database stays authoritative
 * (label/name CHECKs, at least one guest per party); this mirrors only what gives
 * the organizer a useful Spanish message before a round-trip. Names and
 * labels are kept as typed: trimmed, never re-cased.
 */

export const PARTY_LABEL_MAX_LENGTH = 120;
export const GUEST_NAME_MAX_LENGTH = 120;

// Control characters (C0, DEL, C1): plain text only.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export type TextResult =
  | Readonly<{ ok: true; value: string }>
  | Readonly<{ ok: false; error: string }>;

function parseRequiredText(
  raw: string,
  maxLength: number,
  messages: Readonly<{ required: string; tooLong: string; invalid: string }>,
): TextResult {
  const value = raw.trim();
  if (!value) return { ok: false, error: messages.required };
  if ([...value].length > maxLength) return { ok: false, error: messages.tooLong };
  if (CONTROL_CHARACTERS.test(value)) return { ok: false, error: messages.invalid };
  return { ok: true, value };
}

/** "Familia Pérez", "Ana y Carlos": required, ≤ 120 characters, plain text. */
export function parsePartyLabel(raw: string): TextResult {
  const v = es.guests.validation;
  return parseRequiredText(raw, PARTY_LABEL_MAX_LENGTH, {
    required: v.labelRequired,
    tooLong: v.labelTooLong,
    invalid: v.labelInvalid,
  });
}

/** One guest's name: required, ≤ 120 characters, plain text. */
export function parseGuestName(raw: string): TextResult {
  const v = es.guests.validation;
  return parseRequiredText(raw, GUEST_NAME_MAX_LENGTH, {
    required: v.nameRequired,
    tooLong: v.nameTooLong,
    invalid: v.nameInvalid,
  });
}

export type GuestNamesResult =
  | Readonly<{ ok: true; names: readonly string[] }>
  | Readonly<{ ok: false; error: string }>;

/**
 * The first guests of a new party, one name per line (a textarea). Blank
 * lines are ignored; at least one name, no fixed maximum (an invited
 * capacity is not modeled yet). Line breaks are the separator, so they
 * never reach a stored name.
 */
export function parseGuestNames(raw: string): GuestNamesResult {
  const v = es.guests.validation;
  const lines = raw
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return { ok: false, error: v.namesRequired };
  for (const line of lines) {
    const parsed = parseGuestName(line);
    if (!parsed.ok) return { ok: false, error: parsed.error };
  }
  return { ok: true, names: lines };
}

export type NewPartyField = "label" | "guestNames";

export type NewPartyInput = Readonly<{ label: string; guestNames: readonly string[] }>;

export type NewPartyResult =
  | Readonly<{ ok: true; input: NewPartyInput }>
  | Readonly<{ ok: false; fieldErrors: Partial<Record<NewPartyField, string>> }>;

export function parseNewParty(raw: { label: string; guestNames: string }): NewPartyResult {
  const label = parsePartyLabel(raw.label);
  const names = parseGuestNames(raw.guestNames);
  if (!label.ok || !names.ok) {
    return {
      ok: false,
      fieldErrors: {
        ...(label.ok ? {} : { label: label.error }),
        ...(names.ok ? {} : { guestNames: names.error }),
      },
    };
  }
  return { ok: true, input: { label: label.value, guestNames: names.names } };
}
