import type { ChecklistTiming } from "@/lib/checklist/types";

/**
 * Due-date semantics. Dates are Postgres `date` values (`YYYY-MM-DD`):
 * calendar dates with no time zone. All arithmetic is done on UTC midnight,
 * so no local offset or DST change can shift a date by a day.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Largest relative offset, in days, either side of the wedding (DB-enforced too). */
export const MAX_RELATIVE_DAYS = 1000;

/** Adds whole days to a calendar date. Returns null for a malformed date. */
export function addDaysToIsoDate(isoDate: string, days: number): string | null {
  const match = ISO_DATE.exec(isoDate);
  if (!match || !Number.isInteger(days)) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const time = Date.UTC(year, month - 1, day) + days * DAY_MS;
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * The calendar date an item is due, or null when it has none or it can't be
 * known yet (a relative item while the wedding has no date).
 *
 * Relative items follow the wedding date; absolute items never move.
 */
export function effectiveDueDate(
  timing: ChecklistTiming,
  weddingDate: string | null,
): string | null {
  switch (timing.mode) {
    case "none":
      return null;
    case "absolute":
      return timing.dueDate;
    case "relative_to_wedding":
      return weddingDate ? addDaysToIsoDate(weddingDate, timing.relativeDays) : null;
  }
}

/** How the "relative to the wedding" form fields express an offset. */
export type RelativeDirection = "before" | "after" | "on";

export type RelativeInput = Readonly<{ direction: RelativeDirection; days: number }>;

/** Form fields → stored offset: 30 "before" → -30, 7 "after" → 7, "on" → 0. */
export function relativeDaysFromInput({ direction, days }: RelativeInput): number {
  if (direction === "on") return 0;
  return direction === "before" ? -days : days;
}

/** Stored offset → form fields (the inverse of `relativeDaysFromInput`). */
export function relativeInputFromDays(relativeDays: number): RelativeInput {
  if (relativeDays === 0) return { direction: "on", days: 0 };
  return relativeDays < 0
    ? { direction: "before", days: -relativeDays }
    : { direction: "after", days: relativeDays };
}

/** Builds the domain timing from database columns; null if they're inconsistent. */
export function timingFromColumns(row: {
  timing_mode: ChecklistTiming["mode"];
  relative_days: number | null;
  due_date: string | null;
}): ChecklistTiming | null {
  switch (row.timing_mode) {
    case "none":
      return { mode: "none" };
    case "absolute":
      return row.due_date ? { mode: "absolute", dueDate: row.due_date } : null;
    case "relative_to_wedding":
      return row.relative_days === null
        ? null
        : { mode: "relative_to_wedding", relativeDays: row.relative_days };
  }
}

/** The database columns for a timing (the CHECK constraint's exact shape). */
export function timingToColumns(timing: ChecklistTiming) {
  return {
    timing_mode: timing.mode,
    relative_days: timing.mode === "relative_to_wedding" ? timing.relativeDays : null,
    due_date: timing.mode === "absolute" ? timing.dueDate : null,
  };
}
