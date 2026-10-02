import { describe, expect, it } from "vitest";

import { parseStatusFilter, STATUS_FILTERS } from "@/lib/checklist/filters";
import {
  CHECKLIST_VIEWS,
  checklistHref,
  parseChecklistView,
  type ChecklistView,
} from "@/lib/checklist/views";

const BASE = "/app/weddings/x";

describe("view parsing", () => {
  it.each(["list", "plan", "category"] as const)("accepts %s", (value) => {
    expect(parseChecklistView(value)).toBe(value);
  });

  it.each([undefined, "", "PLAN", "calendar", "plan ", ["plan", "list"]])(
    "falls back to list for %o",
    (value) => {
      expect(parseChecklistView(value)).toBe("list");
    },
  );
});

describe("status parsing alongside views", () => {
  it.each(["all", "pending", "done", "not_applicable"] as const)("accepts %s", (value) => {
    expect(parseStatusFilter(value)).toBe(value);
  });

  it("is independent of the view value", () => {
    expect(parseStatusFilter("plan")).toBe("all");
    expect(parseChecklistView("pending")).toBe("list");
  });
});

describe("checklistHref", () => {
  it("leaves defaults out", () => {
    expect(checklistHref(BASE, { view: "list", status: "all" })).toBe(BASE);
  });

  it("builds view and status combinations", () => {
    expect(checklistHref(BASE, { view: "plan", status: "all" })).toBe(`${BASE}?view=plan`);
    expect(checklistHref(BASE, { view: "list", status: "done" })).toBe(`${BASE}?status=done`);
    expect(checklistHref(BASE, { view: "plan", status: "pending" })).toBe(
      `${BASE}?view=plan&status=pending`,
    );
    expect(checklistHref(BASE, { view: "category", status: "not_applicable" })).toBe(
      `${BASE}?view=category&status=not_applicable`,
    );
  });

  it("switching the view keeps the status, and switching the status keeps the view", () => {
    const current = { view: "plan" as ChecklistView, status: "pending" as const };
    expect(checklistHref(BASE, { ...current, view: "category" })).toBe(
      `${BASE}?view=category&status=pending`,
    );
    expect(checklistHref(BASE, { ...current, status: "done" })).toBe(`${BASE}?view=plan&status=done`);
  });

  it("round-trips through the parsers for every combination", () => {
    for (const view of CHECKLIST_VIEWS) {
      for (const status of STATUS_FILTERS) {
        const url = new URL(checklistHref(BASE, { view, status }), "http://localhost");
        expect(url.pathname).toBe(BASE);
        expect(parseChecklistView(url.searchParams.get("view") ?? undefined)).toBe(view);
        expect(parseStatusFilter(url.searchParams.get("status") ?? undefined)).toBe(status);
      }
    }
  });
});
