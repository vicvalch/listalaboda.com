import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { BudgetAllocation, BudgetTotal, FinanceVendor, PaymentFacts, ScheduleItemFacts } from "@/lib/budget/summary";
import { timingFromColumns } from "@/lib/checklist/timing";
import type { Database } from "@/lib/supabase/database.types";
import { isTimelineDayOffset, storedTimeToClock } from "@/lib/timeline/presentation";
import type { TimelineSlot } from "@/lib/timeline/summary";
import { isVendorCurrency } from "@/lib/vendors/money";
import { listMyWeddings } from "@/lib/weddings/service";

import { buildWeddingsOverview } from "@/lib/weddings/overview/summary";
import type {
  BudgetFacts,
  ChecklistFacts,
  DomainResult,
  OverviewWeddingInput,
  PartyFacts,
  WeddingsOverview,
} from "@/lib/weddings/overview/types";

/**
 * The multi-wedding overview read (LB-24B, ADR-018). Read-only, through the
 * caller's own RLS-bound client: never the service role, never a SECURITY
 * DEFINER function, never persona/metadata/subscription.
 *
 * SIX queries whatever the number of weddings:
 *   1. `listMyWeddings`: the caller's memberships → the authorized ids, the
 *      ONLY input to the rest (never `weddings.created_by`);
 *   2–5. checklist, guests, budget + vendors, timeline: each ONE read rooted
 *      at `weddings` with `.in("id", ids)`, children embedded;
 *   6. the exact number of parties for those ids (`count: "exact"`, no rows).
 *   2–6 run in parallel.
 *
 * PostgREST's `max_rows` (1000) caps every embedded child array too, per
 * parent row (proved in tests/db/wedding-overview-max-rows.test.ts). So every
 * child array that could exceed it is read next to its exact `(count)` in the
 * same statement; an array shorter than its count makes that domain
 * `unavailable` for that wedding. `(count)` is a whole-row count, which needs
 * table-level SELECT, and `guest_invitations` grants columns only (the token
 * hash is withheld), so parties are checked against query 6 instead: any
 * difference makes guests `unavailable` for every wedding of the request. A
 * failed read, or a wedding missing from a response, is `unavailable` too.
 * Never zero, never empty.
 */

type Client = SupabaseClient<Database>;

/** More authorized weddings than this → `over_limit`; nothing is summarized or dropped. */
export const OVERVIEW_WEDDING_LIMIT = 100;

/**
 * The four domain projections. Minimal: no guest names, contact data,
 * tokens or notes; no vendor contacts, notes or quotes; no payment notes or
 * item labels; no timeline location, responsible or notes. Exported for the
 * truncation proof and the privacy tests.
 */
export const OVERVIEW_SELECT = {
  checklist: "id, checklist_items(status, timing_mode, relative_days, due_date), checklist_item_count:checklist_items(count)",
  guests:
    "id, guest_invitations(id, guests(id, rsvps(attending), seating_assignments(seating_table_id)), guest_count:guests(count))",
  // Totals and allocations are bounded by their unique keys ((wedding,
  // currency) and (wedding, category, currency)), far below max_rows.
  budget:
    "id, wedding_budget_totals(currency, amount_minor), wedding_budget_allocations(category, currency, amount_minor), wedding_vendors!wedding_vendors_wedding_id_fkey(id, name, category, custom_category, status, currency, contracted_amount_minor, vendor_payment_schedule_items!vendor_payment_schedule_items_vendor_same_wedding(id, amount_minor, due_on), item_count:vendor_payment_schedule_items!vendor_payment_schedule_items_vendor_same_wedding(count), vendor_payments!vendor_payments_vendor_same_wedding(id, amount_minor, paid_on, schedule_item_id), payment_count:vendor_payments!vendor_payments_vendor_same_wedding(count)), vendor_count:wedding_vendors!wedding_vendors_wedding_id_fkey(count)",
  timeline:
    "id, wedding_timeline_entries(id, title, day_offset, start_time, duration_minutes, phase, wedding_vendor_id, created_at), timeline_entry_count:wedding_timeline_entries(count)",
} as const;

const UNAVAILABLE = { status: "unavailable" } as const;

type Counted = readonly Readonly<{ count: number }>[];

/** True when `rows` is every row its exact count says exists (never truncated). */
function complete(rows: readonly unknown[], counted: Counted): boolean {
  return counted.length === 1 && counted[0].count === rows.length;
}

/**
 * One domain read for every id: rows by wedding id, or null when the read
 * failed. `toValue` returns null when a row is incomplete (truncated).
 */
type DomainRows<T> = ReadonlyMap<string, DomainResult<T>> | null;

function byWedding<Row extends { id: string }, T>(
  rows: readonly Row[],
  toValue: (row: Row) => T | null,
): ReadonlyMap<string, DomainResult<T>> {
  const results = new Map<string, DomainResult<T>>();
  for (const row of rows) {
    const value = toValue(row);
    results.set(row.id, value === null ? UNAVAILABLE : { status: "ok", value });
  }
  return results;
}

async function settle<T>(read: () => Promise<DomainRows<T>>): Promise<DomainRows<T>> {
  try {
    return await read();
  } catch {
    return null;
  }
}

function loadChecklist(supabase: Client, ids: readonly string[]) {
  return settle(async () => {
    const { data, error } = await supabase.from("weddings").select(OVERVIEW_SELECT.checklist).in("id", ids);
    if (error || !data) return null;
    return byWedding(data, (row): readonly ChecklistFacts[] | null =>
      complete(row.checklist_items, row.checklist_item_count)
        ? row.checklist_items.map((item) => ({
            status: item.status,
            // The table's CHECK makes inconsistent timing impossible.
            timing: timingFromColumns(item) ?? { mode: "none" },
          }))
        : null,
    );
  });
}

function loadGuests(supabase: Client, ids: readonly string[]) {
  return settle(async () => {
    const [embedded, parties] = await Promise.all([
      supabase.from("weddings").select(OVERVIEW_SELECT.guests).in("id", ids),
      supabase.from("guest_invitations").select("id", { count: "exact", head: true }).in("wedding_id", ids),
    ]);
    const { data, error } = embedded;
    if (error || !data || parties.error || parties.count === null) return null;
    // Every party of every authorized wedding came back, or no wedding's guests are trusted.
    if (data.reduce((total, row) => total + row.guest_invitations.length, 0) !== parties.count) return null;
    return byWedding(data, (row): readonly PartyFacts[] | null => {
      if (row.guest_invitations.some((party) => !complete(party.guests, party.guest_count))) return null;
      return row.guest_invitations.map((party) => ({
        guests: party.guests.map((guest) => ({
          attending: guest.rsvps[0]?.attending ?? null,
          seated: guest.seating_assignments.length > 0,
        })),
      }));
    });
  });
}

function loadBudget(supabase: Client, ids: readonly string[]) {
  return settle(async () => {
    const { data, error } = await supabase.from("weddings").select(OVERVIEW_SELECT.budget).in("id", ids);
    if (error || !data) return null;
    return byWedding(data, (row): BudgetFacts | null => {
      if (!complete(row.wedding_vendors, row.vendor_count)) return null;
      const truncated = row.wedding_vendors.some(
        (vendor) =>
          !complete(vendor.vendor_payment_schedule_items, vendor.item_count) ||
          !complete(vendor.vendor_payments, vendor.payment_count),
      );
      if (truncated) return null;

      const vendors: FinanceVendor<ScheduleItemFacts, PaymentFacts>[] = row.wedding_vendors.map((vendor) => ({
        id: vendor.id,
        name: vendor.name,
        category: vendor.category,
        customCategory: vendor.custom_category,
        status: vendor.status,
        currency: isVendorCurrency(vendor.currency) ? vendor.currency : null,
        contractedAmountMinor: vendor.contracted_amount_minor,
        scheduleItems: vendor.vendor_payment_schedule_items.map((item) => ({
          id: item.id,
          amountMinor: item.amount_minor,
          dueOn: item.due_on,
        })),
        payments: vendor.vendor_payments.map((payment) => ({
          id: payment.id,
          amountMinor: payment.amount_minor,
          paidOn: payment.paid_on,
          scheduleItemId: payment.schedule_item_id,
        })),
      }));
      const totals: BudgetTotal[] = row.wedding_budget_totals.flatMap((total) =>
        isVendorCurrency(total.currency) ? [{ currency: total.currency, amountMinor: total.amount_minor }] : [],
      );
      const allocations: BudgetAllocation[] = row.wedding_budget_allocations.flatMap((allocation) =>
        isVendorCurrency(allocation.currency)
          ? [{ category: allocation.category, currency: allocation.currency, amountMinor: allocation.amount_minor }]
          : [],
      );
      return { vendors, totals, allocations };
    });
  });
}

function loadTimeline(supabase: Client, ids: readonly string[]) {
  return settle(async () => {
    const { data, error } = await supabase.from("weddings").select(OVERVIEW_SELECT.timeline).in("id", ids);
    if (error || !data) return null;
    return byWedding(data, (row): readonly TimelineSlot[] | null => {
      if (!complete(row.wedding_timeline_entries, row.timeline_entry_count)) return null;
      const slots: TimelineSlot[] = [];
      for (const entry of row.wedding_timeline_entries) {
        const startTime = storedTimeToClock(entry.start_time);
        // Same rule as the timeline page: a drifted row fails closed.
        if (!isTimelineDayOffset(entry.day_offset) || (entry.start_time !== null && startTime === null)) return null;
        slots.push({
          id: entry.id,
          title: entry.title,
          dayOffset: entry.day_offset,
          startTime,
          durationMinutes: entry.duration_minutes,
          phase: entry.phase,
          vendor: entry.wedding_vendor_id === null ? null : { id: entry.wedding_vendor_id },
          createdAt: entry.created_at,
        });
      }
      return slots;
    });
  });
}

/** A wedding's result in one domain read; absent from the response = unavailable. */
function pick<T>(rows: DomainRows<T>, weddingId: string): DomainResult<T> {
  return rows?.get(weddingId) ?? UNAVAILABLE;
}

/**
 * The overview for the signed-in user. `userId` is the caller's own id from
 * `requireUser`; `now` is the request's ONE clock read (this module never
 * reads the clock).
 */
export async function loadWeddingsOverview(supabase: Client, userId: string, now: Date): Promise<WeddingsOverview> {
  const weddings = await listMyWeddings(supabase, userId);
  if (weddings === null) return { status: "error" };
  if (weddings.length > OVERVIEW_WEDDING_LIMIT) {
    return { status: "over_limit", weddingCount: weddings.length, limit: OVERVIEW_WEDDING_LIMIT };
  }
  if (weddings.length === 0) return buildWeddingsOverview([], now);

  const ids = weddings.map((wedding) => wedding.id);
  const [checklist, guests, budget, timeline] = await Promise.all([
    loadChecklist(supabase, ids),
    loadGuests(supabase, ids),
    loadBudget(supabase, ids),
    loadTimeline(supabase, ids),
  ]);

  const inputs: OverviewWeddingInput[] = weddings.map((wedding) => ({
    wedding,
    checklist: pick(checklist, wedding.id),
    guests: pick(guests, wedding.id),
    budget: pick(budget, wedding.id),
    timeline: pick(timeline, wedding.id),
  }));
  return buildWeddingsOverview(inputs, now);
}
