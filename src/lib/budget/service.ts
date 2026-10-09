import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { requireWeddingMembership, type WeddingAccess } from "@/lib/authz/wedding";
import type { BudgetAllocation, BudgetTotal, FinanceVendor } from "@/lib/budget/summary";
import { isValidBudgetAmount } from "@/lib/budget/validation";
import type { Database } from "@/lib/supabase/database.types";
import { isVendorCurrency, type VendorCurrency } from "@/lib/vendors/money";
import { isVendorCategory, type VendorCategory } from "@/lib/vendors/presentation";
import { listVendorFinances } from "@/lib/vendors/service";

/**
 * Wedding budget estimates (LB-22, ADR-015): an optional total per currency
 * and optional estimates per vendor category and currency. Planning intent
 * only: what is committed comes from booked vendors' contracted amounts, and
 * what is paid from vendor payments; neither is stored here.
 *
 * Any member — owner or collaborator — manages the estimates. Every function
 * takes the current user's RLS-bound client (never the service role) and
 * checks membership first; input is validated again here, and the database
 * re-checks it (CHECKs, unique keys, column grants, member RLS).
 *
 * Setting an amount writes the one row of its key (update, else insert);
 * a null amount deletes it. Clients can update only `amount_minor`, so this
 * never upserts over the key columns.
 */

type Client = SupabaseClient<Database>;

export type BudgetFailureReason = "unauthenticated" | "not_found" | "forbidden" | "invalid_input" | "database_error";

export type BudgetResult = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: BudgetFailureReason }>;

type DbError = Readonly<{ code?: string; message?: string }>;

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const NOT_NULL_VIOLATION = "23502";
const INVALID_TEXT_REPRESENTATION = "22P02";
const INSUFFICIENT_PRIVILEGE = "42501";

/** Maps a database error to a closed reason. Exported for tests. */
export function budgetFailure(error: DbError): BudgetFailureReason {
  switch (error.code) {
    case CHECK_VIOLATION:
    case NOT_NULL_VIOLATION:
    case INVALID_TEXT_REPRESENTATION:
      return "invalid_input";
    case INSUFFICIENT_PRIVILEGE:
      return "forbidden";
    default:
      return "database_error";
  }
}

const OK: BudgetResult = { ok: true };

function fail(reason: BudgetFailureReason): BudgetResult {
  return { ok: false, reason };
}

type WriteResult = PromiseLike<{ data: unknown[] | null; error: DbError | null }>;

/**
 * Update the row of the key, insert it if there is none; if a concurrent
 * insert won the race (unique key), update that row instead.
 */
async function writeAmount(update: () => WriteResult, insert: () => WriteResult): Promise<BudgetResult> {
  const updated = await update();
  if (updated.error) return fail(budgetFailure(updated.error));
  if (updated.data && updated.data.length > 0) return OK;

  const inserted = await insert();
  if (!inserted.error) return OK;
  if (inserted.error.code !== UNIQUE_VIOLATION) return fail(budgetFailure(inserted.error));

  const retried = await update();
  if (retried.error) return fail(budgetFailure(retried.error));
  return retried.data && retried.data.length > 0 ? OK : fail("database_error");
}

async function withMembership(
  supabase: Client,
  weddingId: string,
  run: (access: WeddingAccess) => Promise<BudgetResult>,
): Promise<BudgetResult> {
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) return fail(access.reason === "error" ? "database_error" : access.reason);
  try {
    return await run(access.access);
  } catch {
    return fail("database_error");
  }
}

/** Sets (or, with null, removes) the wedding's total budget in one currency. */
export async function setBudgetTotal(
  supabase: Client,
  weddingId: string,
  currency: VendorCurrency,
  amountMinor: number | null,
): Promise<BudgetResult> {
  if (!isVendorCurrency(currency) || !isValidBudgetAmount(amountMinor)) return fail("invalid_input");

  return withMembership(supabase, weddingId, async (access) => {
    const table = () => supabase.from("wedding_budget_totals");
    if (amountMinor === null) {
      const { error } = await table().delete().eq("wedding_id", access.weddingId).eq("currency", currency);
      return error ? fail(budgetFailure(error)) : OK;
    }
    return writeAmount(
      () =>
        table()
          .update({ amount_minor: amountMinor })
          .eq("wedding_id", access.weddingId)
          .eq("currency", currency)
          .select("id"),
      () => table().insert({ wedding_id: access.weddingId, currency, amount_minor: amountMinor }).select("id"),
    );
  });
}

/** Sets (or, with null, removes) the estimate of one vendor category in one currency. */
export async function setBudgetAllocation(
  supabase: Client,
  weddingId: string,
  category: VendorCategory,
  currency: VendorCurrency,
  amountMinor: number | null,
): Promise<BudgetResult> {
  if (!isVendorCategory(category) || !isVendorCurrency(currency) || !isValidBudgetAmount(amountMinor)) {
    return fail("invalid_input");
  }

  return withMembership(supabase, weddingId, async (access) => {
    const table = () => supabase.from("wedding_budget_allocations");
    if (amountMinor === null) {
      const { error } = await table()
        .delete()
        .eq("wedding_id", access.weddingId)
        .eq("category", category)
        .eq("currency", currency);
      return error ? fail(budgetFailure(error)) : OK;
    }
    return writeAmount(
      () =>
        table()
          .update({ amount_minor: amountMinor })
          .eq("wedding_id", access.weddingId)
          .eq("category", category)
          .eq("currency", currency)
          .select("id"),
      () =>
        table()
          .insert({ wedding_id: access.weddingId, category, currency, amount_minor: amountMinor })
          .select("id"),
    );
  });
}

// -------------------------------------------------------------------- read

export type WeddingBudget = Readonly<{
  weddingId: string;
  weddingName: string;
  /** IANA zone, or null: no wedding-local "today", so nothing is overdue or due soon. */
  timeZone: string | null;
  totals: readonly BudgetTotal[];
  allocations: readonly BudgetAllocation[];
  vendors: readonly FinanceVendor[];
}>;

/**
 * Everything the budget page needs, after a successful membership check, in
 * TWO queries regardless of size: the wedding (name, time zone, totals and
 * allocations embedded) and its vendors (schedule items and payments
 * embedded). Returns null on failure.
 */
export async function getWeddingBudget(supabase: Client, access: WeddingAccess): Promise<WeddingBudget | null> {
  try {
    const [wedding, vendors] = await Promise.all([
      supabase
        .from("weddings")
        .select(
          "id, name, time_zone, wedding_budget_totals(currency, amount_minor), wedding_budget_allocations(category, currency, amount_minor)",
        )
        .eq("id", access.weddingId)
        .maybeSingle(),
      listVendorFinances(supabase, access),
    ]);
    if (wedding.error || !wedding.data || vendors === null) return null;

    const totals: BudgetTotal[] = wedding.data.wedding_budget_totals.flatMap((row) =>
      isVendorCurrency(row.currency) ? [{ currency: row.currency, amountMinor: row.amount_minor }] : [],
    );
    const allocations: BudgetAllocation[] = wedding.data.wedding_budget_allocations.flatMap((row) =>
      isVendorCurrency(row.currency)
        ? [{ category: row.category, currency: row.currency, amountMinor: row.amount_minor }]
        : [],
    );
    return {
      weddingId: wedding.data.id,
      weddingName: wedding.data.name,
      timeZone: wedding.data.time_zone,
      totals,
      allocations,
      vendors,
    };
  } catch {
    return null;
  }
}
