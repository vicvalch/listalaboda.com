import { summarizeProgress, type ChecklistProgress } from "@/lib/checklist/progress";
import { effectiveDueDate } from "@/lib/checklist/timing";
import { CHECKLIST_CATEGORIES, type ChecklistCategory, type ChecklistItem } from "@/lib/checklist/types";

/**
 * Derived planning views over a wedding's checklist. Pure functions only:
 * nothing here reads the database, writes `sort_order` or knows "today".
 *
 * Two orders exist and never replace each other:
 * - persisted order (`sortOrder`): what the wedding stored — template order
 *   plus custom items at the end. The checklist's "Lista" view.
 * - planning order: derived from timing, for "Plan" and "Lo próximo".
 */

/**
 * Where an item falls in planning order:
 *   0 — has a calendar date (absolute, or relative with a wedding date)
 *   1 — relative to a wedding that has no date yet
 *   2 — no timing at all
 */
export type PlanningBucket = 0 | 1 | 2;

export type PlanningKey = Readonly<{
  bucket: PlanningBucket;
  /** Effective due date (`YYYY-MM-DD`) in bucket 0. */
  dueDate: string | null;
  /** The relative rule in bucket 1 (more negative = earlier). */
  relativeDays: number | null;
}>;

export function planningKey(item: ChecklistItem, weddingDate: string | null): PlanningKey {
  const dueDate = effectiveDueDate(item.timing, weddingDate);
  if (dueDate) return { bucket: 0, dueDate, relativeDays: null };
  if (item.timing.mode === "relative_to_wedding") {
    return { bucket: 1, dueDate: null, relativeDays: item.timing.relativeDays };
  }
  return { bucket: 2, dueDate: null, relativeDays: null };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Planning order:
 *   1. items with a calendar date, earliest first;
 *   2. then items relative to a wedding without a date, earliest rule first;
 *   3. then items without timing;
 *   4. ties: persisted sort order, then id (always total and stable).
 */
export function comparePlanning(weddingDate: string | null) {
  return (a: ChecklistItem, b: ChecklistItem): number => {
    const ka = planningKey(a, weddingDate);
    const kb = planningKey(b, weddingDate);
    if (ka.bucket !== kb.bucket) return ka.bucket - kb.bucket;
    if (ka.dueDate !== null && kb.dueDate !== null && ka.dueDate !== kb.dueDate) {
      return compareStrings(ka.dueDate, kb.dueDate);
    }
    if (ka.relativeDays !== null && kb.relativeDays !== null && ka.relativeDays !== kb.relativeDays) {
      return ka.relativeDays - kb.relativeDays;
    }
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return compareStrings(a.id, b.id);
  };
}

/** A sorted copy in planning order; the input is never reordered. */
export function sortByPlanning<T extends ChecklistItem>(
  items: readonly T[],
  weddingDate: string | null,
): T[] {
  return [...items].sort(comparePlanning(weddingDate));
}

export const NEXT_ITEMS_LIMIT = 5;

/** "Lo próximo": the first pending items in planning order. */
export function nextItems(
  items: readonly ChecklistItem[],
  weddingDate: string | null,
  limit = NEXT_ITEMS_LIMIT,
): ChecklistItem[] {
  return sortByPlanning(
    items.filter((item) => item.status === "pending"),
    weddingDate,
  ).slice(0, limit);
}

// ------------------------------------------------------------ assignment

/**
 * "Mis pendientes": the items assigned to `membershipId` (the current
 * member's own membership, resolved on the server), in the input's order.
 * Status is left to the status filter.
 */
export function assignedTo<T extends ChecklistItem>(
  items: readonly T[],
  membershipId: string,
): T[] {
  return items.filter((item) => item.assigneeMembershipId === membershipId);
}

// ------------------------------------------------------------ categories

export type CategoryGroup = Readonly<{
  /** null: the "Sin categoría" group. */
  category: ChecklistCategory | null;
  /** In persisted order. */
  items: readonly ChecklistItem[];
  progress: ChecklistProgress;
}>;

/**
 * Groups items by category. Groups are ordered by their first item in
 * persisted order (so the template's planning sequence survives), with the
 * fixed category order as a tie-break and uncategorized items last. Items
 * keep persisted order inside each group.
 */
export function groupByCategory(items: readonly ChecklistItem[]): CategoryGroup[] {
  const persisted = [...items].sort(
    (a, b) => a.sortOrder - b.sortOrder || compareStrings(a.id, b.id),
  );
  const groups = new Map<ChecklistCategory | null, ChecklistItem[]>();
  for (const item of persisted) {
    const group = groups.get(item.category);
    if (group) group.push(item);
    else groups.set(item.category, [item]);
  }

  const categoryRank = (category: ChecklistCategory) => CHECKLIST_CATEGORIES.indexOf(category);
  return [...groups.entries()]
    .sort(([ca, ia], [cb, ib]) => {
      if (ca === null) return 1;
      if (cb === null) return -1;
      return ia[0].sortOrder - ib[0].sortOrder || categoryRank(ca) - categoryRank(cb);
    })
    .map(([category, groupItems]) => ({
      category,
      items: groupItems,
      progress: summarizeProgress(groupItems),
    }));
}
