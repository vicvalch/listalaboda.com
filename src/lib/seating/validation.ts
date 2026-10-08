import { es } from "@/lib/i18n/messages/es";

/**
 * UX validation for the seating forms (LB-19) and the visual planner's
 * layout writes (LB-20, ADR-013). The database stays authoritative (name,
 * capacity, shape enum and coordinate CHECKs); this mirrors only what gives
 * the organizer a useful Spanish message before a round-trip, and the
 * service runs it again before any write. Names are kept as typed: trimmed,
 * never re-cased.
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

/** The planner's closed set of table shapes (the `seating_table_shape` enum). Visual only. */
export const TABLE_SHAPES = ["round", "rectangle"] as const;
export type TableShape = (typeof TABLE_SHAPES)[number];
export const DEFAULT_TABLE_SHAPE: TableShape = "round";

export function isTableShape(value: unknown): value is TableShape {
  return typeof value === "string" && (TABLE_SHAPES as readonly string[]).includes(value);
}

export type TableShapeResult =
  | Readonly<{ ok: true; value: TableShape }>
  | Readonly<{ ok: false; error: string }>;

/** "round" or "rectangle"; a blank value is the default (round). Anything else is refused. */
export function parseTableShape(raw: string): TableShapeResult {
  const value = raw.trim();
  if (!value) return { ok: true, value: DEFAULT_TABLE_SHAPE };
  if (isTableShape(value)) return { ok: true, value };
  return { ok: false, error: es.seating.validation.shapeInvalid };
}

export type TableField = "name" | "capacity" | "shape";

export type TableInput = Readonly<{ name: string; capacity: number; shape: TableShape }>;

export type TableInputResult =
  | Readonly<{ ok: true; input: TableInput }>
  | Readonly<{ ok: false; fieldErrors: Partial<Record<TableField, string>> }>;

export function parseTableInput(
  raw: Readonly<{ name: string; capacity: string; shape: string }>,
): TableInputResult {
  const name = parseTableName(raw.name);
  const capacity = parseTableCapacity(raw.capacity);
  const shape = parseTableShape(raw.shape);
  if (!name.ok || !capacity.ok || !shape.ok) {
    return {
      ok: false,
      fieldErrors: {
        ...(name.ok ? {} : { name: name.error }),
        ...(capacity.ok ? {} : { capacity: capacity.error }),
        ...(shape.ok ? {} : { shape: shape.error }),
      },
    };
  }
  return { ok: true, input: { name: name.value, capacity: capacity.value, shape: shape.value } };
}

// ------------------------------------------------------------ table layout

/**
 * The database's loose coordinate range (ADR-013). The planner's 1200-unit
 * board width and 20-unit grid are presentation (`@/lib/seating/planner`),
 * not domain rules, and are deliberately not enforced here.
 */
export const LAYOUT_COORDINATE_MIN = 0;
export const LAYOUT_COORDINATE_MAX = 10_000;

/** A table's center on the planner board, in logical integer units. */
export type TablePosition = Readonly<{ x: number; y: number }>;

export function isLayoutCoordinate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= LAYOUT_COORDINATE_MIN &&
    value <= LAYOUT_COORDINATE_MAX
  );
}

/** Both coordinates must be whole numbers in 0–10000. */
export function isTablePosition(value: Readonly<{ x: unknown; y: unknown }>): value is TablePosition {
  return isLayoutCoordinate(value.x) && isLayoutCoordinate(value.y);
}

/** Form text → coordinate: digits only (no signs, decimals, exponents or hex), then the range. */
export function parseLayoutCoordinate(raw: string): number | null {
  const value = raw.trim();
  if (!/^\d{1,5}$/.test(value)) return null;
  const n = Number(value);
  return isLayoutCoordinate(n) ? n : null;
}
