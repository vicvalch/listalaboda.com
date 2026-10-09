import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { requireWeddingMembership, type WeddingAccess } from "@/lib/authz/wedding";
import type { FinancePayment, FinanceScheduleItem, FinanceVendor } from "@/lib/budget/summary";
import type { Database } from "@/lib/supabase/database.types";
import { financialTriggerReason } from "@/lib/vendors/finance-reasons";
import { isVendorCurrency } from "@/lib/vendors/money";
import type { VendorListItem } from "@/lib/vendors/summary";
import { isValidVendorInput, type VendorInput } from "@/lib/vendors/validation";

/**
 * Wedding vendor application layer (LB-21, ADR-014): one wedding's vendor
 * engagements. Any member of the wedding — owner or collaborator — manages
 * them identically; the data is PRIVATE organizer data.
 *
 * Every function takes the current user's RLS-bound client (never the service
 * role) and resolves membership server-side first (`@/lib/authz/wedding`).
 * A vendor id from the browser is a lookup key only: every read and write is
 * scoped to the authorized wedding, so a known id of another wedding finds
 * nothing. Input is validated again here before any write, and the database
 * re-checks everything (CHECKs, column grants, member RLS). Database errors
 * map to a closed set of reasons; raw messages never leave this module.
 *
 * Nothing here sends email, writes activity history or touches the
 * checklist, guests or public projections. Concurrent edits are
 * last-write-wins (no versions or locks).
 *
 * LB-22 (ADR-015): once a vendor has schedule items or payments, the database
 * locks its currency, keeps its contracted amount non-null and at least the
 * recorded floor, and refuses to delete it (NO ACTION foreign keys). Those
 * refusals map to their own closed reasons here.
 */

type Client = SupabaseClient<Database>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `not_found` is about the WEDDING (missing or not a member: callers 404).
 * `invalid_target` means the wedding is accessible but the vendor isn't in it
 * (deleted a moment ago, another wedding's, made up): indistinguishably.
 */
export type VendorFailureReason =
  | "unauthenticated"
  | "not_found"
  | "forbidden"
  | "invalid_input"
  | "invalid_target"
  | "database_error"
  // LB-22 (ADR-015): the vendor financial guard and delete protection.
  | "currency_locked"
  | "contract_required"
  | "contract_below_recorded"
  | "has_financial_records";

export type VendorResult =
  | Readonly<{ ok: true; vendorId: string }>
  | Readonly<{ ok: false; reason: VendorFailureReason }>;

type DbError = Readonly<{ code?: string; message?: string }>;

const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const NOT_NULL_VIOLATION = "23502";
const INVALID_TEXT_REPRESENTATION = "22P02";
const INSUFFICIENT_PRIVILEGE = "42501";

/**
 * Maps a database error to a closed reason. Exported for tests. The only
 * foreign key a vendor write can hit is a financial child blocking a delete.
 */
export function vendorFailure(error: DbError): VendorFailureReason {
  switch (error.code) {
    case CHECK_VIOLATION: {
      const reason = financialTriggerReason(error.message);
      return reason === "currency_locked" || reason === "contract_required" || reason === "contract_below_recorded"
        ? reason
        : "invalid_input";
    }
    case FOREIGN_KEY_VIOLATION:
      return "has_financial_records";
    case NOT_NULL_VIOLATION:
    case INVALID_TEXT_REPRESENTATION:
      return "invalid_input";
    case INSUFFICIENT_PRIVILEGE:
      return "forbidden";
    default:
      return "database_error";
  }
}

function fail(reason: VendorFailureReason): VendorResult {
  return { ok: false, reason };
}

/**
 * Checks membership, then runs one write scoped to the authorized wedding.
 * Zero affected rows means the vendor isn't in this wedding.
 */
async function mutate(
  supabase: Client,
  weddingId: string,
  vendorId: string | null,
  run: (access: WeddingAccess) => PromiseLike<{ data: { id: string }[] | null; error: DbError | null }>,
): Promise<VendorResult> {
  const access = await requireWeddingMembership(supabase, weddingId);
  // An unexpected failure resolving membership is a database error.
  if (!access.ok) return fail(access.reason === "error" ? "database_error" : access.reason);
  // A malformed id can't be a vendor of this wedding.
  if (vendorId !== null && !UUID_PATTERN.test(vendorId)) return fail("invalid_target");

  try {
    const { data, error } = await run(access.access);
    if (error) return fail(vendorFailure(error));
    const row = data?.[0];
    if (!row) return fail("invalid_target");
    return { ok: true, vendorId: row.id };
  } catch {
    return fail("database_error");
  }
}

/** The stored columns of a normalized input (never ids, wedding, provenance or timestamps). */
function vendorColumns(input: VendorInput) {
  return {
    name: input.name,
    category: input.category,
    custom_category: input.customCategory,
    status: input.status,
    contact_name: input.contactName,
    email: input.email,
    phone: input.phone,
    instagram_handle: input.instagramHandle,
    currency: input.currency,
    quoted_amount_minor: input.quotedAmountMinor,
    contracted_amount_minor: input.contractedAmountMinor,
    notes: input.notes,
  };
}

// -------------------------------------------------------------------- read

/** The list's columns: what cards, search, filters and the summary need. NOT notes. */
const LIST_COLUMNS =
  "id, name, category, custom_category, status, contact_name, email, phone, instagram_handle, currency, quoted_amount_minor, contracted_amount_minor, updated_at";

/**
 * LB-22: a vendor's schedule items and payments, embedded in the same query
 * (never one query per vendor, item or payment). The relationship is named
 * because vendor_payments also links the vendor to its items.
 */
const FINANCE_EMBEDS =
  "vendor_payment_schedule_items!vendor_payment_schedule_items_vendor_same_wedding(id, label, amount_minor, due_on), vendor_payments!vendor_payments_vendor_same_wedding(id, amount_minor, paid_on, schedule_item_id, note)";

/** The detail page adds the notes and (LB-22) the vendor's schedule and payments. */
const DETAIL_COLUMNS = `${LIST_COLUMNS}, notes, ${FINANCE_EMBEDS}`;

/** The budget page's vendor read: what the money derivations need, nothing else. */
const FINANCE_COLUMNS = `id, name, category, custom_category, status, currency, contracted_amount_minor, ${FINANCE_EMBEDS}`;

type ScheduleItemRow = Readonly<{ id: string; label: string; amount_minor: number; due_on: string }>;
type PaymentRow = Readonly<{
  id: string;
  amount_minor: number;
  paid_on: string;
  schedule_item_id: string | null;
  note: string | null;
}>;

function toScheduleItems(rows: readonly ScheduleItemRow[]): FinanceScheduleItem[] {
  return rows.map((row) => ({ id: row.id, label: row.label, amountMinor: row.amount_minor, dueOn: row.due_on }));
}

function toPayments(rows: readonly PaymentRow[]): FinancePayment[] {
  return rows.map((row) => ({
    id: row.id,
    amountMinor: row.amount_minor,
    paidOn: row.paid_on,
    scheduleItemId: row.schedule_item_id,
    note: row.note,
  }));
}

type ListRow = Pick<
  Database["public"]["Tables"]["wedding_vendors"]["Row"],
  | "id"
  | "name"
  | "category"
  | "custom_category"
  | "status"
  | "contact_name"
  | "email"
  | "phone"
  | "instagram_handle"
  | "currency"
  | "quoted_amount_minor"
  | "contracted_amount_minor"
  | "updated_at"
>;

function toListItem(row: ListRow): VendorListItem {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    customCategory: row.custom_category,
    status: row.status,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    instagramHandle: row.instagram_handle,
    // The CHECK allows only CRC and USD; anything else would be a schema drift.
    currency: isVendorCurrency(row.currency) ? row.currency : null,
    quotedAmountMinor: row.quoted_amount_minor,
    contractedAmountMinor: row.contracted_amount_minor,
    updatedAt: row.updated_at,
  };
}

/**
 * Every vendor of the wedding in ONE query (never per vendor), without notes.
 * Takes the `WeddingAccess` of a successful membership check. Grouping,
 * sorting, search and summaries are derived in memory
 * (`@/lib/vendors/summary`). Returns null on failure.
 */
export async function listWeddingVendors(
  supabase: Client,
  access: WeddingAccess,
): Promise<VendorListItem[] | null> {
  try {
    const { data, error } = await supabase
      .from("wedding_vendors")
      .select(LIST_COLUMNS)
      .eq("wedding_id", access.weddingId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (error || !data) return null;
    return data.map(toListItem);
  } catch {
    return null;
  }
}

export type VendorDetail = VendorListItem &
  Readonly<{
    notes: string | null;
    scheduleItems: readonly FinanceScheduleItem[];
    payments: readonly FinancePayment[];
  }>;

export type VendorDetailResult =
  | Readonly<{ ok: true; vendor: VendorDetail }>
  | Readonly<{ ok: false; reason: "not_found" | "database_error" }>;

/**
 * One vendor of the authorized wedding, with its notes, schedule items and
 * payments, in ONE query scoped by id AND wedding. A malformed id, another wedding's vendor and a deleted
 * one are all `not_found` (callers 404).
 */
export async function getWeddingVendor(
  supabase: Client,
  access: WeddingAccess,
  vendorId: string,
): Promise<VendorDetailResult> {
  if (!UUID_PATTERN.test(vendorId)) return { ok: false, reason: "not_found" };
  try {
    const { data, error } = await supabase
      .from("wedding_vendors")
      .select(DETAIL_COLUMNS)
      .eq("id", vendorId)
      .eq("wedding_id", access.weddingId)
      .maybeSingle();
    if (error) return { ok: false, reason: "database_error" };
    if (!data) return { ok: false, reason: "not_found" };
    return {
      ok: true,
      vendor: {
        ...toListItem(data),
        notes: data.notes,
        scheduleItems: toScheduleItems(data.vendor_payment_schedule_items),
        payments: toPayments(data.vendor_payments),
      },
    };
  } catch {
    return { ok: false, reason: "database_error" };
  }
}

/**
 * LB-22: every vendor of the wedding with its schedule items and payments, in
 * ONE query (no per-vendor reads). Derivations happen in memory
 * (`@/lib/budget/summary`). Returns null on failure.
 */
export async function listVendorFinances(
  supabase: Client,
  access: WeddingAccess,
): Promise<FinanceVendor[] | null> {
  try {
    const { data, error } = await supabase
      .from("wedding_vendors")
      .select(FINANCE_COLUMNS)
      .eq("wedding_id", access.weddingId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (error || !data) return null;
    return data.map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      customCategory: row.custom_category,
      status: row.status,
      currency: isVendorCurrency(row.currency) ? row.currency : null,
      contractedAmountMinor: row.contracted_amount_minor,
      scheduleItems: toScheduleItems(row.vendor_payment_schedule_items),
      payments: toPayments(row.vendor_payments),
    }));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ writes

/** Adds a vendor to the wedding. Provenance and timestamps come from the database. */
export async function createWeddingVendor(
  supabase: Client,
  weddingId: string,
  input: VendorInput,
): Promise<VendorResult> {
  if (!isValidVendorInput(input)) return fail("invalid_input");

  return mutate(supabase, weddingId, null, (access) =>
    supabase
      .from("wedding_vendors")
      .insert({ wedding_id: access.weddingId, ...vendorColumns(input) })
      .select("id"),
  );
}

/**
 * Replaces every editable field of one vendor in one write (status included:
 * any status may follow any other). Never moves it to another wedding.
 */
export async function updateWeddingVendor(
  supabase: Client,
  weddingId: string,
  vendorId: string,
  input: VendorInput,
): Promise<VendorResult> {
  if (!isValidVendorInput(input)) return fail("invalid_input");

  return mutate(supabase, weddingId, vendorId, (access) =>
    supabase
      .from("wedding_vendors")
      .update(vendorColumns(input))
      .eq("id", vendorId)
      .eq("wedding_id", access.weddingId)
      .select("id"),
  );
}

/**
 * Hard-deletes one vendor engagement ("Descartado" is a status, not this).
 * LB-22: refused (`has_financial_records`) while it has schedule items or
 * payments; financial history is never cascaded away.
 */
export function deleteWeddingVendor(
  supabase: Client,
  weddingId: string,
  vendorId: string,
): Promise<VendorResult> {
  return mutate(supabase, weddingId, vendorId, (access) =>
    supabase
      .from("wedding_vendors")
      .delete()
      .eq("id", vendorId)
      .eq("wedding_id", access.weddingId)
      .select("id"),
  );
}
