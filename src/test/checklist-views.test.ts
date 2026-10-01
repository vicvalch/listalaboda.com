import { describe, expect, it } from "vitest";

import {
  filterItems,
  nextUpItems,
  parseStatusFilter,
  statusFilterHref,
} from "@/lib/checklist/filters";
import {
  describeRelativeDays,
  describeTiming,
  statusControls,
  timingLine,
} from "@/lib/checklist/presentation";
import { summarizeProgress } from "@/lib/checklist/progress";
import type { ChecklistItem, ChecklistStatus, ChecklistTiming } from "@/lib/checklist/types";
import { interpolate } from "@/lib/i18n";
import { es } from "@/lib/i18n/messages/es";

function item(
  id: string,
  status: ChecklistStatus,
  timing: ChecklistTiming = { mode: "none" },
  sortOrder = 10,
): ChecklistItem {
  return { id, title: id, description: null, category: null, status, timing, sortOrder };
}

const statuses = (...list: ChecklistStatus[]) => list.map((status) => ({ status }));

describe("summarizeProgress", () => {
  it("counts done over pending + done", () => {
    expect(summarizeProgress(statuses("done", "pending", "pending", "done"))).toEqual({
      done: 2,
      pending: 2,
      notApplicable: 0,
      applicable: 4,
      percent: 50,
    });
  });

  it("excludes not_applicable from the denominator", () => {
    const progress = summarizeProgress(statuses("done", "pending", "not_applicable", "not_applicable"));
    expect(progress).toMatchObject({ done: 1, applicable: 2, notApplicable: 2, percent: 50 });
  });

  it("marking an item not applicable raises the percentage", () => {
    const before = summarizeProgress(statuses("done", "pending", "pending"));
    const after = summarizeProgress(statuses("done", "pending", "not_applicable"));
    expect(before.percent).toBe(33);
    expect(after.percent).toBe(50);
  });

  it("is 0% with nothing applicable", () => {
    expect(summarizeProgress([]).percent).toBe(0);
    expect(summarizeProgress(statuses("not_applicable")).percent).toBe(0);
  });

  it("only shows 100% when everything applicable is done", () => {
    const almost = statuses(...Array<ChecklistStatus>(199).fill("done"), "pending");
    expect(summarizeProgress(almost).percent).toBe(99);
    expect(summarizeProgress(statuses("done", "not_applicable")).percent).toBe(100);
  });
});

describe("status filter", () => {
  it.each(["pending", "done", "not_applicable"] as const)("accepts %s", (value) => {
    expect(parseStatusFilter(value)).toBe(value);
  });

  it.each([undefined, "", "all", "DONE", "in_progress", ["done", "pending"]])(
    "falls back to all for %o",
    (value) => {
      expect(parseStatusFilter(value)).toBe("all");
    },
  );

  it("filters by status and keeps order", () => {
    const items = [item("a", "pending"), item("b", "done"), item("c", "pending")];
    expect(filterItems(items, "pending").map((i) => i.id)).toEqual(["a", "c"]);
    expect(filterItems(items, "all").map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(filterItems(items, "not_applicable")).toEqual([]);
  });

  it("builds shareable links", () => {
    expect(statusFilterHref("/app/weddings/x", "all")).toBe("/app/weddings/x");
    expect(statusFilterHref("/app/weddings/x", "done")).toBe("/app/weddings/x?status=done");
  });
});

describe("nextUpItems", () => {
  const relative = (days: number) => ({ mode: "relative_to_wedding", relativeDays: days }) as const;

  it("lists pending dated items soonest first, without reordering the list", () => {
    const items = [
      item("late", "pending", relative(-10), 10),
      item("undated", "pending", { mode: "none" }, 20),
      item("early", "pending", relative(-300), 30),
      item("finished", "done", relative(-400), 40),
      item("skip", "not_applicable", relative(-500), 50),
      item("fixed", "pending", { mode: "absolute", dueDate: "2027-01-01" }, 60),
    ];
    const next = nextUpItems(items, "2027-08-14");
    expect(next.map((n) => [n.item.id, n.dueDate])).toEqual([
      ["early", "2026-10-18"],
      ["fixed", "2027-01-01"],
      ["late", "2027-08-04"],
    ]);
    expect(items[0].id).toBe("late");
  });

  it("breaks date ties by list order and respects the limit", () => {
    const items = [item("b", "pending", relative(-30), 20), item("a", "pending", relative(-30), 10)];
    expect(nextUpItems(items, "2027-08-14").map((n) => n.item.id)).toEqual(["a", "b"]);
    expect(nextUpItems(items, "2027-08-14", 1)).toHaveLength(1);
  });

  it("skips relative items while the wedding has no date", () => {
    expect(nextUpItems([item("r", "pending", relative(-30))], null)).toEqual([]);
  });
});

describe("timing presentation", () => {
  it.each([
    [-30, "30 días antes de la boda"],
    [-1, "1 día antes de la boda"],
    [0, "El día de la boda"],
    [1, "1 día después de la boda"],
    [7, "7 días después de la boda"],
    [-1000, "1000 días antes de la boda"], // es: no separator below 10 000
  ])("%d → %s", (days, expected) => {
    expect(describeRelativeDays(days)).toBe(expected);
  });

  it("shows the calendar date and the rule for a dated wedding", () => {
    const timing = { mode: "relative_to_wedding", relativeDays: -30 } as const;
    expect(describeTiming(timing, "2027-08-14")).toEqual({
      date: "15 de julio de 2027",
      relative: "30 días antes de la boda",
      datePending: false,
    });
    expect(timingLine(timing, "2027-08-14")).toBe("15 de julio de 2027 · 30 días antes de la boda");
  });

  it("keeps the rule and says the date is pending without a wedding date", () => {
    const timing = { mode: "relative_to_wedding", relativeDays: -30 } as const;
    expect(timingLine(timing, null)).toBe(
      `30 días antes de la boda · ${es.checklist.timing.pendingDate}`,
    );
  });

  it("shows absolute dates alone and nothing for undated items", () => {
    expect(timingLine({ mode: "absolute", dueDate: "2027-03-15" }, "2027-08-14")).toBe(
      "15 de marzo de 2027",
    );
    expect(timingLine({ mode: "none" }, "2027-08-14")).toBeNull();
  });
});

describe("statusControls", () => {
  it("offers done and not-applicable for pending items", () => {
    const controls = statusControls("pending");
    expect(controls.toggle?.target).toBe("done");
    expect(controls.secondary.map((a) => a.target)).toEqual(["not_applicable"]);
  });

  it("reopens done items through the checkbox", () => {
    expect(statusControls("done")).toEqual({
      toggle: { target: "pending", label: es.checklist.actions.reopen },
      secondary: [],
    });
  });

  it("reopens not-applicable items with a button (no checkbox)", () => {
    expect(statusControls("not_applicable")).toEqual({
      toggle: null,
      secondary: [{ target: "pending", label: es.checklist.actions.reopen }],
    });
  });

  it("never shows enum names", () => {
    for (const status of ["pending", "done", "not_applicable"] as const) {
      const { toggle, secondary } = statusControls(status);
      for (const action of [toggle, ...secondary]) {
        if (action) expect(action.label).not.toMatch(/_|pending|done/);
      }
      expect(es.checklist.status[status]).not.toMatch(/_/);
    }
  });
});

describe("interpolate", () => {
  it("fills placeholders and leaves unknown ones visible", () => {
    expect(interpolate("{done} de {total} completados", { done: "3", total: "10" })).toBe(
      "3 de 10 completados",
    );
    expect(interpolate("{a} y {b}", { a: "x" })).toBe("x y {b}");
  });
});
