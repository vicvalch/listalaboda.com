import { summarizeBudget, type BudgetSummary, type ScheduleItemFacts } from "@/lib/budget/summary";
import { isOverdue } from "@/lib/checklist/overdue";
import { summarizeProgress } from "@/lib/checklist/progress";
import { daysBetweenIsoDates, effectiveDueDate } from "@/lib/checklist/timing";
import { summarizeGuests } from "@/lib/guests/summary";
import { summarizeSeatingGuests } from "@/lib/seating/plan";
import { timelineOverview, type TimelineSlot } from "@/lib/timeline/summary";
import { summarizeVendors } from "@/lib/vendors/summary";
import type { WeddingSummary } from "@/lib/weddings/service";
import { weddingLocalToday } from "@/lib/weddings/timezone";

import {
  deriveWeddingAttention,
  sortAttention,
  type AttentionWeddingContext,
} from "@/lib/weddings/overview/attention";
import {
  OVERVIEW_DOMAINS,
  type BudgetFacts,
  type BudgetOverview,
  type ChecklistFacts,
  type ChecklistOverview,
  type DomainResult,
  type GuestsOverview,
  type OverviewDomain,
  type OverviewWeddingInput,
  type PartyFacts,
  type TimelineOverviewSummary,
  type VendorsOverview,
  type WeddingCountdown,
  type WeddingOverview,
  type WeddingsOverview,
} from "@/lib/weddings/overview/types";

/**
 * The multi-wedding overview's pure builder (LB-24B, ADR-018). No database,
 * React or clock: the caller reads the clock ONCE and passes `now`; each
 * wedding's local "today" comes from its own time zone (never the server's
 * or the browser's). Every number is an existing domain helper's result,
 * projected; no business rule is re-implemented here.
 */

const UNAVAILABLE = { status: "unavailable" } as const;

function map<T, U>(result: DomainResult<T>, project: (value: T) => U): DomainResult<U> {
  return result.status === "ok" ? { status: "ok", value: project(result.value) } : UNAVAILABLE;
}

/** The wedding-local calendar date, or null without a (known) time zone. */
export function overviewToday(wedding: Pick<WeddingSummary, "timeZone">, now: Date): string | null {
  return wedding.timeZone === null ? null : weddingLocalToday(wedding.timeZone, now);
}

export function weddingCountdown(weddingDate: string | null, today: string | null): WeddingCountdown {
  if (weddingDate === null) return { state: "undated" };
  if (today === null) return { state: "no_time_zone" };
  const days = daysBetweenIsoDates(today, weddingDate);
  if (days === null) return { state: "no_time_zone" };
  if (days === 0) return { state: "today" };
  return days > 0 ? { state: "before", days } : { state: "after", days: -days };
}

export function checklistOverview(
  items: readonly ChecklistFacts[],
  context: Readonly<{ weddingDate: string | null; today: string | null }>,
): ChecklistOverview {
  let oldestOverdueOn: string | null = null;
  let overdueCount = 0;
  for (const item of items) {
    if (!isOverdue(item, context)) continue;
    overdueCount += 1;
    const due = effectiveDueDate(item.timing, context.weddingDate);
    if (due !== null && (oldestOverdueOn === null || due < oldestOverdueOn)) oldestOverdueOn = due;
  }
  return { progress: summarizeProgress(items), overdueCount, oldestOverdueOn };
}

export function guestsOverview(parties: readonly PartyFacts[]): GuestsOverview {
  return {
    guests: summarizeGuests(
      parties.map((party) => ({
        guests: party.guests.map((guest) => ({
          rsvp: guest.attending === null ? null : { attending: guest.attending },
        })),
      })),
    ),
    seating: summarizeSeatingGuests(parties.flatMap((party) => party.guests)),
  };
}

export function vendorsOverview(facts: BudgetFacts): VendorsOverview {
  return {
    ...summarizeVendors(facts.vendors),
    bookedWithoutAmount: facts.vendors.filter((v) => v.status === "booked" && v.contractedAmountMinor === null)
      .length,
  };
}

export function budgetOverview(summary: BudgetSummary<ScheduleItemFacts>): BudgetOverview {
  return {
    currencies: summary.currencies.map((c) => ({
      currency: c.currency,
      totalMinor: c.totalMinor,
      committedMinor: c.committedMinor,
      paidMinor: c.paidMinor,
      remainingMinor: c.remainingMinor,
      unscheduledMinor: c.unscheduledMinor,
      overdueMinor: c.overdueMinor,
      dueSoonMinor: c.dueSoonMinor,
      totalVariance: c.totalVariance,
    })),
    overdueCount: summary.overdue.length,
    dueSoonCount: summary.dueSoon.length,
    unbookedPaidVendorCount: summary.attention.length,
    timingUnavailable: summary.timingUnavailable,
    isEmpty: summary.isEmpty,
  };
}

export function timelineOverviewSummary(
  entries: readonly TimelineSlot[],
  context: Readonly<{ weddingDate: string | null; timeZone: string | null; now: Date }>,
): TimelineOverviewSummary {
  const overview = timelineOverview(entries, context);
  const ref = (entry: TimelineSlot) => ({ id: entry.id, title: entry.title });
  return {
    entryCount: overview.entryCount,
    timedCount: overview.timedCount,
    untimedCount: overview.untimedCount,
    now: overview.now
      ? {
          time: overview.now.time,
          current: overview.now.currentEntries.map(ref),
          next: overview.now.nextEntries.map(ref),
        }
      : null,
  };
}

type BuiltWedding = Readonly<{ overview: WeddingOverview; context: AttentionWeddingContext }>;

function buildWedding(input: OverviewWeddingInput, now: Date): BuiltWedding {
  const { wedding } = input;
  const today = overviewToday(wedding, now);
  const countdown = weddingCountdown(wedding.weddingDate, today);

  const checklist = map(input.checklist, (items) =>
    checklistOverview(items, { weddingDate: wedding.weddingDate, today }),
  );
  const guests = map(input.guests, guestsOverview);
  const budgetSummary = map(input.budget, (facts) => summarizeBudget({ ...facts, today }));
  const timeline = map(input.timeline, (entries) =>
    timelineOverviewSummary(entries, { weddingDate: wedding.weddingDate, timeZone: wedding.timeZone, now }),
  );

  const unavailableDomains = OVERVIEW_DOMAINS.filter((domain) => input[domain].status === "unavailable");
  const context = { name: wedding.name, weddingDate: wedding.weddingDate, countdown };
  const attention = sortAttention(
    deriveWeddingAttention({ wedding, checklist, guests, budget: budgetSummary }),
    new Map([[wedding.id, context]]),
  );

  return {
    context,
    overview: {
      wedding,
      countdown,
      checklist,
      guests,
      vendors: map(input.budget, vendorsOverview),
      budget: map(budgetSummary, budgetOverview),
      timeline,
      attention,
      attentionLevel: attention[0]?.level ?? null,
      unavailableDomains,
    },
  };
}

/**
 * Every authorized wedding's overview plus the global attention list.
 * `allClear` only when every domain was available for every wedding AND
 * nothing needs attention.
 */
export function buildWeddingsOverview(
  inputs: readonly OverviewWeddingInput[],
  now: Date,
): Extract<WeddingsOverview, { status: "ready" }> {
  const built = inputs.map((input) => buildWedding(input, now));
  const contexts = new Map(built.map(({ overview, context }) => [overview.wedding.id, context]));
  const attention = sortAttention(
    built.flatMap(({ overview }) => overview.attention),
    contexts,
  );
  const missing = new Set<OverviewDomain>(built.flatMap(({ overview }) => overview.unavailableDomains));
  const unavailableDomains = OVERVIEW_DOMAINS.filter((domain) => missing.has(domain));
  const complete = unavailableDomains.length === 0;

  return {
    status: "ready",
    weddings: built.map(({ overview }) => overview),
    attention,
    weddingsNeedingAttention: built.filter(({ overview }) => overview.attention.length > 0).length,
    unavailableDomains,
    complete,
    allClear: complete && attention.length === 0,
  };
}
