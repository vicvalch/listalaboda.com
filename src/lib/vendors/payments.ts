import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { requireWeddingMembership, type WeddingAccess } from "@/lib/authz/wedding";
import type { Database } from "@/lib/supabase/database.types";
import { financialTriggerReason, type FinancialFailureReason } from "@/lib/vendors/finance-reasons";
import {
  isValidPaymentInput,
  isValidScheduleItemInput,
  type PaymentInput,
  type ScheduleItemInput,
} from "@/lib/vendors/payment-validation";

/**
 * Vendor payment schedule and payments (LB-22, ADR-015): one vendor's
 * obligations (schedule items) and the money paid to it. Any member of the
 * wedding — owner or collaborator — manages them identically; private
 * organizer data.
 *
 * Every function takes the current user's RLS-bound client (never the
 * service role) and resolves membership server-side first. Ids from the
 * browser are lookup keys only: every write is scoped to the authorized
 * wedding AND vendor, and the database decides the rest — same-wedding
 * composite FKs, member RLS, column grants and the financial triggers, which
 * lock the vendor row and re-sum every cap (contract, item, unscheduled room)
 * on each write. Nothing here checks a sum: a check-then-write in the app
 * would race. Database errors map to a closed set of reasons.
 *
 * Nothing here sends email, writes activity history, touches the checklist or
 * stores a status: pending/partial/paid/overdue are derived on read.
 */

type Client = SupabaseClient<Database>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `not_found` is about the WEDDING (missing or not a member: callers 404).
 * `invalid_target` means the wedding is accessible but the vendor, item or
 * payment isn't in it (deleted a moment ago, another wedding's or vendor's,
 * made up): indistinguishably.
 */
export type PaymentFailureReason =
  | "unauthenticated"
  | "not_found"
  | "forbidden"
  | "invalid_input"
  | "invalid_target"
  | "database_error"
  | Exclude<FinancialFailureReason, "currency_locked" | "contract_below_recorded" | "has_financial_records">;

export type PaymentResult =
  | Readonly<{ ok: true; id: string }>
  | Readonly<{ ok: false; reason: PaymentFailureReason }>;

type DbError = Readonly<{ code?: string; message?: string }>;

const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const NOT_NULL_VIOLATION = "23502";
const INVALID_TEXT_REPRESENTATION = "22P02";
const INVALID_DATETIME_FORMAT = "22007";
const DATETIME_FIELD_OVERFLOW = "22008";
const INSUFFICIENT_PRIVILEGE = "42501";

type Operation = "write" | "delete_item";

/**
 * Maps a database error to a closed reason. A foreign key failure on a write
 * is an unknown/foreign vendor or item (`invalid_target`); deleting an item
 * that still has payments is `schedule_item_has_payments`. Exported for tests.
 */
export function paymentFailure(error: DbError, operation: Operation = "write"): PaymentFailureReason {
  switch (error.code) {
    case CHECK_VIOLATION: {
      const reason = financialTriggerReason(error.message);
      if (reason === "contract_required") return reason;
      if (
        reason === "schedule_exceeds_contract" ||
        reason === "schedule_item_below_paid" ||
        reason === "payment_exceeds_schedule_item" ||
        reason === "payment_exceeds_unscheduled"
      ) {
        return reason;
      }
      return "invalid_input";
    }
    case FOREIGN_KEY_VIOLATION:
      return operation === "delete_item" ? "schedule_item_has_payments" : "invalid_target";
    case NOT_NULL_VIOLATION:
    case INVALID_TEXT_REPRESENTATION:
    case INVALID_DATETIME_FORMAT:
    case DATETIME_FIELD_OVERFLOW:
      return "invalid_input";
    case INSUFFICIENT_PRIVILEGE:
      return "forbidden";
    default:
      return "database_error";
  }
}

function fail(reason: PaymentFailureReason): PaymentResult {
  return { ok: false, reason };
}

/**
 * Checks membership, then runs one write scoped to the authorized wedding.
 * Zero affected rows means the target isn't in this wedding (or vendor).
 */
async function mutate(
  supabase: Client,
  weddingId: string,
  targetIds: readonly string[],
  operation: Operation,
  run: (access: WeddingAccess) => PromiseLike<{ data: { id: string }[] | null; error: DbError | null }>,
): Promise<PaymentResult> {
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) return fail(access.reason === "error" ? "database_error" : access.reason);
  if (!targetIds.every((id) => UUID_PATTERN.test(id))) return fail("invalid_target");

  try {
    const { data, error } = await run(access.access);
    if (error) return fail(paymentFailure(error, operation));
    const row = data?.[0];
    if (!row) return fail("invalid_target");
    return { ok: true, id: row.id };
  } catch {
    return fail("database_error");
  }
}

// ------------------------------------------------------------ schedule items

/** Adds an obligation to a vendor. The vendor must have a contracted amount (database-checked). */
export async function createScheduleItem(
  supabase: Client,
  weddingId: string,
  vendorId: string,
  input: ScheduleItemInput,
): Promise<PaymentResult> {
  if (!isValidScheduleItemInput(input)) return fail("invalid_input");
  return mutate(supabase, weddingId, [vendorId], "write", (access) =>
    supabase
      .from("vendor_payment_schedule_items")
      .insert({
        wedding_id: access.weddingId,
        wedding_vendor_id: vendorId,
        label: input.label,
        amount_minor: input.amountMinor,
        due_on: input.dueOn,
      })
      .select("id"),
  );
}

/** Replaces an item's label, amount and due date. Never moves it to another vendor or wedding. */
export async function updateScheduleItem(
  supabase: Client,
  weddingId: string,
  vendorId: string,
  itemId: string,
  input: ScheduleItemInput,
): Promise<PaymentResult> {
  if (!isValidScheduleItemInput(input)) return fail("invalid_input");
  return mutate(supabase, weddingId, [vendorId, itemId], "write", (access) =>
    supabase
      .from("vendor_payment_schedule_items")
      .update({ label: input.label, amount_minor: input.amountMinor, due_on: input.dueOn })
      .eq("id", itemId)
      .eq("wedding_vendor_id", vendorId)
      .eq("wedding_id", access.weddingId)
      .select("id"),
  );
}

/**
 * Deletes an item. Refused while payments are applied to it
 * (`schedule_item_has_payments`): they are never silently unallocated.
 */
export function deleteScheduleItem(
  supabase: Client,
  weddingId: string,
  vendorId: string,
  itemId: string,
): Promise<PaymentResult> {
  return mutate(supabase, weddingId, [vendorId, itemId], "delete_item", (access) =>
    supabase
      .from("vendor_payment_schedule_items")
      .delete()
      .eq("id", itemId)
      .eq("wedding_vendor_id", vendorId)
      .eq("wedding_id", access.weddingId)
      .select("id"),
  );
}

// ------------------------------------------------------------------ payments

/** Records money paid to a vendor, optionally applied to one of its items. */
export async function recordVendorPayment(
  supabase: Client,
  weddingId: string,
  vendorId: string,
  input: PaymentInput,
): Promise<PaymentResult> {
  if (!isValidPaymentInput(input)) return fail("invalid_input");
  return mutate(supabase, weddingId, [vendorId], "write", (access) =>
    supabase
      .from("vendor_payments")
      .insert({
        wedding_id: access.weddingId,
        wedding_vendor_id: vendorId,
        schedule_item_id: input.scheduleItemId,
        amount_minor: input.amountMinor,
        paid_on: input.paidOn,
        note: input.note,
      })
      .select("id"),
  );
}

/**
 * Replaces a payment's amount, date, note and item (including moving it to
 * or from "Sin cuota"); the database re-checks every cap atomically.
 */
export async function updateVendorPayment(
  supabase: Client,
  weddingId: string,
  vendorId: string,
  paymentId: string,
  input: PaymentInput,
): Promise<PaymentResult> {
  if (!isValidPaymentInput(input)) return fail("invalid_input");
  return mutate(supabase, weddingId, [vendorId, paymentId], "write", (access) =>
    supabase
      .from("vendor_payments")
      .update({
        schedule_item_id: input.scheduleItemId,
        amount_minor: input.amountMinor,
        paid_on: input.paidOn,
        note: input.note,
      })
      .eq("id", paymentId)
      .eq("wedding_vendor_id", vendorId)
      .eq("wedding_id", access.weddingId)
      .select("id"),
  );
}

/** Hard delete: not a ledger, no reversal row. */
export function deleteVendorPayment(
  supabase: Client,
  weddingId: string,
  vendorId: string,
  paymentId: string,
): Promise<PaymentResult> {
  return mutate(supabase, weddingId, [vendorId, paymentId], "write", (access) =>
    supabase
      .from("vendor_payments")
      .delete()
      .eq("id", paymentId)
      .eq("wedding_vendor_id", vendorId)
      .eq("wedding_id", access.weddingId)
      .select("id"),
  );
}
