import { describe, expect, it } from "vitest";

import {
  isOverdue,
  nextUpcomingItems,
  INHERITED_ITEM_GRACE_DAYS,
  overdueReferenceDate,
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
    seededAt: null,
  };
}

const absolute = (dueDate: string) => ({ mode: "absolute", dueDate }) as const;
const relative = (relativeDays: number) => ({ mode: "relative_to_wedding", relativeDays }) as const;
const none = { mode: "none" } as const;

const TODAY = "2027-03-10";
const withZone: PlanningDateContext = { weddingDate: "2027-08-14", today: TODAY, timeZone: "America/Costa_Rica" };
const noZone: PlanningDateContext = { weddingDate: "2027-08-14", today: null, timeZone: null };

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
    expect(isOverdue(value, { weddingDate: null, today: TODAY, timeZone: "America/Costa_Rica" })).toBe(false);
    expect(value.timing).toEqual(relative(-400));
  });

  it("an absolute date can be overdue even without a wedding date", () => {
    expect(isOverdue(item("a", absolute("2027-01-01")), { weddingDate: null, today: TODAY, timeZone: "America/Costa_Rica" })).toBe(true);
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
    expect(isOverdue(value, { weddingDate: null, today: cr, timeZone: "America/Costa_Rica" })).toBe(false);
    expect(isOverdue(value, { weddingDate: null, today: madrid, timeZone: "Europe/Madrid" })).toBe(true);
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

// Batch 2/2b: a template-seeded relative item whose date was already past on
// the wedding-local seed day gets a 14-day catch-up grace (launch-phase policy,
// not a re-baselined schedule). Wedding 119 days after a seed on 2026-10-17
// (Costa Rica); no effective or grace date is ever stored.
describe("inherited-item catch-up grace for template items", () => {
  const SEED_DAY = "2026-10-17";
  const SEEDED_AT = "2026-10-17T15:00:00Z"; // 09:00 in Costa Rica
  const WEDDING = "2027-02-13"; // 119 days after the seed day
  const on = (today: string): PlanningDateContext => ({ weddingDate: WEDDING, today, timeZone: "America/Costa_Rica" });
  const seeded = (timing: ChecklistTiming, status: ChecklistStatus = "pending", seededAt = SEEDED_AT): ChecklistItem => ({
    ...item("t", timing, status),
    seededAt,
  });

  it("the grace is 14 calendar days", () => {
    expect(INHERITED_ITEM_GRACE_DAYS).toBe(14);
  });

  it("an inherited past-due item: not overdue on the seed day, day 7 or day 14; overdue on day 15", () => {
    const value = seeded(relative(-180)); // raw 2026-08-17, 61 days before the seed
    expect(overdueReferenceDate(value, on(SEED_DAY))).toBe("2026-10-31"); // seed day + 14
    expect(isOverdue(value, on(SEED_DAY))).toBe(false); // seed day
    expect(isOverdue(value, on("2026-10-24"))).toBe(false); // day 7
    expect(isOverdue(value, on("2026-10-31"))).toBe(false); // day 14
    expect(isOverdue(value, on("2026-11-01"))).toBe(true); // day 15
  });

  it("raw date exactly on the seed day: not inherited-past, so its real date and no grace", () => {
    const value = seeded(relative(-119)); // raw 2026-10-17
    expect(overdueReferenceDate(value, on(SEED_DAY))).toBe(SEED_DAY);
    expect(isOverdue(value, on(SEED_DAY))).toBe(false); // due today
    expect(isOverdue(value, on("2026-10-18"))).toBe(true);
  });

  it("raw date one day after the seed: its own date, overdue from the day after it", () => {
    const value = seeded(relative(-118)); // raw 2026-10-18
    expect(overdueReferenceDate(value, on(SEED_DAY))).toBe("2026-10-18");
    expect(isOverdue(value, on("2026-10-18"))).toBe(false);
    expect(isOverdue(value, on("2026-10-19"))).toBe(true);
  });

  it("a future template item keeps its own date, exactly as before", () => {
    const value = seeded(relative(-90)); // raw 2026-11-15
    expect(overdueReferenceDate(value, on(SEED_DAY))).toBe("2026-11-15");
    expect(isOverdue(value, on("2026-11-15"))).toBe(false);
    expect(isOverdue(value, on("2026-11-16"))).toBe(true);
  });

  it("a completed or not-applicable item is never overdue", () => {
    for (const status of ["done", "not_applicable"] as const) {
      expect(isOverdue(seeded(relative(-180), status), on("2027-01-01"))).toBe(false);
    }
  });

  it("an item someone added keeps the plain rule: an explicit past date is overdue right away", () => {
    const custom = (timing: ChecklistTiming): ChecklistItem => item("c", timing); // seededAt null
    expect(isOverdue(custom(relative(-180)), on(SEED_DAY))).toBe(true);
    expect(isOverdue(custom(absolute("2026-09-01")), on(SEED_DAY))).toBe(true);
  });

  it("a template item changed to an explicit absolute date keeps that date (no grace)", () => {
    const value = seeded(absolute("2026-09-01"));
    expect(overdueReferenceDate(value, on(SEED_DAY))).toBe("2026-09-01");
    expect(isOverdue(value, on(SEED_DAY))).toBe(true);
  });

  it("seed day and the 14 days are WEDDING-LOCAL calendar dates, never UTC", () => {
    // 2026-10-18T03:30Z is 21:30 on 2026-10-17 in Costa Rica: seed day 17 → grace through the 31st.
    const lateEvening = seeded(relative(-180), "pending", "2026-10-18T03:30:00Z");
    expect(overdueReferenceDate(lateEvening, on(SEED_DAY))).toBe("2026-10-31");
    expect(isOverdue(lateEvening, on("2026-10-31"))).toBe(false);
    expect(isOverdue(lateEvening, on("2026-11-01"))).toBe(true); // UTC slicing would wrongly say false
    // The same instant in Madrid is already the 18th: grace through November 1st.
    const madrid = (today: string): PlanningDateContext => ({ weddingDate: WEDDING, today, timeZone: "Europe/Madrid" });
    expect(overdueReferenceDate(lateEvening, madrid("2026-11-01"))).toBe("2026-11-01");
    expect(isOverdue(lateEvening, madrid("2026-11-01"))).toBe(false);
    expect(isOverdue(lateEvening, madrid("2026-11-02"))).toBe(true);
  });

  it("no time zone: nothing is overdue, as before; no wedding date: no relative due date", () => {
    expect(isOverdue(seeded(relative(-180)), { weddingDate: WEDDING, today: null, timeZone: null })).toBe(false);
    expect(overdueReferenceDate(seeded(relative(-180)), { weddingDate: null, timeZone: "America/Costa_Rica" })).toBeNull();
  });

  it("never changes the item: the stored rule and the shown date stay the template's", () => {
    const value = seeded(relative(-180));
    const copy = structuredClone(value);
    isOverdue(value, on(SEED_DAY));
    expect(value).toEqual(copy);
  });

  it("the wedding home's lists use the same helper: inherited items sit in 'upcoming', not 'Atrasados', during the grace", () => {
    const inherited = { ...seeded(relative(-180)), id: "inherited" };
    const custom = item("custom", absolute("2026-09-01"));
    const sections = planSections([inherited, custom], on("2026-10-24"));
    expect(sections.overdue.map((i) => i.id)).toEqual(["custom"]);
    expect(sections.upcoming.map((i) => i.id)).toEqual(["inherited"]);
    expect(overdueItems([inherited, custom], on("2026-11-01")).map((i) => i.id).sort()).toEqual(["custom", "inherited"]);
  });
});
