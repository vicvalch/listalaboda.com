import type { StatusFilter } from "@/lib/checklist/filters";

/**
 * Checklist views, kept in the URL (`?view=plan&status=pending`) so they are
 * shareable and back-button friendly. Like the status filter they are
 * presentation only: authorization never depends on them.
 *
 *   list     — persisted order (the wedding's own order)
 *   plan     — planning order (derived from timing)
 *   category — grouped by category, persisted order inside each group
 */

export type ChecklistView = "list" | "plan" | "category";

export const CHECKLIST_VIEWS: readonly ChecklistView[] = ["list", "plan", "category"];

export const DEFAULT_VIEW: ChecklistView = "list";

/** Any unknown, repeated or missing value falls back to the list view. */
export function parseChecklistView(value: string | string[] | undefined): ChecklistView {
  return typeof value === "string" && (CHECKLIST_VIEWS as readonly string[]).includes(value)
    ? (value as ChecklistView)
    : DEFAULT_VIEW;
}

export type ChecklistViewState = Readonly<{ view: ChecklistView; status: StatusFilter }>;

/**
 * Link target for a view + status combination. Defaults are left out, so
 * the plain list is the bare page and only valid values ever reach the URL.
 */
export function checklistHref(basePath: string, { view, status }: ChecklistViewState): string {
  const params = new URLSearchParams();
  if (view !== DEFAULT_VIEW) params.set("view", view);
  if (status !== "all") params.set("status", status);
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}
