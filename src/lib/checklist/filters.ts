import { effectiveDueDate } from "@/lib/checklist/timing";
import { isChecklistStatus, type ChecklistItem, type ChecklistStatus } from "@/lib/checklist/types";

/**
 * List views. The status filter lives in the URL (`?status=pending`) so it's
 * shareable and back-button friendly. It's presentation only: it never
 * affects what the user may see — RLS already decided that.
 */

export type StatusFilter = "all" | ChecklistStatus;

export const STATUS_FILTERS: readonly StatusFilter[] = ["all", "pending", "done", "not_applicable"];

/** Any unknown, repeated or missing value falls back to "all". */
export function parseStatusFilter(value: string | string[] | undefined): StatusFilter {
  return typeof value === "string" && isChecklistStatus(value) ? value : "all";
}

export function filterItems<T extends { status: ChecklistStatus }>(
  items: readonly T[],
  filter: StatusFilter,
): T[] {
  return filter === "all" ? [...items] : items.filter((item) => item.status === filter);
}

/** Link target for a filter; "all" is the bare page. */
export function statusFilterHref(basePath: string, filter: StatusFilter): string {
  return filter === "all" ? basePath : `${basePath}?status=${filter}`;
}

/**
 * "What's next": pending items that have a known due date, soonest first
 * (ties keep the list's order). Doesn't need "today", so it's unaffected by
 * time zones; it never reorders the stored list.
 */
export function nextUpItems(
  items: readonly ChecklistItem[],
  weddingDate: string | null,
  limit = 3,
): Array<{ item: ChecklistItem; dueDate: string }> {
  return items
    .flatMap((item) => {
      if (item.status !== "pending") return [];
      const dueDate = effectiveDueDate(item.timing, weddingDate);
      return dueDate ? [{ item, dueDate }] : [];
    })
    .sort((a, b) =>
      a.dueDate === b.dueDate
        ? a.item.sortOrder - b.item.sortOrder
        : a.dueDate < b.dueDate
          ? -1
          : 1,
    )
    .slice(0, limit);
}
