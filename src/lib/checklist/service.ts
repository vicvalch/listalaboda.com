import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  requireWeddingMembership,
  requireWeddingRole,
  type WeddingAccess,
} from "@/lib/authz/wedding";
import { timingFromColumns, timingToColumns } from "@/lib/checklist/timing";
import type { ChecklistItem, ChecklistStatus } from "@/lib/checklist/types";
import type { ChecklistItemInput } from "@/lib/checklist/validation";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Checklist application layer: read, initialize from the template, create,
 * edit, change status, delete.
 *
 * Every function uses the current user's RLS-bound client. Mutations check
 * membership through `@/lib/authz/wedding` first (any member manages the
 * checklist; initialization is owner-only); RLS and column grants are the
 * backstop. A wedding id or item id from the client is only a lookup key:
 * every item query is additionally scoped to the authorized wedding.
 * `created_by` / `completed_by` are provenance and never consulted here.
 */

type Client = SupabaseClient<Database>;

export type ChecklistDenial = "unauthenticated" | "not_found" | "forbidden" | "error";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ITEM_COLUMNS =
  "id, title, description, category, status, timing_mode, relative_days, due_date, sort_order";

// -------------------------------------------------------------------- read

export type WeddingChecklist = Readonly<{
  /** Whether the starter template has been applied (at most once). */
  initialized: boolean;
  items: readonly ChecklistItem[];
}>;

/**
 * The wedding's checklist in its persisted order. Takes the `WeddingAccess`
 * from a successful membership check, so it can't be called without one.
 * Returns null on failure, so callers show an error instead of an empty list.
 */
export async function getWeddingChecklist(
  supabase: Client,
  access: WeddingAccess,
): Promise<WeddingChecklist | null> {
  try {
    const [application, items] = await Promise.all([
      supabase
        .from("wedding_checklist_template_applications")
        .select("id")
        .eq("wedding_id", access.weddingId)
        .maybeSingle(),
      supabase
        .from("checklist_items")
        .select(ITEM_COLUMNS)
        .eq("wedding_id", access.weddingId)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true })
        .order("id", { ascending: true }),
    ]);
    if (application.error || items.error || !items.data) return null;

    return {
      initialized: application.data !== null,
      items: items.data.map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        category: row.category,
        status: row.status,
        // The table's CHECK makes inconsistent timing impossible.
        timing: timingFromColumns(row) ?? { mode: "none" },
        sortOrder: row.sort_order,
      })),
    };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- initialize

export type InitializeChecklistResult =
  | Readonly<{ ok: true; alreadyInitialized: boolean; itemCount: number }>
  | Readonly<{ ok: false; reason: ChecklistDenial }>;

/**
 * Seeds the wedding's checklist from the default template through the
 * owner-only, atomic, at-most-once `initialize_wedding_checklist` RPC. Only
 * the wedding id is sent; the database derives the user and the template.
 */
export async function initializeWeddingChecklist(
  supabase: Client,
  weddingId: string,
): Promise<InitializeChecklistResult> {
  const access = await requireWeddingRole(supabase, weddingId, ["owner"]);
  if (!access.ok) return { ok: false, reason: access.reason };

  try {
    const { data, error } = await supabase.rpc("initialize_wedding_checklist", {
      target_wedding_id: access.access.weddingId,
    });
    if (error) {
      if (error.message === "wedding_not_found") return { ok: false, reason: "not_found" };
      if (error.message === "checklist_initialize_forbidden") {
        return { ok: false, reason: "forbidden" };
      }
      if (error.code === "42501") return { ok: false, reason: "unauthenticated" };
      return { ok: false, reason: "error" };
    }
    const row = data?.[0];
    if (!row) return { ok: false, reason: "error" };
    return { ok: true, alreadyInitialized: row.already_initialized, itemCount: row.item_count };
  } catch {
    return { ok: false, reason: "error" };
  }
}

// ------------------------------------------------------------------ create

/**
 * `not_found` is about the WEDDING (missing or not a member: callers 404).
 * `item_not_found` means the wedding is accessible but the item isn't in it,
 * e.g. a partner deleted it a moment ago.
 */
export type MutationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: ChecklistDenial | "invalid" | "item_not_found" }>;

/** check_violation: the database rejected the values (blank title, bad timing…). */
const CHECK_VIOLATION = "23514";

function failure(code: string | undefined): MutationResult {
  if (code === CHECK_VIOLATION) return { ok: false, reason: "invalid" };
  if (code === "42501") return { ok: false, reason: "forbidden" };
  return { ok: false, reason: "error" };
}

/**
 * Adds a custom item at the end of the list. Only content columns are sent:
 * status starts pending, and ordering/provenance are set by the database.
 */
export async function createChecklistItem(
  supabase: Client,
  weddingId: string,
  input: ChecklistItemInput,
): Promise<MutationResult> {
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) return { ok: false, reason: access.reason };

  try {
    const { error } = await supabase.from("checklist_items").insert({
      wedding_id: access.access.weddingId,
      title: input.title,
      description: input.description,
      category: input.category,
      ...timingToColumns(input.timing),
    });
    return error ? failure(error.code) : { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}

// ---------------------------------------------------------- update, delete

/**
 * Runs an item mutation scoped to (authorized wedding, item id). Zero
 * affected rows means the item doesn't exist in this wedding.
 */
async function mutateItem(
  supabase: Client,
  weddingId: string,
  itemId: string,
  run: (
    access: WeddingAccess,
  ) => PromiseLike<{ data: { id: string }[] | null; error: { code: string } | null }>,
): Promise<MutationResult> {
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) return { ok: false, reason: access.reason };
  if (!UUID_PATTERN.test(itemId)) return { ok: false, reason: "item_not_found" };

  try {
    const { data, error } = await run(access.access);
    if (error) return failure(error.code);
    if (!data || data.length === 0) return { ok: false, reason: "item_not_found" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/** Edits an item's content and timing (template copies are as editable as custom items). */
export function updateChecklistItem(
  supabase: Client,
  weddingId: string,
  itemId: string,
  input: ChecklistItemInput,
): Promise<MutationResult> {
  return mutateItem(supabase, weddingId, itemId, (access) =>
    supabase
      .from("checklist_items")
      .update({
        title: input.title,
        description: input.description,
        category: input.category,
        ...timingToColumns(input.timing),
      })
      .eq("id", itemId)
      .eq("wedding_id", access.weddingId)
      .select("id"),
  );
}

/**
 * Changes an item's status. Only `status` is sent: the database stamps
 * (or clears) completed_at / completed_by itself.
 */
export function setChecklistItemStatus(
  supabase: Client,
  weddingId: string,
  itemId: string,
  status: ChecklistStatus,
): Promise<MutationResult> {
  return mutateItem(supabase, weddingId, itemId, (access) =>
    supabase
      .from("checklist_items")
      .update({ status })
      .eq("id", itemId)
      .eq("wedding_id", access.weddingId)
      .select("id"),
  );
}

/** Deletes an item for good (no soft delete in LB-05). */
export function deleteChecklistItem(
  supabase: Client,
  weddingId: string,
  itemId: string,
): Promise<MutationResult> {
  return mutateItem(supabase, weddingId, itemId, (access) =>
    supabase
      .from("checklist_items")
      .delete()
      .eq("id", itemId)
      .eq("wedding_id", access.weddingId)
      .select("id"),
  );
}
