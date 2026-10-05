import { describe, expect, it } from "vitest";

import { filterItems, parseStatusFilter } from "@/lib/checklist/filters";
import {
  describeRelativeDays,
  describeTiming,
  shortTimingLabel,
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

  it("says the wedding day without a number of days", () => {
    expect(timingLine({ mode: "relative_to_wedding", relativeDays: 0 }, "2027-08-14")).toBe(
      "14 de agosto de 2027 · El día de la boda",
    );
    expect(timingLine({ mode: "relative_to_wedding", relativeDays: 0 }, null)).toBe(
      `El día de la boda · ${es.checklist.timing.pendingDate}`,
    );
  });

  it("never shows a signed offset or a plural for one day", () => {
    for (const days of [-1000, -30, -2, -1, 0, 1, 2, 30]) {
      const text = describeRelativeDays(days);
      expect(text).not.toMatch(/-\d|1 días/);
    }
  });

  it("dates after the wedding and across month and leap-day boundaries", () => {
    const after = { mode: "relative_to_wedding", relativeDays: 7 } as const;
    expect(timingLine(after, "2027-12-28")).toBe("4 de enero de 2028 · 7 días después de la boda");
    const before = { mode: "relative_to_wedding", relativeDays: -1 } as const;
    expect(timingLine(before, "2028-03-01")).toBe("29 de febrero de 2028 · 1 día antes de la boda");
  });
});

describe("shortTimingLabel", () => {
  it("prefers the calendar date, then the rule, then 'Sin fecha'", () => {
    const relative = { mode: "relative_to_wedding", relativeDays: -30 } as const;
    expect(shortTimingLabel(relative, "2027-08-14")).toBe("15 de julio de 2027");
    expect(shortTimingLabel(relative, null)).toBe("30 días antes de la boda");
    expect(shortTimingLabel({ mode: "absolute", dueDate: "2027-03-15" }, null)).toBe(
      "15 de marzo de 2027",
    );
    expect(shortTimingLabel({ mode: "none" }, "2027-08-14")).toBe(es.checklist.timing.none);
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
