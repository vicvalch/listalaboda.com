/**
 * The visual seating planner's geometry and optimistic state (LB-20,
 * ADR-013). Pure and deterministic: no DOM, no React, no I/O, no clock.
 *
 * Coordinate model:
 *   * The board is a fixed LOGICAL width (1200 units) that grows vertically.
 *     It is rendered scaled to the available width:
 *       scale = renderedBoardWidth / 1200.
 *   * A table's position is its CENTER, in logical integer units. A null
 *     layout means "not placed yet": a deterministic slot is derived here,
 *     and nothing is written until the table is first dragged.
 *   * A drag's screen-pixel delta becomes a logical delta by DIVIDING by the
 *     scale, then the position snaps to the 20-unit grid and is clamped so
 *     the table (with its chairs) stays on the board.
 *   * Sizes are derived from shape + capacity and never stored. Chairs are
 *     decorative markers generated from capacity: they never stand for a
 *     particular guest, and seating stays table-level (ADR-012).
 *   * Overlap is allowed for manual placement; only the derived slots avoid
 *     existing tables.
 *
 * The database stays authoritative for everything that matters: capacity,
 * declined guests and races are decided there. `guestDropOutcome` only spares
 * the organizer a round-trip that is known to fail.
 */

import type {
  SeatingPartyInput,
  SeatingRsvpState,
  SeatingTableInput,
} from "@/lib/seating/plan";
import { LAYOUT_COORDINATE_MAX, type TablePosition, type TableShape } from "@/lib/seating/validation";

export const BOARD_WIDTH = 1200;
export const GRID_SIZE = 20;
export const MIN_BOARD_HEIGHT = 800;
export const BOARD_BOTTOM_MARGIN = 160;

/** Derived placement: ~6 slots per row, 200 units apart, first slot centered at (100, 100). */
export const SLOT_SPACING = 200;
export const SLOTS_PER_ROW = BOARD_WIDTH / SLOT_SPACING;
const SLOT_ORIGIN = SLOT_SPACING / 2;

/** Distance from the table's edge to the chair centers, and the largest chair radius. */
export const CHAIR_GAP = 16;
export const CHAIR_RADIUS_MAX = 8;
const FOOTPRINT_MARGIN = CHAIR_GAP + CHAIR_RADIUS_MAX;

const CAPACITY_MIN = 1;
const CAPACITY_MAX = 50;

export type Size = Readonly<{ width: number; height: number }>;
export type Point = Readonly<{ x: number; y: number }>;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function boundedCapacity(capacity: number): number {
  return Number.isFinite(capacity) ? clamp(Math.round(capacity), CAPACITY_MIN, CAPACITY_MAX) : CAPACITY_MIN;
}

// ------------------------------------------------------------------- scale

/** How many screen pixels one logical unit takes on a board rendered `renderedWidth` px wide. */
export function boardScale(renderedWidth: number): number {
  return renderedWidth / BOARD_WIDTH;
}

/** Logical units → screen pixels. */
export function logicalToScreen(value: number, scale: number): number {
  return value * scale;
}

/**
 * A pointer/keyboard delta in screen pixels → logical units: divided by the
 * scale (at scale 0.5, 200 px is 400 units). A non-positive or non-finite
 * scale (an unmeasured board) moves nothing.
 */
export function screenDeltaToLogical(delta: Point, scale: number): Point {
  if (!Number.isFinite(scale) || scale <= 0) return { x: 0, y: 0 };
  return { x: delta.x / scale, y: delta.y / scale };
}

// ------------------------------------------------------------------- sizes

/**
 * The table's drawn size in logical units, from shape + capacity. Bounded so
 * capacity 50 doesn't make an enormous table:
 *   * round: diameter 90 + 4·capacity, within 100–150;
 *   * rectangle: width 40 + 20·ceil(capacity / 2) (chairs on two sides),
 *     within 100–320; height fixed at 70 (always horizontal).
 */
export function tableShapeSize(shape: TableShape, capacity: number): Size {
  const c = boundedCapacity(capacity);
  if (shape === "rectangle") {
    return { width: clamp(40 + 20 * Math.ceil(c / 2), 100, 320), height: 70 };
  }
  const diameter = clamp(90 + 4 * c, 100, 150);
  return { width: diameter, height: diameter };
}

/** The table plus its ring of chairs: what must stay on the board and what derived slots avoid. */
export function tableFootprint(shape: TableShape, capacity: number): Size {
  const size = tableShapeSize(shape, capacity);
  return { width: size.width + 2 * FOOTPRINT_MARGIN, height: size.height + 2 * FOOTPRINT_MARGIN };
}

// -------------------------------------------------------------- grid/clamp

/** Nearest multiple of the 20-unit grid. */
export function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE + 0;
}

function ceilToGrid(value: number): number {
  return Math.ceil(value / GRID_SIZE) * GRID_SIZE;
}

function floorToGrid(value: number): number {
  return Math.floor(value / GRID_SIZE) * GRID_SIZE;
}

/**
 * Keeps a table center on the board: the whole footprint inside the 1200-unit
 * width, never above the top, and within the database's coordinate range.
 * The bounds are grid-aligned, so a snapped value stays on the grid.
 */
export function clampPosition(position: Point, footprint: Size): TablePosition {
  const halfW = footprint.width / 2;
  const halfH = footprint.height / 2;
  const minX = ceilToGrid(halfW);
  const maxX = Math.max(minX, floorToGrid(BOARD_WIDTH - halfW));
  const minY = ceilToGrid(halfH);
  const maxY = Math.max(minY, floorToGrid(LAYOUT_COORDINATE_MAX - halfH));
  return {
    x: Math.round(clamp(position.x, minX, maxX)),
    y: Math.round(clamp(position.y, minY, maxY)),
  };
}

/**
 * Where a dragged table lands: start + (screen delta ÷ scale), snapped to
 * the grid, then clamped to the board. Computed once, when the drag ends.
 */
export function droppedTablePosition(
  start: TablePosition,
  screenDelta: Point,
  scale: number,
  footprint: Size,
): TablePosition {
  const delta = screenDeltaToLogical(screenDelta, scale);
  return clampPosition({ x: snapToGrid(start.x + delta.x), y: snapToGrid(start.y + delta.y) }, footprint);
}

// --------------------------------------------------------- derived layout

export type LayoutTable = Readonly<{
  id: string;
  shape: TableShape;
  capacity: number;
  layout: TablePosition | null;
}>;

export type PlacedTable = Readonly<{
  id: string;
  /** Where the table is drawn (its center). */
  position: TablePosition;
  footprint: Size;
  /** True when the table has no stored position yet (a derived slot). */
  derived: boolean;
}>;

type Box = Readonly<{ left: number; top: number; right: number; bottom: number }>;

function boxOf(position: Point, footprint: Size): Box {
  return {
    left: position.x - footprint.width / 2,
    top: position.y - footprint.height / 2,
    right: position.x + footprint.width / 2,
    bottom: position.y + footprint.height / 2,
  };
}

/** Strict overlap: touching edges don't count. */
function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function slotCenter(index: number): Point {
  return {
    x: SLOT_ORIGIN + SLOT_SPACING * (index % SLOTS_PER_ROW),
    y: SLOT_ORIGIN + SLOT_SPACING * Math.floor(index / SLOTS_PER_ROW),
  };
}

/**
 * Where every table is drawn. Tables with a stored position keep it (clamped
 * onto the board for display only, e.g. after a shape change made it wider;
 * nothing is written). Tables without one take a grid slot, in the given
 * (persisted `sort_order`) order: the k-th table starts looking at slot k
 * (so placing one table never reflows the others) and skips slots whose
 * footprint would overlap an already-placed table — stored or derived — so
 * new tables never pile up on each other or at the origin.
 */
export function deriveTablePositions(tables: readonly LayoutTable[]): PlacedTable[] {
  const obstacles: Box[] = [];
  const placed = new Map<string, PlacedTable>();

  for (const table of tables) {
    if (!table.layout) continue;
    const footprint = tableFootprint(table.shape, table.capacity);
    const position = clampPosition(table.layout, footprint);
    obstacles.push(boxOf(position, footprint));
    placed.set(table.id, { id: table.id, position, footprint, derived: false });
  }

  // A placed footprint (≤ 368 × 198) can block at most a dozen neighbouring
  // slots, so this bound is never reached; it only guards against a loop.
  const maxSlots = (tables.length + 1) * 12 + SLOTS_PER_ROW * 2;
  let slot = 0;
  for (const [ordinal, table] of tables.entries()) {
    if (table.layout) continue;
    slot = Math.max(slot, ordinal);
    const footprint = tableFootprint(table.shape, table.capacity);
    let position = clampPosition(slotCenter(slot), footprint);
    while (slot < maxSlots && obstacles.some((box) => overlaps(box, boxOf(position, footprint)))) {
      slot += 1;
      position = clampPosition(slotCenter(slot), footprint);
    }
    slot += 1;
    obstacles.push(boxOf(position, footprint));
    placed.set(table.id, { id: table.id, position, footprint, derived: true });
  }

  return tables.map((table) => placed.get(table.id)!);
}

/** The board's logical height: at least 800, and below the lowest table plus a margin. Never stored. */
export function boardHeight(tables: readonly PlacedTable[]): number {
  const lowest = tables.reduce((max, t) => Math.max(max, t.position.y + t.footprint.height / 2), 0);
  return Math.max(MIN_BOARD_HEIGHT, ceilToGrid(lowest + BOARD_BOTTOM_MARGIN));
}

// ------------------------------------------------------------------ chairs

export type ChairMarkers = Readonly<{
  /** Exactly `capacity` points, relative to the table's center, in logical units. */
  points: readonly Point[];
  radius: number;
}>;

/**
 * Decorative chair markers: one per seat of capacity, evenly spaced. They are
 * positions only — never ids, never tied to a guest, never stored.
 *   * round: around the circumference, the first at the top
 *     (angle −π/2 + 2πi/N);
 *   * rectangle: ceil(N/2) along the top, floor(N/2) along the bottom.
 */
export function chairMarkers(shape: TableShape, capacity: number): ChairMarkers {
  const n = boundedCapacity(capacity);
  const size = tableShapeSize(shape, n);

  if (shape === "rectangle") {
    const top = Math.ceil(n / 2);
    const bottom = Math.floor(n / 2);
    const y = size.height / 2 + CHAIR_GAP;
    const row = (count: number, rowY: number): Point[] =>
      Array.from({ length: count }, (_, k) => ({ x: -size.width / 2 + (size.width * (k + 0.5)) / count, y: rowY }));
    return {
      points: [...row(top, -y), ...row(bottom, y)],
      radius: Math.min(CHAIR_RADIUS_MAX, (size.width / top) * 0.4),
    };
  }

  const ring = size.width / 2 + CHAIR_GAP;
  return {
    points: Array.from({ length: n }, (_, i) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
      return { x: ring * Math.cos(angle), y: ring * Math.sin(angle) };
    }),
    radius: Math.min(CHAIR_RADIUS_MAX, ((2 * Math.PI * ring) / n) * 0.4),
  };
}

/**
 * How many guest names a table node lists before "+N" (the inspector lists
 * everyone). Nodes are small on a scaled board: a round table shows two, a
 * rectangle (short) one, or two once it is wide enough.
 */
export function visibleGuestCount(shape: TableShape, capacity: number): number {
  if (shape === "round") return 2;
  return tableShapeSize(shape, capacity).width >= 180 ? 2 : 1;
}

// -------------------------------------------------------- drop eligibility

export type DraggedGuest = Readonly<{ rsvpState: SeatingRsvpState; tableId: string | null }>;

export type DropTarget =
  | Readonly<{ kind: "rail" }>
  | Readonly<{ kind: "table"; tableId: string; isFull: boolean }>;

/**
 * What dropping a guest on a target means. Each accepted outcome maps onto
 * exactly one LB-19 action (seat / move / unseat); there is no other write.
 *   * same place → noop (nothing is sent);
 *   * the "Sin mesa" rail → unseat (anyone seated, declined included);
 *   * a table, for a guest who declined → refused (they may only be unseated);
 *   * a table known to be full → refused (the database would refuse too; a
 *     table that filled up meanwhile is still refused by the database);
 *   * otherwise seat (no table yet) or move (another table).
 */
export type DropOutcome =
  | Readonly<{ kind: "noop" }>
  | Readonly<{ kind: "seat"; tableId: string }>
  | Readonly<{ kind: "move"; tableId: string }>
  | Readonly<{ kind: "unseat" }>
  | Readonly<{ kind: "refused"; reason: "table_full" | "guest_declined" }>;

export function guestDropOutcome(guest: DraggedGuest, target: DropTarget): DropOutcome {
  if (target.kind === "rail") return guest.tableId === null ? { kind: "noop" } : { kind: "unseat" };
  if (guest.tableId === target.tableId) return { kind: "noop" };
  if (guest.rsvpState === "declined") return { kind: "refused", reason: "guest_declined" };
  if (target.isFull) return { kind: "refused", reason: "table_full" };
  return guest.tableId === null ? { kind: "seat", tableId: target.tableId } : { kind: "move", tableId: target.tableId };
}

/** Whether a guest in this state can be picked up at all (an unseated decliner can't go anywhere). */
export function isGuestDraggable(guest: DraggedGuest): boolean {
  return guest.rsvpState !== "declined" || guest.tableId !== null;
}

// ------------------------------------------------------- optimistic state

/** The planner's authoritative inputs, as loaded by the server (`getSeatingData`). */
export type PlannerState = Readonly<{
  tables: readonly SeatingTableInput[];
  parties: readonly SeatingPartyInput[];
}>;

export type PlannerAction =
  | Readonly<{ type: "assign"; guestId: string; tableId: string | null }>
  | Readonly<{ type: "position"; tableId: string; position: TablePosition }>;

/**
 * Applies one pending change on top of the server state (React's
 * `useOptimistic` reducer). Pure: it never mutates its input, so dropping
 * the pending action (a failed save) shows the server state again, and
 * re-applying it to fresh server props that already contain the change is a
 * no-op. Unchanged branches are returned as-is.
 */
export function applyPlannerAction(state: PlannerState, action: PlannerAction): PlannerState {
  if (action.type === "position") {
    let changed = false;
    const tables = state.tables.map((table) => {
      if (table.id !== action.tableId) return table;
      if (table.layout && table.layout.x === action.position.x && table.layout.y === action.position.y) return table;
      changed = true;
      return { ...table, layout: { x: action.position.x, y: action.position.y } };
    });
    return changed ? { ...state, tables } : state;
  }

  let changed = false;
  const parties = state.parties.map((party) => {
    if (!party.guests.some((g) => g.id === action.guestId && g.tableId !== action.tableId)) return party;
    changed = true;
    return {
      ...party,
      guests: party.guests.map((g) => (g.id === action.guestId ? { ...g, tableId: action.tableId } : g)),
    };
  });
  return changed ? { ...state, parties } : state;
}
