import { describe, expect, it } from "vitest";

import {
  addDaysToIsoDate,
  effectiveDueDate,
  relativeDaysFromInput,
  relativeInputFromDays,
  timingFromColumns,
  timingToColumns,
} from "@/lib/checklist/timing";

describe("addDaysToIsoDate", () => {
  it.each([
    ["2027-08-14", -30, "2027-07-15"],
    ["2027-08-14", 0, "2027-08-14"],
    ["2027-08-14", 7, "2027-08-21"],
    ["2027-03-01", -1, "2027-02-28"],
    ["2028-03-01", -1, "2028-02-29"], // leap year
    ["2027-01-15", -365, "2026-01-15"],
    ["2026-12-31", 1, "2027-01-01"],
    // Across DST changes in many zones (no local time involved).
    ["2027-03-28", 1, "2027-03-29"],
    ["2027-11-07", -1, "2027-11-06"],
  ])("%s %+d days = %s", (date, days, expected) => {
    expect(addDaysToIsoDate(date, days)).toBe(expected);
  });

  it("rejects malformed input", () => {
    expect(addDaysToIsoDate("14/08/2027", 1)).toBeNull();
    expect(addDaysToIsoDate("2027-08-14", 1.5)).toBeNull();
  });
});

describe("effectiveDueDate", () => {
  it("is the wedding date plus the offset for relative items", () => {
    const timing = { mode: "relative_to_wedding", relativeDays: -30 } as const;
    expect(effectiveDueDate(timing, "2027-08-14")).toBe("2027-07-15");
  });

  it("moves with the wedding date", () => {
    const timing = { mode: "relative_to_wedding", relativeDays: -30 } as const;
    expect(effectiveDueDate(timing, "2027-09-01")).toBe("2027-08-02");
  });

  it("is unknown for relative items while the wedding has no date", () => {
    expect(effectiveDueDate({ mode: "relative_to_wedding", relativeDays: -30 }, null)).toBeNull();
  });

  it("never moves for absolute items", () => {
    const timing = { mode: "absolute", dueDate: "2027-03-15" } as const;
    expect(effectiveDueDate(timing, "2027-08-14")).toBe("2027-03-15");
    expect(effectiveDueDate(timing, "2028-01-01")).toBe("2027-03-15");
    expect(effectiveDueDate(timing, null)).toBe("2027-03-15");
  });

  it("is null for items without a date", () => {
    expect(effectiveDueDate({ mode: "none" }, "2027-08-14")).toBeNull();
  });
});

describe("relative direction conversion", () => {
  it.each([
    [{ direction: "before", days: 30 }, -30],
    [{ direction: "after", days: 7 }, 7],
    [{ direction: "on", days: 0 }, 0],
    [{ direction: "on", days: 12 }, 0],
  ] as const)("%o → %d", (input, expected) => {
    expect(relativeDaysFromInput(input)).toBe(expected);
  });

  it.each([
    [-270, { direction: "before", days: 270 }],
    [3, { direction: "after", days: 3 }],
    [0, { direction: "on", days: 0 }],
  ] as const)("%d → %o", (days, expected) => {
    expect(relativeInputFromDays(days)).toEqual(expected);
  });

  it("round-trips", () => {
    for (const days of [-1000, -1, 0, 1, 365]) {
      expect(relativeDaysFromInput(relativeInputFromDays(days))).toBe(days);
    }
  });
});

describe("timing columns", () => {
  it("maps each timing to the CHECK constraint's shape and back", () => {
    const cases = [
      { mode: "none" },
      { mode: "absolute", dueDate: "2027-03-15" },
      { mode: "relative_to_wedding", relativeDays: -30 },
    ] as const;
    for (const timing of cases) {
      expect(timingFromColumns(timingToColumns(timing))).toEqual(timing);
    }
    expect(timingToColumns({ mode: "relative_to_wedding", relativeDays: 0 })).toEqual({
      timing_mode: "relative_to_wedding",
      relative_days: 0,
      due_date: null,
    });
  });

  it("refuses inconsistent rows", () => {
    expect(
      timingFromColumns({ timing_mode: "absolute", relative_days: null, due_date: null }),
    ).toBeNull();
    expect(
      timingFromColumns({ timing_mode: "relative_to_wedding", relative_days: null, due_date: null }),
    ).toBeNull();
  });
});
