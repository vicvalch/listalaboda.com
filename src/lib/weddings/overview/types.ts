import type { ChecklistProgress } from "@/lib/checklist/progress";
import type { ChecklistTiming, ChecklistStatus } from "@/lib/checklist/types";
import type { BudgetAllocation, BudgetTotal, CurrencyBudget, FinanceVendor, PaymentFacts, ScheduleItemFacts } from "@/lib/budget/summary";
import type { GuestSummary } from "@/lib/guests/summary";
import type { SeatingGuestCounts } from "@/lib/seating/plan";
import type { TimelineSlot } from "@/lib/timeline/summary";
import type { VendorCurrency } from "@/lib/vendors/money";
import type { VendorSummary } from "@/lib/vendors/summary";
import type { WeddingSummary } from "@/lib/weddings/service";

/**
 * The multi-wedding overview contract (LB-24B, ADR-018): a read model and
 * derived attention for "Mis bodas", built per request and never stored.
 * There is deliberately no score, health or readiness number anywhere in it.
 * Money stays `bigint` per currency (CRC and USD are never combined); the
 * page formats it on the server before anything reaches a client component.
 */

// ------------------------------------------------------------------ domains

/** The four batched domain reads after the authorized wedding list. */
export type OverviewDomain = "checklist" | "guests" | "budget" | "timeline";

/** Fixed order for `unavailableDomains`. */
export const OVERVIEW_DOMAINS: readonly OverviewDomain[] = ["checklist", "guests", "budget", "timeline"];

/**
 * A domain's state for one wedding. `unavailable` = the read failed, the
 * wedding was missing from the response, or a child array came back shorter
 * than its exact count (PostgREST `max_rows`): never read as zero or empty.
 */
export type DomainResult<T> = Readonly<{ status: "ok"; value: T }> | Readonly<{ status: "unavailable" }>;

// ------------------------------------------------- pure builder input (rows)

export type ChecklistFacts = Readonly<{ status: ChecklistStatus; timing: ChecklistTiming }>;

export type GuestFacts = Readonly<{ attending: boolean | null; seated: boolean }>;
export type PartyFacts = Readonly<{ guests: readonly GuestFacts[] }>;

export type BudgetFacts = Readonly<{
  vendors: readonly FinanceVendor<ScheduleItemFacts, PaymentFacts>[];
  totals: readonly BudgetTotal[];
  allocations: readonly BudgetAllocation[];
}>;

/** One authorized wedding with what each domain read returned for it. */
export type OverviewWeddingInput = Readonly<{
  wedding: WeddingSummary;
  checklist: DomainResult<readonly ChecklistFacts[]>;
  guests: DomainResult<readonly PartyFacts[]>;
  budget: DomainResult<BudgetFacts>;
  timeline: DomainResult<readonly TimelineSlot[]>;
}>;

// ---------------------------------------------------------------- summaries

export type WeddingCountdown =
  | Readonly<{ state: "undated" }>
  /** Date known, wedding-local today unknown (no or unknown time zone). */
  | Readonly<{ state: "no_time_zone" }>
  /** days ≥ 1 */
  | Readonly<{ state: "before"; days: number }>
  | Readonly<{ state: "today" }>
  /** days ≥ 1 */
  | Readonly<{ state: "after"; days: number }>;

export type ChecklistOverview = Readonly<{
  progress: ChecklistProgress;
  overdueCount: number;
  /** Earliest effective due date among overdue items, `YYYY-MM-DD`. */
  oldestOverdueOn: string | null;
}>;

export type GuestsOverview = Readonly<{
  guests: GuestSummary;
  seating: SeatingGuestCounts;
}>;

export type VendorsOverview = VendorSummary &
  Readonly<{
    /** Booked with no contracted amount: summary only, never attention. */
    bookedWithoutAmount: number;
  }>;

export type CurrencyBudgetOverview = Pick<
  CurrencyBudget,
  | "currency"
  | "totalMinor"
  | "committedMinor"
  | "paidMinor"
  | "remainingMinor"
  | "unscheduledMinor"
  | "overdueMinor"
  | "dueSoonMinor"
  | "totalVariance"
>;

export type BudgetOverview = Readonly<{
  /** One block per currency in use, CRC then USD. Never a combined total. */
  currencies: readonly CurrencyBudgetOverview[];
  overdueCount: number;
  dueSoonCount: number;
  unbookedPaidVendorCount: number;
  /** No wedding-local today: no overdue / due-soon classification. */
  timingUnavailable: boolean;
  isEmpty: boolean;
}>;

export type TimelineEntryRef = Readonly<{ id: string; title: string }>;

export type TimelineOverviewSummary = Readonly<{
  entryCount: number;
  timedCount: number;
  untimedCount: number;
  /** Only on the wedding day and the day after, with a date and a zone. */
  now: Readonly<{ time: string; current: readonly TimelineEntryRef[]; next: readonly TimelineEntryRef[] }> | null;
}>;

// ---------------------------------------------------------------- attention

/** The closed initial taxonomy. Adding a kind is an ADR-018 decision. */
export type AttentionKind =
  | "payment_overdue"
  | "checklist_overdue"
  | "payment_due_soon"
  | "seated_declined"
  | "payment_to_unbooked_vendor"
  | "budget_total_over"
  | "wedding_date_missing"
  | "wedding_time_zone_missing";

/**
 * Labels with fixed meanings, not severities: `overdue` = a date the domain
 * defines has passed; `due_soon` = the domain's own soon window; `review` =
 * a contradiction the domain already flags; `setup` = missing wedding facts.
 */
export type AttentionLevel = "overdue" | "due_soon" | "review" | "setup";

/** Where an item leads, resolved to a path by `attentionPath`. */
export type AttentionDestination = "checklist_plan" | "budget" | "seating" | "settings";

export type MoneyBucket = Readonly<{ currency: VendorCurrency; amountMinor: bigint }>;

export type AttentionItem = Readonly<{
  /** `${weddingId}:${kind}`: derived, never persisted. */
  id: string;
  weddingId: string;
  kind: AttentionKind;
  level: AttentionLevel;
  /** Underlying records of THIS kind (obligations, items, guests, vendors, currencies; 1 for setup). */
  count: number;
  /** Per currency, CRC then USD; [] when the kind isn't about money. Never summed across currencies. */
  amounts: readonly MoneyBucket[];
  /** `YYYY-MM-DD`: the oldest overdue / earliest due-soon date; null otherwise. */
  since: string | null;
  destination: AttentionDestination;
}>;

// ------------------------------------------------------------------ results

export type WeddingOverview = Readonly<{
  wedding: WeddingSummary;
  countdown: WeddingCountdown;
  checklist: DomainResult<ChecklistOverview>;
  guests: DomainResult<GuestsOverview>;
  /** Same read as `budget`: available exactly when it is. */
  vendors: DomainResult<VendorsOverview>;
  budget: DomainResult<BudgetOverview>;
  timeline: DomainResult<TimelineOverviewSummary>;
  /** This wedding's items, in the global order. */
  attention: readonly AttentionItem[];
  /** The first (highest) level present, or null. */
  attentionLevel: AttentionLevel | null;
  unavailableDomains: readonly OverviewDomain[];
}>;

export type WeddingsOverview =
  /** The authorized wedding list itself failed. */
  | Readonly<{ status: "error" }>
  /** More authorized weddings than the overview summarizes: nothing is summarized, nothing dropped. */
  /** `weddingCount` = memberships read (a lower bound past PostgREST's max_rows). */
  | Readonly<{ status: "over_limit"; weddingCount: number; limit: number }>
  | Readonly<{
      status: "ready";
      /** In `listMyWeddings` order. */
      weddings: readonly WeddingOverview[];
      /** Every wedding's items, globally sorted. */
      attention: readonly AttentionItem[];
      weddingsNeedingAttention: number;
      /** Union across weddings, in `OVERVIEW_DOMAINS` order. */
      unavailableDomains: readonly OverviewDomain[];
      /** No domain unavailable for any wedding. */
      complete: boolean;
      /** complete && attention.length === 0 */
      allClear: boolean;
    }>;
