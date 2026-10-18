import { NEXT_ITEMS_LIMIT, sortByPlanning } from "@/lib/checklist/planning";
import { addDaysToIsoDate, effectiveDueDate } from "@/lib/checklist/timing";
import type { ChecklistItem } from "@/lib/checklist/types";
import { weddingLocalToday } from "@/lib/weddings/timezone";

/**
 * "Atrasado": derived on read, never stored, never a status. Pure functions
 * only: the caller reads the clock once per request and passes the
 * wedding-local `today` in.
 *
 * An item is overdue iff ALL hold:
 *   1. status is `pending`;
 *   2. it has an overdue reference date (`overdueReferenceDate`);
 *   3. the wedding has a time zone, so `today` is known;
 *   4. reference date < today (strictly: due today is NOT overdue).
 *
 * Dates are `YYYY-MM-DD`, so string comparison is calendar comparison.
 */

export type PlanningDateContext = Readonly<{
  weddingDate: string | null;
  /** The wedding-local calendar date, or null when the wedding has no time zone. */
  today: string | null;
  /** The wedding's IANA time zone (the one `today` came from), or null. */
  timeZone: string | null;
}>;

/**
 * Batch 2b: calendar days an INHERITED past-offset template item gets to be
 * caught up before it counts as overdue. A launch-phase catch-up grace, not a
 * re-baselining of the template's schedule.
 */
export const INHERITED_ITEM_GRACE_DAYS = 14;

/**
 * The date an item's overdue classification is measured against: its
 * effective due date, except for a template-seeded relative item whose date
 * was ALREADY PAST on the wedding-local day it was seeded (Batch 2/2b): that
 * one is measured against seed day + `INHERITED_ITEM_GRACE_DAYS`. A wedding
 * created four months out must not start with every "a year before" item
 * already late; those items are not overdue from the seed day through seed
 * day + 14 inclusive, and become overdue the day after if still pending.
 * Template items not yet past on the seed day (including due that very day)
 * keep their own date. Never stored; the template's offset and the displayed
 * due date are unchanged. Absolute dates (always explicit) and custom items
 * (`seededAt` null) keep their plain due date.
 */
export function overdueReferenceDate(
  item: Pick<ChecklistItem, "timing" | "seededAt">,
  { weddingDate, timeZone }: Pick<PlanningDateContext, "weddingDate" | "timeZone">,
): string | null {
  const due = effectiveDueDate(item.timing, weddingDate);
  if (due === null || item.seededAt === null || item.timing.mode !== "relative_to_wedding" || timeZone === null) {
    return due;
  }
  const seededOn = weddingLocalToday(timeZone, new Date(item.seededAt));
  if (seededOn === null || due >= seededOn) return due;
  return addDaysToIsoDate(seededOn, INHERITED_ITEM_GRACE_DAYS) ?? due;
}

export function isOverdue(item: Pick<ChecklistItem, "status" | "timing" | "seededAt">, context: PlanningDateContext): boolean {
  if (item.status !== "pending" || context.today === null) return false;
  const reference = overdueReferenceDate(item, context);
  return reference !== null && reference < context.today;
}

/** Overdue items in planning order (earliest effective date first). */
export function overdueItems<T extends ChecklistItem>(
  items: readonly T[],
  context: PlanningDateContext,
): T[] {
  return sortByPlanning(
    items.filter((item) => isOverdue(item, context)),
    context.weddingDate,
  );
}

/**
 * Pending items that are not overdue, in planning order. Without a time
 * zone nothing is overdue, so this is every pending item.
 */
export function upcomingItems<T extends ChecklistItem>(
  items: readonly T[],
  context: PlanningDateContext,
): T[] {
  return sortByPlanning(
    items.filter((item) => item.status === "pending" && !isOverdue(item, context)),
    context.weddingDate,
  );
}

/**
 * "Lo próximo": the first upcoming items. Overdue items are shown in
 * "Atrasados" instead, so no item appears in both.
 */
export function nextUpcomingItems(
  items: readonly ChecklistItem[],
  context: PlanningDateContext,
  limit = NEXT_ITEMS_LIMIT,
): ChecklistItem[] {
  return upcomingItems(items, context).slice(0, limit);
}

export type PlanSections<T extends ChecklistItem> = Readonly<{
  /** Pending and overdue, earliest first. Empty without a time zone. */
  overdue: T[];
  /** Pending and not overdue, in planning order. */
  upcoming: T[];
  /** Done and not applicable, in the input's order. */
  resolved: T[];
}>;

/** The Plan view's three sections. Every input item lands in exactly one. */
export function planSections<T extends ChecklistItem>(
  items: readonly T[],
  context: PlanningDateContext,
): PlanSections<T> {
  return {
    overdue: overdueItems(items, context),
    upcoming: upcomingItems(items, context),
    resolved: items.filter((item) => item.status !== "pending"),
  };
}
