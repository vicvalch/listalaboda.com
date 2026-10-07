import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { requireWeddingMembership, type WeddingAccess } from "@/lib/authz/wedding";
import type { SeatingPartyInput, SeatingTableInput } from "@/lib/seating/plan";
import { parseTableInput, type TableInput } from "@/lib/seating/validation";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Seating plan application layer (LB-19, ADR-012): tables and who sits
 * where. Any member of the wedding — owner or collaborator — manages it:
 * seating is shared planning content.
 *
 * Every function takes the current user's RLS-bound client (never the
 * service role) and resolves membership server-side first
 * (`@/lib/authz/wedding`). Ids from the browser are lookup keys only: every
 * write is scoped to the authorized wedding, and the database decides the
 * rest — same-wedding composite FKs, RLS, column grants, and the seating
 * triggers (capacity under a table row lock, capacity reductions, declined
 * guests). Database errors are mapped to a closed set of reasons; raw
 * messages never leave this module.
 *
 * Nothing here touches guests, parties, RSVPs, links, emails or the activity
 * history: seating is a separate domain that only reads the guest list.
 */

type Client = SupabaseClient<Database>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `not_found` is about the WEDDING (missing or not a member: callers 404).
 * `invalid_target` means the wedding is accessible but the table, guest or
 * assignment isn't in it (gone a moment ago, another wedding's, made up):
 * indistinguishably.
 */
export type SeatingFailureReason =
  | "unauthenticated"
  | "not_found"
  | "forbidden"
  | "invalid_input"
  | "invalid_target"
  | "table_full"
  | "capacity_below_assigned"
  | "guest_declined"
  | "already_seated"
  | "database_error";

export type SeatingResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: SeatingFailureReason }>;

type DbError = Readonly<{ code?: string; message?: string }>;

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";

/** Known trigger refusals (all raised as check_violation). */
const TRIGGER_REASONS: Readonly<Record<string, SeatingFailureReason>> = {
  seating_table_full: "table_full",
  seating_capacity_below_assigned: "capacity_below_assigned",
  seating_guest_declined: "guest_declined",
};

/** Maps a database error to a closed reason. Exported for tests. */
export function seatingFailure(error: DbError): SeatingFailureReason {
  switch (error.code) {
    case UNIQUE_VIOLATION:
      // The only unique key a seating write can hit: one table per guest.
      return "already_seated";
    case FOREIGN_KEY_VIOLATION:
      return "invalid_target";
    case CHECK_VIOLATION:
      return (error.message && TRIGGER_REASONS[error.message]) || "invalid_input";
    case INSUFFICIENT_PRIVILEGE:
      return "forbidden";
    default:
      return "database_error";
  }
}

function fail(reason: SeatingFailureReason): SeatingResult {
  return { ok: false, reason };
}

/**
 * Checks membership, then runs one write scoped to the authorized wedding.
 * Zero affected rows means the target isn't in this wedding.
 */
async function mutate(
  supabase: Client,
  weddingId: string,
  targetIds: readonly string[],
  run: (access: WeddingAccess) => PromiseLike<{ data: unknown[] | null; error: DbError | null }>,
): Promise<SeatingResult> {
  const access = await requireWeddingMembership(supabase, weddingId);
  // An unexpected failure resolving membership is a database error.
  if (!access.ok) return fail(access.reason === "error" ? "database_error" : access.reason);
  // A malformed id can't be a table or guest of this wedding.
  if (!targetIds.every((id) => UUID_PATTERN.test(id))) return fail("invalid_target");

  try {
    const { data, error } = await run(access.access);
    if (error) return fail(seatingFailure(error));
    if (!data || data.length === 0) return fail("invalid_target");
    return { ok: true };
  } catch {
    return fail("database_error");
  }
}

// -------------------------------------------------------------------- read

export type SeatingData = Readonly<{
  tables: readonly SeatingTableInput[];
  parties: readonly SeatingPartyInput[];
}>;

function byCreatedThenId(
  a: Readonly<{ created_at: string; id: string }>,
  b: Readonly<{ created_at: string; id: string }>,
): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Everything the seating page needs, in TWO queries (never per table or per
 * guest): the wedding's tables in persisted order, and the guest list with
 * each guest's RSVP answer and table nested. Only ids, labels, names, the
 * attending flag and the table id are read: no contact emails, notes, link
 * state or tokens. Takes the `WeddingAccess` of a successful membership
 * check. Returns null on failure.
 */
export async function getSeatingData(
  supabase: Client,
  access: WeddingAccess,
): Promise<SeatingData | null> {
  try {
    const [tables, parties] = await Promise.all([
      supabase
        .from("seating_tables")
        .select("id, name, capacity")
        .eq("wedding_id", access.weddingId)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true })
        .order("id", { ascending: true }),
      supabase
        .from("guest_invitations")
        .select("id, label, created_at, guests(id, name, created_at, rsvps(attending), seating_assignments(seating_table_id))")
        .eq("wedding_id", access.weddingId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true }),
    ]);
    if (tables.error || !tables.data || parties.error || !parties.data) return null;

    return {
      tables: tables.data.map((table) => ({ id: table.id, name: table.name, capacity: table.capacity })),
      parties: parties.data.map((party) => ({
        id: party.id,
        label: party.label,
        guests: [...party.guests].sort(byCreatedThenId).map((guest) => ({
          id: guest.id,
          name: guest.name,
          attending: guest.rsvps[0]?.attending ?? null,
          tableId: guest.seating_assignments[0]?.seating_table_id ?? null,
        })),
      })),
    };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ tables

/**
 * Adds a table at the end of the wedding's list. Only the name and capacity
 * are sent: ordering and provenance come from the database.
 */
export async function createSeatingTable(
  supabase: Client,
  weddingId: string,
  input: TableInput,
): Promise<SeatingResult> {
  const parsed = parseTableInput({ name: input.name, capacity: String(input.capacity) });
  if (!parsed.ok) return fail("invalid_input");

  return mutate(supabase, weddingId, [], (access) =>
    supabase
      .from("seating_tables")
      .insert({ wedding_id: access.weddingId, name: parsed.input.name, capacity: parsed.input.capacity })
      .select("id"),
  );
}

/**
 * Renames a table and/or changes its capacity. Lowering the capacity below
 * the people already seated there is refused by the database
 * (`capacity_below_assigned`); nobody is unseated.
 */
export async function updateSeatingTable(
  supabase: Client,
  weddingId: string,
  tableId: string,
  input: TableInput,
): Promise<SeatingResult> {
  const parsed = parseTableInput({ name: input.name, capacity: String(input.capacity) });
  if (!parsed.ok) return fail("invalid_input");

  return mutate(supabase, weddingId, [tableId], (access) =>
    supabase
      .from("seating_tables")
      .update({ name: parsed.input.name, capacity: parsed.input.capacity })
      .eq("id", tableId)
      .eq("wedding_id", access.weddingId)
      .select("id"),
  );
}

/** Deletes a table. Its assignments go with it (FK cascade); the guests stay. */
export function deleteSeatingTable(
  supabase: Client,
  weddingId: string,
  tableId: string,
): Promise<SeatingResult> {
  return mutate(supabase, weddingId, [tableId], (access) =>
    supabase
      .from("seating_tables")
      .delete()
      .eq("id", tableId)
      .eq("wedding_id", access.weddingId)
      .select("id"),
  );
}

// ------------------------------------------------------------- assignments

/**
 * Seats an unassigned guest at a table of this wedding. The database refuses
 * a full table (`table_full`), a guest who declined (`guest_declined`), a
 * guest already at a table (`already_seated`) and a guest or table of
 * another wedding (`invalid_target`).
 */
export function seatGuest(
  supabase: Client,
  weddingId: string,
  guestId: string,
  tableId: string,
): Promise<SeatingResult> {
  return mutate(supabase, weddingId, [guestId, tableId], (access) =>
    supabase
      .from("seating_assignments")
      .insert({ guest_id: guestId, wedding_id: access.weddingId, seating_table_id: tableId })
      .select("guest_id"),
  );
}

/**
 * Moves a seated guest to another table. Only the table column is sent; on
 * any refusal the original assignment is unchanged.
 */
export function moveGuest(
  supabase: Client,
  weddingId: string,
  guestId: string,
  tableId: string,
): Promise<SeatingResult> {
  return mutate(supabase, weddingId, [guestId, tableId], (access) =>
    supabase
      .from("seating_assignments")
      .update({ seating_table_id: tableId })
      .eq("guest_id", guestId)
      .eq("wedding_id", access.weddingId)
      .select("guest_id"),
  );
}

/** Removes a guest from their table (any RSVP state, including a guest who declined). */
export function unseatGuest(
  supabase: Client,
  weddingId: string,
  guestId: string,
): Promise<SeatingResult> {
  return mutate(supabase, weddingId, [guestId], (access) =>
    supabase
      .from("seating_assignments")
      .delete()
      .eq("guest_id", guestId)
      .eq("wedding_id", access.weddingId)
      .select("guest_id"),
  );
}
