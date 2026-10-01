import { effectiveDueDate } from "@/lib/checklist/timing";
import type { ChecklistStatus, ChecklistTiming } from "@/lib/checklist/types";
import { formatNumber, interpolate } from "@/lib/i18n";
import { es } from "@/lib/i18n/messages/es";
import { formatWeddingDate } from "@/lib/weddings/format";

/** Spanish descriptions of statuses and timing. No enum names reach the UI. */

/** "30 días antes de la boda", "El día de la boda", "1 día después de la boda". */
export function describeRelativeDays(relativeDays: number): string {
  const copy = es.checklist.timing;
  if (relativeDays === 0) return copy.weddingDay;
  const days = Math.abs(relativeDays);
  if (relativeDays < 0) {
    return days === 1 ? copy.dayBefore : interpolate(copy.daysBefore, { days: formatNumber(days) });
  }
  return days === 1 ? copy.dayAfter : interpolate(copy.daysAfter, { days: formatNumber(days) });
}

export type TimingDescription = Readonly<{
  /** Formatted calendar date, when known. */
  date: string | null;
  /** Relative rule, for relative items. */
  relative: string | null;
  /** A relative item whose exact date waits for the wedding date. */
  datePending: boolean;
}>;

/** How an item's timing is shown; null when the item has no date at all. */
export function describeTiming(
  timing: ChecklistTiming,
  weddingDate: string | null,
): TimingDescription | null {
  if (timing.mode === "none") return null;
  const due = effectiveDueDate(timing, weddingDate);
  return {
    date: due ? formatWeddingDate(due) : null,
    relative: timing.mode === "relative_to_wedding" ? describeRelativeDays(timing.relativeDays) : null,
    datePending: timing.mode === "relative_to_wedding" && due === null,
  };
}

/**
 * One line for an item's timing, or null when it has no date:
 *   "15 de julio de 2027 · 30 días antes de la boda"
 *   "30 días antes de la boda · Se calculará cuando definas la fecha de la boda."
 *   "15 de marzo de 2027"
 */
export function timingLine(timing: ChecklistTiming, weddingDate: string | null): string | null {
  const description = describeTiming(timing, weddingDate);
  if (!description) return null;
  const parts = [
    description.date,
    description.relative,
    description.datePending ? es.checklist.timing.pendingDate : null,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}

export type StatusAction =Readonly<{ target: ChecklistStatus; label: string }>;

export type StatusControls = Readonly<{
  /** The done checkbox: pending ⇄ done. Absent for not_applicable items. */
  toggle: StatusAction | null;
  /** Other direct actions shown as buttons. */
  secondary: readonly StatusAction[];
}>;

/**
 * The direct status actions offered for an item:
 *   pending        → done (checkbox), not_applicable
 *   done           → pending (checkbox)
 *   not_applicable → pending
 * The database accepts any status change; the UI keeps to these paths.
 */
export function statusControls(status: ChecklistStatus): StatusControls {
  const copy = es.checklist.actions;
  switch (status) {
    case "pending":
      return {
        toggle: { target: "done", label: copy.markDone },
        secondary: [{ target: "not_applicable", label: copy.markNotApplicable }],
      };
    case "done":
      return { toggle: { target: "pending", label: copy.reopen }, secondary: [] };
    case "not_applicable":
      return { toggle: null, secondary: [{ target: "pending", label: copy.reopen }] };
  }
}
