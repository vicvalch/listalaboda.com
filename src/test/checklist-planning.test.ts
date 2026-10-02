import { describe, expect, it } from "vitest";

import { filterItems } from "@/lib/checklist/filters";
import {
  assignedTo,
  comparePlanning,
  groupByCategory,
  nextItems,
  planningKey,
  sortByPlanning,
} from "@/lib/checklist/planning";
import type {
  ChecklistCategory,
  ChecklistItem,
  ChecklistStatus,
  ChecklistTiming,
} from "@/lib/checklist/types";

function item(
  id: string,
  sortOrder: number,
  timing: ChecklistTiming = { mode: "none" },
  status: ChecklistStatus = "pending",
  category: ChecklistCategory | null = null,
  assigneeMembershipId: string | null = null,
): ChecklistItem {
  return {
    id,
    title: id,
    description: null,
    category,
    status,
    timing,
    sortOrder,
    assigneeMembershipId,
  };
}

const relative = (relativeDays: number) => ({ mode: "relative_to_wedding", relativeDays }) as const;
const absolute = (dueDate: string) => ({ mode: "absolute", dueDate }) as const;
const ids = (items: readonly ChecklistItem[]) => items.map((i) => i.id);

const WEDDING = "2027-08-14";

describe("planningKey", () => {
  it("puts dated, relative-without-date and undated items in buckets 0, 1, 2", () => {
    expect(planningKey(item("a", 1, relative(-30)), WEDDING)).toEqual({
      bucket: 0,
      dueDate: "2027-07-15",
      relativeDays: null,
    });
    expect(planningKey(item("b", 1, absolute("2027-01-01")), null)).toEqual({
      bucket: 0,
      dueDate: "2027-01-01",
      relativeDays: null,
    });
    expect(planningKey(item("c", 1, relative(-30)), null)).toEqual({
      bucket: 1,
      dueDate: null,
      relativeDays: -30,
    });
    expect(planningKey(item("d", 1), WEDDING)).toEqual({ bucket: 2, dueDate: null, relativeDays: null });
  });
});

describe("planning order", () => {
  // Persisted order: a, b, c, d, e, f, g (sortOrder 10..70).
  const fixture = [
    item("a-late", 10, relative(-10)),
    item("b-undated", 20),
    item("c-early", 30, relative(-300)),
    item("d-custom-absolute", 40, absolute("2026-01-01")),
    item("e-tie-second", 60, relative(-60)),
    item("f-tie-first", 50, relative(-60)),
    item("g-after", 70, relative(7)),
  ];

  it("sorts dated items by effective date, undated items last", () => {
    expect(ids(sortByPlanning(fixture, WEDDING))).toEqual([
      "d-custom-absolute",
      "c-early",
      "f-tie-first",
      "e-tie-second",
      "a-late",
      "g-after",
      "b-undated",
    ]);
  });

  it("breaks same-date ties by persisted sort order, then id", () => {
    const sameDay = [item("y", 10, relative(-5)), item("x", 10, relative(-5)), item("w", 5, relative(-5))];
    expect(ids(sortByPlanning(sameDay, WEDDING))).toEqual(["w", "x", "y"]);
  });

  it("without a wedding date: absolute first, then relative by rule, then undated", () => {
    expect(ids(sortByPlanning(fixture, null))).toEqual([
      "d-custom-absolute",
      "c-early",
      "f-tie-first",
      "e-tie-second",
      "a-late",
      "g-after",
      "b-undated",
    ]);
    const mixed = [item("rel", 10, relative(-400)), item("abs", 20, absolute("2030-01-01")), item("none", 5)];
    expect(ids(sortByPlanning(mixed, null))).toEqual(["abs", "rel", "none"]);
  });

  it("follows the wedding date: the same rules sort differently once the date moves", () => {
    const items = [item("rel", 10, relative(-30)), item("abs", 20, absolute("2027-06-01"))];
    expect(ids(sortByPlanning(items, "2027-08-14"))).toEqual(["abs", "rel"]);
    expect(ids(sortByPlanning(items, "2027-06-15"))).toEqual(["rel", "abs"]);
  });

  it("is stable and independent of input order, and never mutates the input", () => {
    const expected = ids(sortByPlanning(fixture, WEDDING));
    const reversed = [...fixture].reverse();
    expect(ids(sortByPlanning(reversed, WEDDING))).toEqual(expected);
    expect(ids(reversed)).toEqual(ids([...fixture].reverse()));
    expect(ids(fixture)[0]).toBe("a-late");
    expect(fixture.map((i) => i.sortOrder)).toEqual([10, 20, 30, 40, 60, 50, 70]);
  });

  it("is a total order (antisymmetric) over the fixture", () => {
    const compare = comparePlanning(WEDDING);
    for (const a of fixture) {
      for (const b of fixture) {
        expect(Math.sign(compare(a, b)) + Math.sign(compare(b, a))).toBe(0);
        if (a !== b) expect(compare(a, b)).not.toBe(0);
      }
    }
  });
});

describe("nextItems (Lo próximo)", () => {
  it("lists up to 5 pending items in planning order", () => {
    const items = Array.from({ length: 8 }, (_, i) => item(`i${i}`, i * 10, relative(-10 * i)));
    expect(ids(nextItems(items, WEDDING))).toEqual(["i7", "i6", "i5", "i4", "i3"]);
    expect(nextItems(items, WEDDING, 2)).toHaveLength(2);
  });

  it("excludes done and not-applicable items", () => {
    const items = [
      item("done", 10, relative(-400), "done"),
      item("na", 20, relative(-300), "not_applicable"),
      item("pending", 30, relative(-10)),
    ];
    expect(ids(nextItems(items, WEDDING))).toEqual(["pending"]);
  });

  it("includes a custom absolute item by its date", () => {
    const items = [item("tmpl", 10, relative(-30)), item("custom", 99, absolute("2027-01-01"))];
    expect(ids(nextItems(items, WEDDING))).toEqual(["custom", "tmpl"]);
  });

  it("still suggests items when the wedding has no date", () => {
    const items = [item("undated", 10), item("rel", 20, relative(-90))];
    expect(ids(nextItems(items, null))).toEqual(["rel", "undated"]);
  });

  it("is empty when nothing is pending", () => {
    expect(nextItems([item("d", 1, { mode: "none" }, "done")], WEDDING)).toEqual([]);
    expect(nextItems([], WEDDING)).toEqual([]);
  });
});

describe("groupByCategory", () => {
  it("orders groups by their first persisted item, uncategorized last", () => {
    const items = [
      item("v1", 30, undefined, "pending", "vendors"),
      item("x", 5, undefined, "pending", null),
      item("f1", 10, undefined, "pending", "first_steps"),
      item("v0", 20, undefined, "pending", "vendors"),
      item("f2", 40, undefined, "pending", "first_steps"),
    ];
    const groups = groupByCategory(items);
    expect(groups.map((g) => g.category)).toEqual(["first_steps", "vendors", null]);
    expect(groups.map((g) => ids(g.items))).toEqual([["f1", "f2"], ["v0", "v1"], ["x"]]);
  });

  it("does not alphabetize: template order wins", () => {
    const items = [
      item("r", 10, undefined, "pending", "reception"),
      item("a", 20, undefined, "pending", "attire"),
    ];
    expect(groupByCategory(items).map((g) => g.category)).toEqual(["reception", "attire"]);
  });

  it("a custom item in a new category opens a group where it sits in the list", () => {
    const items = [
      item("f", 10, undefined, "pending", "first_steps"),
      item("custom", 500, undefined, "pending", "after_wedding"),
    ];
    expect(groupByCategory(items).map((g) => g.category)).toEqual(["first_steps", "after_wedding"]);
  });

  it("derives per-category progress excluding not applicable", () => {
    const items = [
      item("a", 10, undefined, "done", "attire"),
      item("b", 20, undefined, "pending", "attire"),
      item("c", 30, undefined, "not_applicable", "attire"),
      item("d", 40, undefined, "not_applicable", "ceremony"),
    ];
    const [attire, ceremony] = groupByCategory(items);
    expect(attire.progress).toMatchObject({ done: 1, applicable: 2, notApplicable: 1, percent: 50 });
    // Nothing applicable: 0 of 0, never a misleading 100%.
    expect(ceremony.progress).toMatchObject({ done: 0, applicable: 0, notApplicable: 1, percent: 0 });
  });

  it("is empty for an empty list", () => {
    expect(groupByCategory([])).toEqual([]);
  });
});

describe("assignedTo (Mis pendientes)", () => {
  const ME = "me";
  const fixture = [
    item("mine-late", 10, relative(-10), "pending", null, ME),
    item("other", 20, relative(-200), "pending", null, "someone-else"),
    item("unassigned", 30, relative(-300)),
    item("mine-done", 40, relative(-50), "done", null, ME),
    item("mine-na", 50, relative(-40), "not_applicable", null, ME),
    item("mine-early", 60, relative(-100), "pending", null, ME),
  ];

  it("keeps only the current member's items, in the input order", () => {
    expect(ids(assignedTo(fixture, ME))).toEqual([
      "mine-late",
      "mine-done",
      "mine-na",
      "mine-early",
    ]);
  });

  it("never includes unassigned items or someone else's", () => {
    expect(ids(assignedTo(fixture, "nobody"))).toEqual([]);
    expect(ids(assignedTo(fixture, "someone-else"))).toEqual(["other"]);
  });

  it("composes with the status filter, which stays independent", () => {
    const mine = assignedTo(fixture, ME);
    expect(ids(filterItems(mine, "pending"))).toEqual(["mine-late", "mine-early"]);
    expect(ids(filterItems(mine, "done"))).toEqual(["mine-done"]);
    expect(ids(filterItems(mine, "not_applicable"))).toEqual(["mine-na"]);
    expect(ids(filterItems(mine, "all"))).toHaveLength(4);
  });

  it("uses the same planning order as Plan, without reordering the input", () => {
    const mine = assignedTo(fixture, ME);
    const pending = sortByPlanning(filterItems(mine, "pending"), WEDDING);
    expect(ids(pending)).toEqual(["mine-early", "mine-late"]);
    expect(ids(fixture)[0]).toBe("mine-late");
  });

  it("assignment never changes planning order or Lo próximo", () => {
    const unassigned = fixture.map((i) => ({ ...i, assigneeMembershipId: null }));
    expect(ids(sortByPlanning(fixture, WEDDING))).toEqual(ids(sortByPlanning(unassigned, WEDDING)));
    expect(ids(nextItems(fixture, WEDDING))).toEqual(ids(nextItems(unassigned, WEDDING)));
    expect(groupByCategory(fixture).map((g) => g.category)).toEqual(
      groupByCategory(unassigned).map((g) => g.category),
    );
  });
});
