import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  requireWeddingMembership,
  requireWeddingRole,
  type WeddingAccess,
} from "@/lib/authz/wedding";
import type { WeddingMember } from "@/lib/weddings/members";
import type { WeddingInput } from "@/lib/weddings/validation";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Wedding reads, creation and owner settings for the current user, through
 * their own RLS-bound client. Access to a wedding comes only from membership (RLS);
 * `weddings.created_by` is provenance and is never used here.
 */

type Client = SupabaseClient<Database>;
type WeddingRole = Database["public"]["Enums"]["wedding_role"];

export type WeddingSummary = Readonly<{
  id: string;
  name: string;
  weddingDate: string | null;
  role: WeddingRole;
}>;

export type CreateWeddingResult =
  | Readonly<{ ok: true; weddingId: string }>
  | Readonly<{
      ok: false;
      reason:
        | "invalid_name"
        | "invalid_date"
        | "invalid_city"
        | "invalid_time_zone"
        | "unauthenticated"
        | "error";
    }>;

type WeddingWriteError = Readonly<{ code?: string; message?: string }>;

/**
 * Which wedding field the database rejected, from Postgres error codes and
 * our own constraint/exception names. Never shown to the user: callers map
 * it to catalog copy.
 */
function weddingFieldError(
  error: WeddingWriteError,
): "invalid_name" | "invalid_date" | "invalid_city" | "invalid_time_zone" | null {
  // check_violation: weddings_city_valid, or the name CHECKs.
  if (error.code === "23514") {
    return error.message?.includes("weddings_city_valid") ? "invalid_city" : "invalid_name";
  }
  // invalid_parameter_value from private.validate_wedding_time_zone.
  if (error.code === "22023" && error.message === "invalid_time_zone") return "invalid_time_zone";
  // invalid_datetime_format / datetime_field_overflow.
  if (error.code === "22007" || error.code === "22008") return "invalid_date";
  return null;
}

/**
 * Creates the wedding through the `create_wedding` RPC, which inserts the
 * wedding (name, optional date, city and time zone) and the caller's owner
 * membership atomically for `auth.uid()`. No user id, owner or role is
 * sent: the database derives them. An invalid city or zone leaves nothing.
 */
export async function createWedding(
  supabase: Client,
  input: WeddingInput,
): Promise<CreateWeddingResult> {
  try {
    const { data, error } = await supabase.rpc("create_wedding", {
      wedding_name: input.name,
      ...(input.weddingDate ? { wedding_date: input.weddingDate } : {}),
      ...(input.city ? { wedding_city: input.city } : {}),
      ...(input.timeZone ? { wedding_time_zone: input.timeZone } : {}),
    });
    if (error) {
      const field = weddingFieldError(error);
      if (field) return { ok: false, reason: field };
      if (error.code === "42501") return { ok: false, reason: "unauthenticated" };
      return { ok: false, reason: "error" };
    }
    if (!data?.id) return { ok: false, reason: "error" };
    return { ok: true, weddingId: data.id };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/**
 * Every wedding the user belongs to (RLS decides visibility), with their
 * role. Returns null on failure so callers can show an error instead of a
 * misleading empty state.
 */
export async function listMyWeddings(
  supabase: Client,
  userId: string,
): Promise<WeddingSummary[] | null> {
  try {
    const { data, error } = await supabase
      .from("wedding_memberships")
      .select("role, weddings(id, name, wedding_date)")
      .eq("user_id", userId);
    if (error || !data) return null;

    return data
      .flatMap((row) =>
        row.weddings
          ? [
              {
                id: row.weddings.id,
                name: row.weddings.name,
                weddingDate: row.weddings.wedding_date,
                role: row.role,
              },
            ]
          : [],
      )
      .sort(compareWeddings);
  } catch {
    return null;
  }
}

/** Dated weddings first (soonest first), then undated, then by name. */
function compareWeddings(a: WeddingSummary, b: WeddingSummary): number {
  if (a.weddingDate && b.weddingDate && a.weddingDate !== b.weddingDate) {
    return a.weddingDate < b.weddingDate ? -1 : 1;
  }
  if (a.weddingDate && !b.weddingDate) return -1;
  if (!a.weddingDate && b.weddingDate) return 1;
  return a.name.localeCompare(b.name, "es");
}

export type WeddingDetail = Readonly<{
  id: string;
  name: string;
  weddingDate: string | null;
  city: string | null;
  /** IANA zone, or null: no wedding-local "today", so nothing is overdue. */
  timeZone: string | null;
  memberCounts: Readonly<Record<WeddingRole, number>>;
}>;

/**
 * Wedding details for a member. Call only after `requireWeddingMembership`
 * succeeded; RLS still returns nothing to a non-member. Member identities
 * (emails) are not exposed by the schema, so only role counts are shown.
 */
export async function getWeddingDetail(
  supabase: Client,
  weddingId: string,
): Promise<WeddingDetail | null> {
  try {
    const [wedding, memberships] = await Promise.all([
      supabase
        .from("weddings")
        .select("id, name, wedding_date, city, time_zone")
        .eq("id", weddingId)
        .maybeSingle(),
      supabase.from("wedding_memberships").select("role").eq("wedding_id", weddingId),
    ]);
    if (wedding.error || !wedding.data || memberships.error || !memberships.data) return null;

    const memberCounts: Record<WeddingRole, number> = { owner: 0, collaborator: 0 };
    for (const { role } of memberships.data) memberCounts[role] += 1;

    return {
      id: wedding.data.id,
      name: wedding.data.name,
      weddingDate: wedding.data.wedding_date,
      city: wedding.data.city,
      timeZone: wedding.data.time_zone,
      memberCounts,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- settings

export type UpdateWeddingSettingsResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      reason:
        | "unauthenticated"
        | "not_found"
        | "forbidden"
        | "invalid_name"
        | "invalid_date"
        | "invalid_city"
        | "invalid_time_zone"
        | "error";
    }>;

/**
 * Owner-only edit of the wedding's name, date, city and time zone
 * (Constitution §3). The owner role is checked server-side first; RLS
 * (`weddings_update_owner`), the column grant (name, wedding_date, city,
 * time_zone only), the city CHECK and the time-zone trigger are the
 * backstop. Null clears the date, city or zone. Checklist items are never
 * touched: relative dates and overdue state are derived when read.
 */
export async function updateWeddingSettings(
  supabase: Client,
  weddingId: string,
  input: WeddingInput,
): Promise<UpdateWeddingSettingsResult> {
  const access = await requireWeddingRole(supabase, weddingId, ["owner"]);
  if (!access.ok) return { ok: false, reason: access.reason };

  try {
    const { data, error } = await supabase
      .from("weddings")
      .update({
        name: input.name,
        wedding_date: input.weddingDate,
        city: input.city,
        time_zone: input.timeZone,
      })
      .eq("id", access.access.weddingId)
      .select("id");
    if (error) {
      const field = weddingFieldError(error);
      if (field) return { ok: false, reason: field };
      if (error.code === "42501") return { ok: false, reason: "forbidden" };
      return { ok: false, reason: "error" };
    }
    // No row: the wedding vanished or the role changed since the check.
    if (!data || data.length === 0) return { ok: false, reason: "not_found" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}

// ----------------------------------------------------------------- members

/**
 * The wedding's current members, safe fields only: membership id, role,
 * the name each member chose for this wedding, and whether it is the caller
 * (by the caller's own membership id from the access check, never by input).
 * No user ids, emails or auth data. Pending invites are not members and are
 * not listed. Takes the `WeddingAccess` from a successful membership check,
 * so it can't run before one. Returns null on failure.
 */
export async function listWeddingMembers(
  supabase: Client,
  access: WeddingAccess,
): Promise<WeddingMember[] | null> {
  try {
    const { data, error } = await supabase
      .from("wedding_memberships")
      .select("id, role, display_name, created_at")
      .eq("wedding_id", access.weddingId);
    if (error || !data) return null;
    return data.map((row) => ({
      membershipId: row.id,
      role: row.role,
      displayName: row.display_name,
      isCurrentUser: row.id === access.membershipId,
      joinedAt: row.created_at,
    }));
  } catch {
    return null;
  }
}

export type UpdateDisplayNameResult =
  | Readonly<{ ok: true; displayName: string | null }>
  | Readonly<{ ok: false; reason: "unauthenticated" | "not_found" | "invalid" | "error" }>;

/**
 * Sets how the CALLER appears in this wedding (null clears it). There is no
 * way to name whose membership to change: the `set_wedding_display_name`
 * RPC only updates auth.uid()'s own membership, so an owner can't rename
 * anyone else either. Any member may do it; it is not wedding settings.
 */
export async function updateMyDisplayName(
  supabase: Client,
  weddingId: string,
  displayName: string | null,
): Promise<UpdateDisplayNameResult> {
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) {
    return { ok: false, reason: access.reason === "forbidden" ? "error" : access.reason };
  }

  try {
    const { data, error } = await supabase.rpc("set_wedding_display_name", {
      target_wedding_id: access.access.weddingId,
      new_display_name: displayName ?? "",
    });
    if (error) {
      if (error.code === "23514") return { ok: false, reason: "invalid" };
      if (error.message === "wedding_not_found") return { ok: false, reason: "not_found" };
      if (error.code === "42501") return { ok: false, reason: "unauthenticated" };
      return { ok: false, reason: "error" };
    }
    return { ok: true, displayName: data ?? null };
  } catch {
    return { ok: false, reason: "error" };
  }
}

// ---------------------------------------------------------- member removal

export type RemoveMemberResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      reason:
        | "unauthenticated"
        | "not_found"
        | "forbidden"
        | "invalid_target"
        | "cannot_remove_self"
        | "last_owner"
        | "error";
    }>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Owner-only: removes another member from THIS wedding (Constitution §3,
 * §7.12). Removal deletes one `wedding_memberships` row and nothing else:
 * not the auth user, not their memberships in other weddings, not the
 * checklist items they created or completed. Items assigned to them stay
 * and become "Sin asignar" (LB-07 ON DELETE SET NULL). Invites are untouched.
 *
 * `targetMembershipId` is only a lookup key. The caller, their membership
 * and their role come from `requireWeddingRole`; the delete is scoped to the
 * authorized wedding, so another wedding's membership, an unknown id and a
 * malformed one are all `invalid_target`, without saying whether it exists
 * anywhere. (`not_found` means the CALLER has no access to the wedding.) RLS
 * (`wedding_memberships_delete_owner`) and the final-owner trigger are the
 * backstop.
 *
 * There is no "leave wedding" here: the caller's own membership is refused
 * (`cannot_remove_self`), even when the database would allow it.
 */
export async function removeWeddingMember(
  supabase: Client,
  weddingId: string,
  targetMembershipId: string,
): Promise<RemoveMemberResult> {
  const access = await requireWeddingRole(supabase, weddingId, ["owner"]);
  if (!access.ok) return { ok: false, reason: access.reason };
  if (!UUID_PATTERN.test(targetMembershipId)) return { ok: false, reason: "invalid_target" };
  if (targetMembershipId.toLowerCase() === access.access.membershipId.toLowerCase()) {
    return { ok: false, reason: "cannot_remove_self" };
  }

  try {
    const { data, error } = await supabase
      .from("wedding_memberships")
      .delete()
      .eq("id", targetMembershipId)
      .eq("wedding_id", access.access.weddingId)
      .select("id");
    if (error) {
      // The final-owner trigger (only reachable through a race, since the
      // caller is an owner who stays).
      if (error.code === "23514" && error.message === "wedding_must_have_owner") {
        return { ok: false, reason: "last_owner" };
      }
      if (error.code === "42501") return { ok: false, reason: "forbidden" };
      return { ok: false, reason: "error" };
    }
    // No row: not a member of this wedding (any more), or the caller's role
    // changed since the check and RLS filtered the delete.
    if (!data || data.length === 0) return { ok: false, reason: "invalid_target" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}
