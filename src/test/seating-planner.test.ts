import { describe, expect, it } from "vitest";

import { buildSeatingPlan, type SeatingPartyInput, type SeatingTableInput } from "@/lib/seating/plan";
import {
  BOARD_WIDTH,
  GRID_SIZE,
  MIN_BOARD_HEIGHT,
  SLOT_SPACING,
  applyPlannerAction,
  boardHeight,
  boardScale,
  chairMarkers,
  clampPosition,
  deriveTablePositions,
  droppedTablePosition,
  guestDropOutcome,
  isGuestDraggable,
  logicalToScreen,
  screenDeltaToLogical,
  snapToGrid,
  tableFootprint,
  tableShapeSize,
  type LayoutTable,
  type PlannerState,
} from "@/lib/seating/planner";
import { LAYOUT_COORDINATE_MAX, type TableShape } from "@/lib/seating/validation";

// LB-20 (ADR-013): the visual planner's pure geometry and optimistic state.
// No DOM: the board's rendered width only enters as a number (the scale).

const SHAPES: readonly TableShape[] = ["round", "rectangle"];
const CAPACITIES = [1, 2, 4, 8, 10, 20, 50] as const;

// ------------------------------------------------------------ coordinates

describe("scale and coordinate conversion", () => {
  it("the scale is the rendered width over the 1200-unit logical width", () => {
    expect(BOARD_WIDTH).toBe(1200);
    expect(boardScale(1200)).toBe(1);
    expect(boardScale(600)).toBe(0.5);
    expect(boardScale(900)).toBe(0.75);
    expect(boardScale(1800)).toBe(1.5);
  });

  it("200 screen pixels at scale 0.5 are 400 logical units (the delta is DIVIDED by the scale)", () => {
    expect(screenDeltaToLogical({ x: 200, y: 200 }, 0.5)).toEqual({ x: 400, y: 400 });
  });

  it.each([
    [1, { x: 200, y: -60 }, { x: 200, y: -60 }],
    [0.5, { x: 200, y: -60 }, { x: 400, y: -120 }],
    [0.75, { x: 150, y: 30 }, { x: 200, y: 40 }],
    [1.5, { x: 300, y: 90 }, { x: 200, y: 60 }],
  ] as const)("at scale %d, screen %j → logical %j", (scale, screen, logical) => {
    const result = screenDeltaToLogical(screen, scale);
    expect(result.x).toBeCloseTo(logical.x, 10);
    expect(result.y).toBeCloseTo(logical.y, 10);
  });

  it("logical → screen is the inverse (multiplied by the scale)", () => {
    for (const scale of [0.5, 0.75, 1, 1.5]) {
      expect(logicalToScreen(400, scale)).toBeCloseTo(400 * scale, 10);
      expect(screenDeltaToLogical({ x: logicalToScreen(400, scale), y: 0 }, scale).x).toBeCloseTo(400, 10);
    }
  });

  it("an unmeasured board (scale 0, negative or NaN) moves nothing", () => {
    for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(screenDeltaToLogical({ x: 100, y: 100 }, scale)).toEqual({ x: 0, y: 0 });
    }
  });

  it("a dropped table lands at start + delta ÷ scale, snapped and clamped", () => {
    const footprint = tableFootprint("round", 8);
    // 200 px right and 100 px down at scale 0.5 → +400, +200 units.
    expect(droppedTablePosition({ x: 300, y: 300 }, { x: 200, y: 100 }, 0.5, footprint)).toEqual({ x: 700, y: 500 });
    // Same pixels at scale 1 → +200, +100.
    expect(droppedTablePosition({ x: 300, y: 300 }, { x: 200, y: 100 }, 1, footprint)).toEqual({ x: 500, y: 400 });
    // One keyboard grid step at any scale is exactly 20 units.
    for (const scale of [0.37, 0.5, 0.613, 0.75, 1.25]) {
      expect(droppedTablePosition({ x: 300, y: 300 }, { x: GRID_SIZE * scale, y: 0 }, scale, footprint)).toEqual({
        x: 320,
        y: 300,
      });
    }
  });
});

// --------------------------------------------------------------- grid/clamp

describe("grid snapping and clamping", () => {
  it("snaps to the nearest multiple of 20", () => {
    expect(GRID_SIZE).toBe(20);
    expect(snapToGrid(0)).toBe(0);
    expect(snapToGrid(9)).toBe(0);
    expect(snapToGrid(10)).toBe(20);
    expect(snapToGrid(29.9)).toBe(20);
    expect(snapToGrid(31)).toBe(40);
    expect(snapToGrid(1187)).toBe(1180);
    expect(Object.is(snapToGrid(-4), 0)).toBe(true);
  });

  it("keeps the whole footprint on the board horizontally, on the grid", () => {
    const footprint = tableFootprint("round", 8); // 170 wide
    expect(clampPosition({ x: -500, y: 300 }, footprint)).toEqual({ x: 100, y: 300 });
    expect(clampPosition({ x: 5000, y: 300 }, footprint)).toEqual({ x: 1100, y: 300 });
    const wide = tableFootprint("rectangle", 50); // 368 wide
    expect(clampPosition({ x: 0, y: 300 }, wide)).toEqual({ x: 200, y: 300 });
    expect(clampPosition({ x: BOARD_WIDTH, y: 300 }, wide)).toEqual({ x: 1000, y: 300 });
    for (const p of [clampPosition({ x: -1, y: -1 }, wide), clampPosition({ x: 9999, y: 9999 }, wide)]) {
      expect(p.x % GRID_SIZE).toBe(0);
      expect(p.y % GRID_SIZE).toBe(0);
    }
  });

  it("vertical values never go above the top and stay within the database range", () => {
    for (const shape of SHAPES) {
      for (const capacity of CAPACITIES) {
        const footprint = tableFootprint(shape, capacity);
        const top = clampPosition({ x: 600, y: -1000 }, footprint);
        expect(top.y - footprint.height / 2).toBeGreaterThanOrEqual(0);
        const bottom = clampPosition({ x: 600, y: 50_000 }, footprint);
        expect(bottom.y).toBeLessThanOrEqual(LAYOUT_COORDINATE_MAX);
        expect(Number.isInteger(top.y) && Number.isInteger(bottom.y)).toBe(true);
      }
    }
  });

  it("a drop past the edges clamps instead of leaving the board", () => {
    const footprint = tableFootprint("round", 4);
    expect(droppedTablePosition({ x: 100, y: 100 }, { x: -1000, y: -1000 }, 0.5, footprint)).toEqual({ x: 80, y: 80 });
    expect(droppedTablePosition({ x: 1100, y: 100 }, { x: 1000, y: 0 }, 0.5, footprint).x).toBe(1120);
  });
});

// -------------------------------------------------------------------- sizes

describe("derived table sizes", () => {
  it("round tables grow with capacity within 100–150 units", () => {
    expect(tableShapeSize("round", 1)).toEqual({ width: 100, height: 100 });
    expect(tableShapeSize("round", 8)).toEqual({ width: 122, height: 122 });
    expect(tableShapeSize("round", 50)).toEqual({ width: 150, height: 150 });
  });

  it("rectangles grow in width within 100–320 units and keep a compact height", () => {
    expect(tableShapeSize("rectangle", 1)).toEqual({ width: 100, height: 70 });
    expect(tableShapeSize("rectangle", 10)).toEqual({ width: 140, height: 70 });
    expect(tableShapeSize("rectangle", 50)).toEqual({ width: 320, height: 70 });
  });

  it("sizes are monotonic and bounded for every capacity", () => {
    for (const shape of SHAPES) {
      let previous = 0;
      for (let capacity = 1; capacity <= 50; capacity += 1) {
        const { width, height } = tableShapeSize(shape, capacity);
        expect(width).toBeGreaterThanOrEqual(previous);
        expect(width).toBeLessThanOrEqual(320);
        expect(height).toBeLessThanOrEqual(150);
        previous = width;
      }
    }
  });
});

// ---------------------------------------------------------- initial layout

const unplaced = (id: string, capacity = 8, shape: TableShape = "round"): LayoutTable => ({
  id,
  shape,
  capacity,
  layout: null,
});

describe("derived positions for tables without a stored position", () => {
  it("fills ~6 slots per row, 200 units apart, in the given order, then continues on the next row", () => {
    const tables = Array.from({ length: 8 }, (_, i) => unplaced(`t${i}`));
    const placed = deriveTablePositions(tables);
    expect(placed.map((p) => p.id)).toEqual(tables.map((t) => t.id));
    expect(placed.map((p) => p.position)).toEqual([
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 500, y: 100 },
      { x: 700, y: 100 },
      { x: 900, y: 100 },
      { x: 1100, y: 100 },
      { x: 100, y: 300 },
      { x: 300, y: 300 },
    ]);
    expect(placed.every((p) => p.derived)).toBe(true);
    expect(SLOT_SPACING).toBe(200);
  });

  it("is deterministic across calls", () => {
    const tables = [unplaced("a", 4), unplaced("b", 50, "rectangle"), unplaced("c", 12), unplaced("d", 1)];
    expect(deriveTablePositions(tables)).toEqual(deriveTablePositions(tables));
  });

  it("stored positions stay fixed and win; derived slots skip their bounds", () => {
    const tables: LayoutTable[] = [
      { id: "fixed", shape: "round", capacity: 8, layout: { x: 320, y: 120 } },
      unplaced("a"),
      unplaced("b"),
      unplaced("c"),
    ];
    const placed = deriveTablePositions(tables);
    expect(placed[0]).toMatchObject({ id: "fixed", position: { x: 320, y: 120 }, derived: false });
    // Slot 1 (300, 100) and slot 2 (500, 100) overlap the fixed table's footprint.
    const derived = placed.slice(1).map((p) => p.position);
    expect(derived).not.toContainEqual({ x: 300, y: 100 });
    expect(new Set(derived.map((p) => `${p.x},${p.y}`)).size).toBe(3);
    const box = (p: (typeof placed)[number]) => ({
      l: p.position.x - p.footprint.width / 2,
      r: p.position.x + p.footprint.width / 2,
      t: p.position.y - p.footprint.height / 2,
      b: p.position.y + p.footprint.height / 2,
    });
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = box(placed[i]!);
        const b = box(placed[j]!);
        expect(a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b, `${placed[i]!.id} overlaps ${placed[j]!.id}`).toBe(false);
      }
    }
  });

  it("wide tables don't overlap their neighbours", () => {
    const tables = [unplaced("w1", 50, "rectangle"), unplaced("w2", 50, "rectangle"), unplaced("r", 8)];
    const placed = deriveTablePositions(tables);
    const [w1, w2] = placed;
    expect(Math.abs(w1!.position.x - w2!.position.x) >= w1!.footprint.width || w1!.position.y !== w2!.position.y).toBe(
      true,
    );
  });

  it("never piles unplaced tables at the origin", () => {
    const placed = deriveTablePositions(Array.from({ length: 50 }, (_, i) => unplaced(`t${i}`, (i % 50) + 1)));
    const keys = placed.map((p) => `${p.position.x},${p.position.y}`);
    expect(new Set(keys).size).toBe(50);
    expect(placed.filter((p) => p.position.x === 0 && p.position.y === 0)).toEqual([]);
  });

  it("placing one table doesn't reflow the other unplaced tables", () => {
    const before = deriveTablePositions([unplaced("a"), unplaced("b"), unplaced("c")]);
    const after = deriveTablePositions([
      { ...unplaced("a"), layout: { x: 600, y: 700 } },
      unplaced("b"),
      unplaced("c"),
    ]);
    expect(after[1]!.position).toEqual(before[1]!.position);
    expect(after[2]!.position).toEqual(before[2]!.position);
  });

  it("the board is at least 800 units tall and grows below the lowest table", () => {
    expect(MIN_BOARD_HEIGHT).toBe(800);
    expect(boardHeight([])).toBe(800);
    expect(boardHeight(deriveTablePositions([unplaced("a")]))).toBe(800);
    const low = deriveTablePositions([{ ...unplaced("a"), layout: { x: 600, y: 1500 } }]);
    expect(boardHeight(low)).toBeGreaterThan(1500 + low[0]!.footprint.height / 2);
    expect(boardHeight(low) % GRID_SIZE).toBe(0);
  });
});

// ------------------------------------------------------------------ chairs

describe("decorative chair markers", () => {
  for (const shape of SHAPES) {
    it.each(CAPACITIES)(`${shape}: capacity %i → exactly that many finite, deterministic points`, (capacity) => {
      const chairs = chairMarkers(shape, capacity);
      expect(chairs.points).toHaveLength(capacity);
      for (const point of chairs.points) {
        expect(Object.keys(point).sort()).toEqual(["x", "y"]);
        expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
      }
      expect(Number.isFinite(chairs.radius) && chairs.radius > 0).toBe(true);
      expect(chairMarkers(shape, capacity)).toEqual(chairs);
    });
  }

  it("round: evenly spread around the full circumference, the first at the top", () => {
    for (const capacity of CAPACITIES) {
      const { points } = chairMarkers("round", capacity);
      const radii = points.map((p) => Math.hypot(p.x, p.y));
      for (const r of radii) expect(r).toBeCloseTo(radii[0]!, 9);
      expect(points[0]!.x).toBeCloseTo(0, 9);
      expect(points[0]!.y).toBeLessThan(0);
      if (capacity > 1) {
        const angles = points.map((p) => Math.atan2(p.y, p.x));
        const step = (2 * Math.PI) / capacity;
        for (let i = 1; i < angles.length; i += 1) {
          const diff = (angles[i]! - angles[i - 1]! + 2 * Math.PI) % (2 * Math.PI);
          expect(diff).toBeCloseTo(step, 9);
        }
        // The centroid of an even spread is the center.
        expect(points.reduce((s, p) => s + p.x, 0) / capacity).toBeCloseTo(0, 9);
        expect(points.reduce((s, p) => s + p.y, 0) / capacity).toBeCloseTo(0, 9);
      }
    }
  });

  it("rectangle: ceil(N/2) on top, floor(N/2) on the bottom, evenly spaced", () => {
    for (const capacity of CAPACITIES) {
      const { points } = chairMarkers("rectangle", capacity);
      const top = points.filter((p) => p.y < 0);
      const bottom = points.filter((p) => p.y > 0);
      expect(top).toHaveLength(Math.ceil(capacity / 2));
      expect(bottom).toHaveLength(Math.floor(capacity / 2));
      for (const row of [top, bottom]) {
        for (let i = 2; i < row.length; i += 1) {
          expect(row[i]!.x - row[i - 1]!.x).toBeCloseTo(row[1]!.x - row[0]!.x, 9);
        }
      }
    }
  });

  it("markers are positions only — never ids or guests", () => {
    const plan = buildSeatingPlan(
      [{ id: "t", name: "Mesa", capacity: 4, shape: "round", layout: null }],
      [{ id: "p", label: "P", guests: [{ id: "g1", name: "Ana", attending: true, tableId: "t" }] }],
    );
    const chairs = chairMarkers(plan.tables[0]!.shape, plan.tables[0]!.capacity);
    expect(JSON.stringify(chairs)).not.toMatch(/g1|Ana|guest|id/);
    // Capacity, not seated people, decides the count.
    expect(chairs.points).toHaveLength(4);
  });
});

// -------------------------------------------------------- drop eligibility

describe("guest drop eligibility", () => {
  const open = { kind: "table", tableId: "t2", isFull: false } as const;
  const full = { kind: "table", tableId: "t2", isFull: true } as const;
  const rail = { kind: "rail" } as const;

  it("an attending unseated guest → a non-full table: seat", () => {
    expect(guestDropOutcome({ rsvpState: "attending", tableId: null }, open)).toEqual({ kind: "seat", tableId: "t2" });
  });

  it("a pending guest is seatable and movable", () => {
    expect(guestDropOutcome({ rsvpState: "pending", tableId: null }, open)).toEqual({ kind: "seat", tableId: "t2" });
    expect(guestDropOutcome({ rsvpState: "pending", tableId: "t1" }, open)).toEqual({ kind: "move", tableId: "t2" });
  });

  it("a seated guest → another table: move", () => {
    expect(guestDropOutcome({ rsvpState: "attending", tableId: "t1" }, open)).toEqual({ kind: "move", tableId: "t2" });
  });

  it("a known-full table refuses", () => {
    expect(guestDropOutcome({ rsvpState: "attending", tableId: null }, full)).toEqual({
      kind: "refused",
      reason: "table_full",
    });
    expect(guestDropOutcome({ rsvpState: "pending", tableId: "t1" }, full)).toEqual({
      kind: "refused",
      reason: "table_full",
    });
  });

  it("the same table is a no-op (even when full)", () => {
    expect(guestDropOutcome({ rsvpState: "attending", tableId: "t2" }, full)).toEqual({ kind: "noop" });
    expect(guestDropOutcome({ rsvpState: "attending", tableId: null }, rail)).toEqual({ kind: "noop" });
  });

  it("a declined guest can't go to any table, seated or not", () => {
    expect(guestDropOutcome({ rsvpState: "declined", tableId: null }, open)).toEqual({
      kind: "refused",
      reason: "guest_declined",
    });
    expect(guestDropOutcome({ rsvpState: "declined", tableId: "t1" }, open)).toEqual({
      kind: "refused",
      reason: "guest_declined",
    });
  });

  it("anyone seated, a declined guest included, can go back to the rail", () => {
    expect(guestDropOutcome({ rsvpState: "declined", tableId: "t1" }, rail)).toEqual({ kind: "unseat" });
    expect(guestDropOutcome({ rsvpState: "pending", tableId: "t1" }, rail)).toEqual({ kind: "unseat" });
  });

  it("an unseated guest who declined can't be picked up at all", () => {
    expect(isGuestDraggable({ rsvpState: "declined", tableId: null })).toBe(false);
    expect(isGuestDraggable({ rsvpState: "declined", tableId: "t1" })).toBe(true);
    expect(isGuestDraggable({ rsvpState: "pending", tableId: null })).toBe(true);
  });
});

// ------------------------------------------------------- optimistic state

const TABLES: SeatingTableInput[] = [
  { id: "t1", name: "Mesa 1", capacity: 2, shape: "round", layout: null },
  { id: "t2", name: "Mesa 2", capacity: 4, shape: "rectangle", layout: { x: 500, y: 300 } },
];
const PARTIES: SeatingPartyInput[] = [
  {
    id: "p1",
    label: "Familia Pérez",
    guests: [
      { id: "a", name: "Ana", attending: true, tableId: null },
      { id: "b", name: "Beto", attending: null, tableId: "t1" },
    ],
  },
];
const SERVER: PlannerState = { tables: TABLES, parties: PARTIES };
const frozen = JSON.stringify(SERVER);

const tableOf = (state: PlannerState, guestId: string) =>
  state.parties.flatMap((p) => p.guests).find((g) => g.id === guestId)?.tableId;

describe("optimistic planner state", () => {
  it("seat: the guest shows at the table at once", () => {
    const next = applyPlannerAction(SERVER, { type: "assign", guestId: "a", tableId: "t2" });
    expect(tableOf(next, "a")).toBe("t2");
    expect(buildSeatingPlan(next.tables, next.parties).tables[1]!.assignedCount).toBe(1);
  });

  it("move: from one table to another", () => {
    const next = applyPlannerAction(SERVER, { type: "assign", guestId: "b", tableId: "t2" });
    expect(tableOf(next, "b")).toBe("t2");
    const plan = buildSeatingPlan(next.tables, next.parties);
    expect(plan.tables.map((t) => t.assignedCount)).toEqual([0, 1]);
  });

  it("unseat: back to the rail", () => {
    const next = applyPlannerAction(SERVER, { type: "assign", guestId: "b", tableId: null });
    expect(tableOf(next, "b")).toBeNull();
    expect(buildSeatingPlan(next.tables, next.parties).unassigned.pending[0]!.guests.map((g) => g.id)).toEqual(["b"]);
  });

  it("a failed action rolls back to the untouched server state", () => {
    // useOptimistic drops the pending action and renders the base again: the
    // reducer must never have mutated it.
    applyPlannerAction(SERVER, { type: "assign", guestId: "a", tableId: "t1" });
    applyPlannerAction(SERVER, { type: "position", tableId: "t1", position: { x: 900, y: 500 } });
    expect(JSON.stringify(SERVER)).toBe(frozen);
    expect(tableOf(SERVER, "a")).toBeNull();
    expect(SERVER.tables[0]!.layout).toBeNull();
  });

  it("successful server props that already contain the change make the action a no-op", () => {
    const confirmed: PlannerState = {
      ...SERVER,
      parties: [{ ...PARTIES[0]!, guests: [{ ...PARTIES[0]!.guests[0]!, tableId: "t2" }, PARTIES[0]!.guests[1]!] }],
    };
    expect(applyPlannerAction(confirmed, { type: "assign", guestId: "a", tableId: "t2" })).toBe(confirmed);
    const placed: PlannerState = { ...SERVER, tables: [{ ...TABLES[0]!, layout: { x: 900, y: 500 } }, TABLES[1]!] };
    expect(applyPlannerAction(placed, { type: "position", tableId: "t1", position: { x: 900, y: 500 } })).toBe(placed);
  });

  it("table position: optimistic update, then rollback to the last server position", () => {
    const moved = applyPlannerAction(SERVER, { type: "position", tableId: "t2", position: { x: 700, y: 520 } });
    expect(moved.tables[1]!.layout).toEqual({ x: 700, y: 520 });
    // Only the position changes: capacity, shape and assignments are untouched.
    expect(moved.tables[1]).toEqual({ ...TABLES[1], layout: { x: 700, y: 520 } });
    expect(moved.parties).toBe(SERVER.parties);
    // Rollback = the server state, which still has the old position.
    expect(SERVER.tables[1]!.layout).toEqual({ x: 500, y: 300 });
  });

  it("unknown ids change nothing", () => {
    expect(applyPlannerAction(SERVER, { type: "assign", guestId: "zzz", tableId: "t1" })).toBe(SERVER);
    expect(applyPlannerAction(SERVER, { type: "position", tableId: "zzz", position: { x: 1, y: 1 } })).toBe(SERVER);
  });
});
