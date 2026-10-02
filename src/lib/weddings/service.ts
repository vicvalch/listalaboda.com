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
      reason: "invalid_name" | "invalid_date" | "unauthenticated" | "error";
    }>;

/**
 * Creates the wedding through the LB-03 `create_wedding` RPC, which inserts
 * the wedding and the caller's owner membership atomically for `auth.uid()`.
 * No user id, owner or role is sent: the database derives them.
 */
export async function createWedding(
  supabase: Client,
  input: WeddingInput,
): Promise<CreateWeddingResult> {
  try {
    const { data, error } = await supabase.rpc("create_wedding", {
      wedding_name: input.name,
      ...(input.weddingDate ? { wedding_date: input.weddingDate } : {}),
    });
    if (error) {
      // check_violation: blank or over-long name (the only CHECKs involved).
      if (error.code === "23514") return { ok: false, reason: "invalid_name" };
      // invalid_datetime_format / datetime_field_overflow.
      if (error.code === "22007" || error.code === "22008") {
        return { ok: false, reason: "invalid_date" };
      }
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
      supabase.from("weddings").select("id, name, wedding_date").eq("id", weddingId).maybeSingle(),
      supabase.from("wedding_memberships").select("role").eq("wedding_id", weddingId),
    ]);
    if (wedding.error || !wedding.data || memberships.error || !memberships.data) return null;

    const memberCounts: Record<WeddingRole, number> = { owner: 0, collaborator: 0 };
    for (const { role } of memberships.data) memberCounts[role] += 1;

    return {
      id: wedding.data.id,
      name: wedding.data.name,
      weddingDate: wedding.data.wedding_date,
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
        | "error";
    }>;

/**
 * Owner-only edit of the wedding's name and date (Constitution §3). The
 * owner role is checked server-side first; RLS (`weddings_update_owner`) and
 * the column grant (name, wedding_date only) are the backstop. A null date
 * clears it. Checklist items are never touched: relative items derive their
 * dates from the current wedding date when read.
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
      .update({ name: input.name, wedding_date: input.weddingDate })
      .eq("id", access.access.weddingId)
      .select("id");
    if (error) {
      if (error.code === "23514") return { ok: false, reason: "invalid_name" };
      if (error.code === "22007" || error.code === "22008") {
        return { ok: false, reason: "invalid_date" };
      }
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
