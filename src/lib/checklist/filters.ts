import { isChecklistStatus, type ChecklistStatus } from "@/lib/checklist/types";

/**
 * Status filter. It lives in the URL (`?status=pending`) so it's
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
