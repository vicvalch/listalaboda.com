import { es } from "@/lib/i18n/messages/es";

/**
 * UX validation for the seating forms (LB-19). The database stays
 * authoritative (name and capacity CHECKs); this mirrors only what gives the
 * organizer a useful Spanish message before a round-trip, and the service
 * runs it again before any write. Names are kept as typed: trimmed, never
 * re-cased.
 */

export const TABLE_NAME_MAX_LENGTH = 80;
export const TABLE_CAPACITY_MIN = 1;
export const TABLE_CAPACITY_MAX = 50;

// Control characters (C0, DEL, C1): plain text only.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export type TableNameResult =
  | Readonly<{ ok: true; value: string }>
  | Readonly<{ ok: false; error: string }>;

export type TableCapacityResult =
  | Readonly<{ ok: true; value: number }>
  | Readonly<{ ok: false; error: string }>;

/** "Mesa 1", "Mesa de los novios": required, ≤ 80 characters, plain text. Not unique. */
export function parseTableName(raw: string): TableNameResult {
  const v = es.seating.validation;
  const value = raw.trim();
  if (!value) return { ok: false, error: v.nameRequired };
  if ([...value].length > TABLE_NAME_MAX_LENGTH) return { ok: false, error: v.nameTooLong };
  if (CONTROL_CHARACTERS.test(value)) return { ok: false, error: v.nameInvalid };
  return { ok: true, value };
}

/** A whole number of people, 1–50. Digits only: no signs, decimals or exponents. */
export function parseTableCapacity(raw: string): TableCapacityResult {
  const v = es.seating.validation;
  const value = raw.trim();
  if (!value) return { ok: false, error: v.capacityRequired };
  if (!/^\d{1,3}$/.test(value)) return { ok: false, error: v.capacityRange };
  const capacity = Number(value);
  if (capacity < TABLE_CAPACITY_MIN || capacity > TABLE_CAPACITY_MAX) {
    return { ok: false, error: v.capacityRange };
  }
  return { ok: true, value: capacity };
}

export type TableField = "name" | "capacity";

export type TableInput = Readonly<{ name: string; capacity: number }>;

export type TableInputResult =
  | Readonly<{ ok: true; input: TableInput }>
  | Readonly<{ ok: false; fieldErrors: Partial<Record<TableField, string>> }>;

export function parseTableInput(raw: Readonly<{ name: string; capacity: string }>): TableInputResult {
  const name = parseTableName(raw.name);
  const capacity = parseTableCapacity(raw.capacity);
  if (!name.ok || !capacity.ok) {
    return {
      ok: false,
      fieldErrors: {
        ...(name.ok ? {} : { name: name.error }),
        ...(capacity.ok ? {} : { capacity: capacity.error }),
      },
    };
  }
  return { ok: true, input: { name: name.value, capacity: capacity.value } };
}
