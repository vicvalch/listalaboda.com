import type { BudgetSummary, ScheduleItemFacts } from "@/lib/budget/summary";
import { VENDOR_CURRENCIES, type VendorCurrency } from "@/lib/vendors/money";
import type { WeddingSummary } from "@/lib/weddings/service";

import type {
  AttentionDestination,
  AttentionItem,
  AttentionKind,
  AttentionLevel,
  ChecklistOverview,
  DomainResult,
  GuestsOverview,
  MoneyBucket,
  WeddingCountdown,
} from "@/lib/weddings/overview/types";

/**
 * Derived attention (LB-24B, ADR-018). Pure: no database, React, clock or
 * formatting. Every trigger is a fact an existing domain helper already
 * computed (`isOverdue`, `summarizeBudget`, `summarizeSeatingGuests`); this
 * module only names it, ranks it and points somewhere. Nothing is stored.
 *
 * A domain that is unavailable for a wedding derives none of its kinds:
 * missing data is never "nothing to do". Wedding-fact kinds (date, time
 * zone) come from the authorized wedding list itself.
 */

/** The closed taxonomy, in priority order (`KIND_RANK`). */
export const ATTENTION_KINDS: readonly AttentionKind[] = [
  "payment_overdue",
  "checklist_overdue",
  "payment_due_soon",
  "seated_declined",
  "payment_to_unbooked_vendor",
  "budget_total_over",
  "wedding_date_missing",
  "wedding_time_zone_missing",
];

export const KIND_RANK: Readonly<Record<AttentionKind, number>> = Object.fromEntries(
  ATTENTION_KINDS.map((kind, index) => [kind, index]),
) as Record<AttentionKind, number>;

export const ATTENTION_LEVELS: readonly AttentionLevel[] = ["overdue", "due_soon", "review", "setup"];

export const LEVEL_RANK: Readonly<Record<AttentionLevel, number>> = Object.fromEntries(
  ATTENTION_LEVELS.map((level, index) => [level, index]),
) as Record<AttentionLevel, number>;

/** Each kind's fixed level and destination. */
export const KIND_LEVEL: Readonly<Record<AttentionKind, AttentionLevel>> = {
  payment_overdue: "overdue",
  checklist_overdue: "overdue",
  payment_due_soon: "due_soon",
  seated_declined: "review",
  payment_to_unbooked_vendor: "review",
  budget_total_over: "review",
  wedding_date_missing: "setup",
  wedding_time_zone_missing: "setup",
};

const KIND_DESTINATION: Readonly<Record<AttentionKind, AttentionDestination>> = {
  payment_overdue: "budget",
  checklist_overdue: "checklist_plan",
  payment_due_soon: "budget",
  seated_declined: "seating",
  payment_to_unbooked_vendor: "budget",
  budget_total_over: "budget",
  wedding_date_missing: "settings",
  wedding_time_zone_missing: "settings",
};

export function attentionId(weddingId: string, kind: AttentionKind): string {
  return `${weddingId}:${kind}`;
}

function item(
  weddingId: string,
  kind: AttentionKind,
  fields: Readonly<{ count: number; amounts?: readonly MoneyBucket[]; since?: string | null }>,
): AttentionItem {
  return {
    id: attentionId(weddingId, kind),
    weddingId,
    kind,
    level: KIND_LEVEL[kind],
    count: fields.count,
    amounts: fields.amounts ?? [],
    since: fields.since ?? null,
    destination: KIND_DESTINATION[kind],
  };
}

/** Per-currency sums in fixed order (CRC, then USD), zero buckets dropped. Never across currencies. */
function buckets(entries: readonly Readonly<{ currency: VendorCurrency; amountMinor: bigint }>[]): MoneyBucket[] {
  return VENDOR_CURRENCIES.flatMap((currency) => {
    const amountMinor = entries
      .filter((entry) => entry.currency === currency)
      .reduce((total, entry) => total + entry.amountMinor, BigInt(0));
    return amountMinor > BigInt(0) ? [{ currency, amountMinor }] : [];
  });
}

export type WeddingAttentionInput = Readonly<{
  wedding: Pick<WeddingSummary, "id" | "weddingDate" | "timeZone">;
  checklist: DomainResult<ChecklistOverview>;
  guests: DomainResult<GuestsOverview>;
  /** The full `summarizeBudget` result (the overview only projects it). */
  budget: DomainResult<BudgetSummary<ScheduleItemFacts>>;
}>;

/** One wedding's attention items, unsorted (see `compareAttention`). */
export function deriveWeddingAttention({ wedding, checklist, guests, budget }: WeddingAttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  const id = wedding.id;

  if (budget.status === "ok") {
    const { overdue, dueSoon, currencies, attention } = budget.value;
    if (overdue.length > 0) {
      items.push(
        item(id, "payment_overdue", {
          count: overdue.length,
          amounts: buckets(currencies.map((c) => ({ currency: c.currency, amountMinor: c.overdueMinor }))),
          since: overdue[0].entry.item.dueOn,
        }),
      );
    }
    if (dueSoon.length > 0) {
      items.push(
        item(id, "payment_due_soon", {
          count: dueSoon.length,
          amounts: buckets(currencies.map((c) => ({ currency: c.currency, amountMinor: c.dueSoonMinor }))),
          since: dueSoon[0].entry.item.dueOn,
        }),
      );
    }
    if (attention.length > 0) {
      items.push(
        item(id, "payment_to_unbooked_vendor", {
          count: attention.length,
          amounts: buckets(attention.map((vendor) => ({ currency: vendor.currency, amountMinor: vendor.paidMinor }))),
        }),
      );
    }
    const over = currencies.flatMap((c) =>
      c.totalVariance?.kind === "over" ? [{ currency: c.currency, amountMinor: c.totalVariance.amountMinor }] : [],
    );
    if (over.length > 0) {
      items.push(item(id, "budget_total_over", { count: over.length, amounts: buckets(over) }));
    }
  }

  if (checklist.status === "ok" && checklist.value.overdueCount > 0) {
    items.push(
      item(id, "checklist_overdue", {
        count: checklist.value.overdueCount,
        since: checklist.value.oldestOverdueOn,
      }),
    );
  }

  if (guests.status === "ok" && guests.value.seating.seatedDeclined > 0) {
    items.push(item(id, "seated_declined", { count: guests.value.seating.seatedDeclined }));
  }

  if (wedding.weddingDate === null) items.push(item(id, "wedding_date_missing", { count: 1 }));
  if (wedding.timeZone === null) items.push(item(id, "wedding_time_zone_missing", { count: 1 }));

  return items;
}

// ------------------------------------------------------------------- order

/** What the comparator needs to know about an item's wedding. */
export type AttentionWeddingContext = Readonly<{
  name: string;
  weddingDate: string | null;
  countdown: WeddingCountdown;
}>;

/**
 * Wedding proximity as a lexicographic key: today / upcoming first (nearest
 * first), then past (most recent first), then dated without a time zone (by
 * date), then undated.
 */
function proximityKey(context: AttentionWeddingContext): readonly [number, number | string] {
  const { countdown } = context;
  switch (countdown.state) {
    case "today":
      return [0, 0];
    case "before":
      return [0, countdown.days];
    case "after":
      return [1, countdown.days];
    case "no_time_zone":
      return [2, context.weddingDate ?? ""];
    case "undated":
      return [3, 0];
  }
}

const nameCollator = new Intl.Collator("es", { sensitivity: "base" });

function compareKeys(a: number | string, b: number | string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * The global order, key by key: level, wedding proximity, kind, `since`
 * (ascending, nulls last), wedding name (Spanish collation), wedding id.
 * `(weddingId, kind)` is unique, so no tie survives.
 */
export function compareAttention(
  a: AttentionItem,
  b: AttentionItem,
  weddings: ReadonlyMap<string, AttentionWeddingContext>,
): number {
  const byLevel = LEVEL_RANK[a.level] - LEVEL_RANK[b.level];
  if (byLevel !== 0) return byLevel;

  const wa = weddings.get(a.weddingId);
  const wb = weddings.get(b.weddingId);
  if (wa && wb) {
    const [ga, va] = proximityKey(wa);
    const [gb, vb] = proximityKey(wb);
    if (ga !== gb) return ga - gb;
    const byValue = compareKeys(va, vb);
    if (byValue !== 0) return byValue;
  }

  const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (byKind !== 0) return byKind;

  if (a.since !== b.since) {
    if (a.since === null) return 1;
    if (b.since === null) return -1;
    return compareKeys(a.since, b.since);
  }

  const byName = nameCollator.compare(wa?.name ?? "", wb?.name ?? "");
  if (byName !== 0) return byName;
  return compareKeys(a.weddingId, b.weddingId);
}

export function sortAttention(
  items: readonly AttentionItem[],
  weddings: ReadonlyMap<string, AttentionWeddingContext>,
): AttentionItem[] {
  return [...items].sort((a, b) => compareAttention(a, b, weddings));
}

// ------------------------------------------------------------------- links

/**
 * The app path an item leads to: only routes that exist today. Wedding
 * settings are owner-only, so a collaborator's setup items open the
 * wedding home instead.
 */
export function attentionPath(
  weddingId: string,
  destination: AttentionDestination,
  role: WeddingSummary["role"],
): string {
  const base = `/app/weddings/${weddingId}`;
  switch (destination) {
    case "checklist_plan":
      return `${base}?view=plan`;
    case "budget":
      return `${base}/budget`;
    case "seating":
      return `${base}/seating`;
    case "settings":
      return role === "owner" ? `${base}/settings` : base;
  }
}
