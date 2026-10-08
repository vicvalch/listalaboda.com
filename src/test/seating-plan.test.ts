import { describe, expect, it } from "vitest";

import {
  buildSeatingPlan,
  isSeatable,
  seatingRsvpState,
  type SeatingPartyInput,
  type SeatingTableInput,
} from "@/lib/seating/plan";

// LB-19 (ADR-012): the seating page model is derived in memory, never stored.
// These tests pin the rules shared with the database: every assignment row
// takes a seat, pending guests are seatable, declined guests aren't, and a
// guest who declined after being seated stays there as a conflict.

const T1: SeatingTableInput = { id: "t1", name: "Mesa 1", capacity: 3 };
const T2: SeatingTableInput = { id: "t2", name: "Mesa 2", capacity: 2 };

const guest = (id: string, attending: boolean | null, tableId: string | null = null) => ({
  id,
  name: `Invitado ${id}`,
  attending,
  tableId,
});

const PARTIES: SeatingPartyInput[] = [
  {
    id: "p1",
    label: "Familia Pérez",
    guests: [guest("a", true, "t1"), guest("b", true), guest("c", false, "t1")],
  },
  { id: "p2", label: "Familia Gómez", guests: [guest("d", null, "t1"), guest("e", null)] },
  { id: "p3", label: "Ana y Carlos", guests: [guest("f", false), guest("g", true, "t2"), guest("h", true)] },
];

describe("seating RSVP state", () => {
  it("maps no RSVP to pending, yes to attending and no to declined", () => {
    expect(seatingRsvpState(null)).toBe("pending");
    expect(seatingRsvpState(true)).toBe("attending");
    expect(seatingRsvpState(false)).toBe("declined");
  });

  it("only declined guests are not seatable", () => {
    expect(isSeatable("attending")).toBe(true);
    expect(isSeatable("pending")).toBe(true);
    expect(isSeatable("declined")).toBe(false);
  });
});

describe("buildSeatingPlan", () => {
  const plan = buildSeatingPlan([T1, T2], PARTIES);

  it("keeps tables in the given order with occupancy from every assignment row", () => {
    expect(plan.tables.map((t) => [t.id, t.assignedCount, t.capacity, t.freeCapacity, t.isFull])).toEqual([
      // a (attending) + c (declined) + d (pending): all three count.
      ["t1", 3, 3, 0, true],
      ["t2", 1, 2, 1, false],
    ]);
  });

  it("lists seated guests in party order then guest order, with RSVP state and party context", () => {
    expect(plan.tables[0]!.guests.map((g) => [g.id, g.rsvpState, g.partyLabel, g.tableId])).toEqual([
      ["a", "attending", "Familia Pérez", "t1"],
      ["c", "declined", "Familia Pérez", "t1"],
      ["d", "pending", "Familia Gómez", "t1"],
    ]);
  });

  it("groups unseated attending and pending guests by party, in order", () => {
    expect(plan.unassigned.attending.map((g) => [g.partyId, g.partyLabel, g.guests.map((x) => x.id)])).toEqual([
      ["p1", "Familia Pérez", ["b"]],
      ["p3", "Ana y Carlos", ["h"]],
    ]);
    expect(plan.unassigned.pending.map((g) => [g.partyId, g.guests.map((x) => x.id)])).toEqual([["p2", ["e"]]]);
  });

  it("keeps unseated declined guests apart (informational)", () => {
    expect(plan.declined.map((g) => [g.partyId, g.guests.map((x) => [x.id, x.rsvpState])])).toEqual([
      ["p3", [["f", "declined"]]],
    ]);
  });

  it("flags seated guests who declined as conflicts, without unseating them", () => {
    expect(plan.conflicts.map((g) => [g.id, g.tableId])).toEqual([["c", "t1"]]);
    expect(plan.tables[0]!.guests.some((g) => g.id === "c")).toBe(true);
  });

  it("summarizes confirmed, seated (all rows), confirmed-unseated, capacity and seated-declined", () => {
    expect(plan.summary).toEqual({
      confirmed: 4, // a, b, g, h
      seated: 4,
      confirmedUnseated: 2,
      totalCapacity: 5,
      seatedDeclined: 1,
    });
  });

  it("never derives free seats from confirmed answers", () => {
    const allPending = buildSeatingPlan(
      [{ id: "t", name: "Mesa", capacity: 2 }],
      [{ id: "p", label: "P", guests: [guest("x", null, "t"), guest("y", null, "t")] }],
    );
    expect(allPending.tables[0]).toMatchObject({ assignedCount: 2, freeCapacity: 0, isFull: true });
    expect(allPending.summary).toMatchObject({ confirmed: 0, seated: 2 });
  });

  it("free capacity never goes negative", () => {
    const over = buildSeatingPlan(
      [{ id: "t", name: "Mesa", capacity: 1 }],
      [{ id: "p", label: "P", guests: [guest("x", true, "t"), guest("y", true, "t")] }],
    );
    expect(over.tables[0]).toMatchObject({ assignedCount: 2, freeCapacity: 0, isFull: true });
  });

  it("an assignment to a table that isn't loaded reads as unassigned", () => {
    const orphan = buildSeatingPlan([T1], [{ id: "p", label: "P", guests: [guest("x", true, "gone")] }]);
    expect(orphan.summary.seated).toBe(0);
    expect(orphan.unassigned.attending[0]!.guests[0]!.tableId).toBeNull();
  });

  it("handles an empty wedding", () => {
    expect(buildSeatingPlan([], [])).toEqual({
      tables: [],
      unassigned: { attending: [], pending: [] },
      declined: [],
      conflicts: [],
      summary: { confirmed: 0, seated: 0, confirmedUnseated: 0, totalCapacity: 0, seatedDeclined: 0 },
    });
  });
});
