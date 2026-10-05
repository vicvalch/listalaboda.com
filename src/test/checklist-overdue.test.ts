import { describe, expect, it } from "vitest";

import {
  isOverdue,
  nextUpcomingItems,
  overdueItems,
  planSections,
  upcomingItems,
  type PlanningDateContext,
} from "@/lib/checklist/overdue";
import { nextItems } from "@/lib/checklist/planning";
import { summarizeProgress } from "@/lib/checklist/progress";
import type { ChecklistItem, ChecklistStatus, ChecklistTiming } from "@/lib/checklist/types";
import { weddingLocalToday } from "@/lib/weddings/timezone";

function item(
  id: string,
  timing: ChecklistTiming,
  status: ChecklistStatus = "pending",
  sortOrder = 1,
): ChecklistItem {
  return {
    id,
    title: id,
    description: null,
    category: null,
    status,
    timing,
    sortOrder,
    assigneeMembershipId: null,
    guestInvitationId: null,
  };
}

const absolute = (dueDate: string) => ({ mode: "absolute", dueDate }) as const;
const relative = (relativeDays: number) => ({ mode: "relative_to_wedding", relativeDays }) as const;
const none = { mode: "none" } as const;

const TODAY = "2027-03-10";
const withZone: PlanningDateContext = { weddingDate: "2027-08-14", today: TODAY };
const noZone: PlanningDateContext = { weddingDate: "2027-08-14", today: null };

describe("isOverdue", () => {
  it.each([
    ["pending, due yesterday", item("a", absolute("2027-03-09")), true],
    ["pending, due today", item("a", absolute("2027-03-10")), false],
    ["pending, due tomorrow", item("a", absolute("2027-03-11")), false],
    ["done, due long ago", item("a", absolute("2026-01-01"), "done"), false],
    ["not applicable, due long ago", item("a", absolute("2026-01-01"), "not_applicable"), false],
    ["pending without timing", item("a", none), false],
    // Wedding 2027-08-14: -160 days = 2027-03-07 (past), -157 = 2027-03-10 (today).
    ["relative, exact date in the past", item("a", relative(-160)), true],
    ["relative, exact date today", item("a", relative(-157)), false],
    ["relative, exact date in the future", item("a", relative(-30)), false],
  ] as const)("%s → %s (with a time zone)", (_label, value, expected) => {
    expect(isOverdue(value, withZone)).toBe(expected);
  });

  it("a relative item is never overdue while the wedding has no date (its rule is kept)", () => {
    const value = item("a", relative(-400));
    expect(isOverdue(value, { weddingDate: null, today: TODAY })).toBe(false);
    expect(value.timing).toEqual(relative(-400));
  });

  it("an absolute date can be overdue even without a wedding date", () => {
    expect(isOverdue(item("a", absolute("2027-01-01")), { weddingDate: null, today: TODAY })).toBe(true);
  });

  it("nothing is overdue without a time zone, however old", () => {
    expect(isOverdue(item("a", absolute("2020-01-01")), noZone)).toBe(false);
    expect(isOverdue(item("b", relative(-1000)), noZone)).toBe(false);
  });

  it("does not mutate the item: overdue is not a status", () => {
    const value = item("a", absolute("2027-01-01"));
    const copy = structuredClone(value);
    isOverdue(value, withZone);
    expect(value).toEqual(copy);
    expect(value.status).toBe("pending");
  });

  it("composes with wedding-local today: one instant, two zones, two answers", () => {
    // Due 2027-01-01. At 2027-01-02T02:00Z it is still Jan 1 in Costa Rica
    // (due today → not overdue) but already Jan 2 in Madrid (overdue).
    const value = item("a", absolute("2027-01-01"));
    const instant = new Date("2027-01-02T02:00:00Z");
    const cr = weddingLocalToday("America/Costa_Rica", instant);
    const madrid = weddingLocalToday("Europe/Madrid", instant);
    expect(isOverdue(value, { weddingDate: null, today: cr })).toBe(false);
    expect(isOverdue(value, { weddingDate: null, today: madrid })).toBe(true);
  });
});

describe("Atrasados and Lo próximo", () => {
  const items = [
    item("future", absolute("2027-04-01"), "pending", 1),
    item("overdue-late", absolute("2027-03-05"), "pending", 2),
    item("today", absolute(TODAY), "pending", 3),
    item("overdue-early", relative(-200), "pending", 4), // 2027-01-26
    item("done-old", absolute("2026-01-01"), "done", 5),
    item("na-old", absolute("2026-01-01"), "not_applicable", 6),
    item("undated", none, "pending", 7),
  ];

  it("overdue items are listed earliest effective date first", () => {
    expect(overdueItems(items, withZone).map((i) => i.id)).toEqual(["overdue-early", "overdue-late"]);
  });

  it("Lo próximo excludes overdue items and keeps today's item; no duplication", () => {
    const next = nextUpcomingItems(items, withZone).map((i) => i.id);
    expect(next).toEqual(["today", "future", "undated"]);
    const overdue = overdueItems(items, withZone).map((i) => i.id);
    expect(next.filter((id) => overdue.includes(id))).toEqual([]);
  });

  it("without a time zone, Lo próximo is exactly the LB-06 planning list", () => {
    expect(nextUpcomingItems(items, noZone)).toEqual(nextItems(items, noZone.weddingDate));
    expect(overdueItems(items, noZone)).toEqual([]);
  });

  it("Lo próximo still respects its limit", () => {
    const many = Array.from({ length: 9 }, (_, i) => item(`f${i}`, absolute(`2027-05-0${i + 1}`)));
    expect(nextUpcomingItems(many, withZone)).toHaveLength(5);
    expect(nextUpcomingItems(many, withZone, 2).map((i) => i.id)).toEqual(["f0", "f1"]);
  });

  it("upcomingItems is every pending, non-overdue item in planning order", () => {
    expect(upcomingItems(items, withZone).map((i) => i.id)).toEqual(["today", "future", "undated"]);
  });
});

describe("planSections (Plan view)", () => {
  const items = [
    item("future", absolute("2027-04-01"), "pending", 1),
    item("done", absolute("2027-01-01"), "done", 2),
    item("overdue", absolute("2027-02-01"), "pending", 3),
    item("na", none, "not_applicable", 4),
    item("today", absolute(TODAY), "pending", 5),
  ];

  it("splits into Atrasados, then upcoming, then done / no aplica; every item exactly once", () => {
    const sections = planSections(items, withZone);
    expect(sections.overdue.map((i) => i.id)).toEqual(["overdue"]);
    expect(sections.upcoming.map((i) => i.id)).toEqual(["today", "future"]);
    expect(sections.resolved.map((i) => i.id)).toEqual(["done", "na"]);
    const all = [...sections.overdue, ...sections.upcoming, ...sections.resolved].map((i) => i.id);
    expect(all.sort()).toEqual(items.map((i) => i.id).sort());
  });

  it("without a time zone there is no Atrasados section", () => {
    const sections = planSections(items, noZone);
    expect(sections.overdue).toEqual([]);
    expect(sections.upcoming.map((i) => i.id)).toEqual(["overdue", "today", "future"]);
  });

  it("never reorders or mutates the input (sort_order is not rewritten)", () => {
    const before = structuredClone(items);
    planSections(items, withZone);
    overdueItems(items, withZone);
    nextUpcomingItems(items, withZone);
    expect(items).toEqual(before);
  });
});

describe("progress is unaffected by overdue", () => {
  it("done / (pending + done), not_applicable excluded, overdue irrelevant", () => {
    const items = [
      item("overdue", absolute("2026-01-01")),
      item("pending", absolute("2028-01-01")),
      item("done", absolute("2026-01-01"), "done"),
      item("na", absolute("2026-01-01"), "not_applicable"),
    ];
    expect(overdueItems(items, withZone)).toHaveLength(1);
    expect(summarizeProgress(items)).toEqual({
      done: 1,
      pending: 2,
      notApplicable: 1,
      applicable: 3,
      percent: 33,
    });
  });
});
