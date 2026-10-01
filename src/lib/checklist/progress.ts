import type { ChecklistStatus } from "@/lib/checklist/types";

/**
 * Checklist progress.
 *
 *   applicable = pending + done      (not_applicable is excluded entirely)
 *   percent    = floor(done / applicable * 100)
 *
 * `not_applicable` neither counts as done nor as left to do: it simply
 * doesn't apply to this wedding. With nothing applicable the percentage is 0
 * (an empty list hasn't been "completed"). Rounding down means 100% only
 * ever shows when everything applicable is done.
 */
export type ChecklistProgress = Readonly<{
  done: number;
  pending: number;
  notApplicable: number;
  applicable: number;
  percent: number;
}>;

export function summarizeProgress(
  items: ReadonlyArray<{ status: ChecklistStatus }>,
): ChecklistProgress {
  let done = 0;
  let pending = 0;
  let notApplicable = 0;
  for (const { status } of items) {
    if (status === "done") done += 1;
    else if (status === "pending") pending += 1;
    else notApplicable += 1;
  }
  const applicable = done + pending;
  const percent = applicable === 0 ? 0 : Math.floor((done / applicable) * 100);
  return { done, pending, notApplicable, applicable, percent };
}
