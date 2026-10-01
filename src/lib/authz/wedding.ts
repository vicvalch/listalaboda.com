import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

/**
 * Server-side wedding authorization (ADR-002 §3). The one place that answers
 * "may the current user act on this wedding, and as what role?".
 *
 * - Identity comes from `auth.getUser()`, which validates the session with
 *   the Auth server; never from client input or `user_metadata`.
 * - The role comes from the database (`wedding_memberships`), read as the
 *   user, so RLS is the backstop if this module is ever wrong.
 * - A client-supplied wedding id is only a lookup key.
 * - Anything unexpected denies.
 *
 * Denial reasons are chosen so callers can avoid leaking existence
 * (ADR-002 §8): a missing wedding, a wedding the user doesn't belong to and a
 * malformed id are all `not_found`. Only an actual member lacking the
 * required role gets `forbidden`; they already know the wedding exists.
 * Callers should map `not_found` (and `error`) to a 404-equivalent.
 */

export type WeddingRole = Database["public"]["Enums"]["wedding_role"];

export type WeddingAccess = Readonly<{
  weddingId: string;
  userId: string;
  role: WeddingRole;
}>;

export type WeddingAccessDenial =
  | "unauthenticated"
  | "not_found"
  | "forbidden"
  | "error";

export type WeddingAccessResult =
  | Readonly<{ ok: true; access: WeddingAccess }>
  | Readonly<{ ok: false; reason: WeddingAccessDenial }>;

type WeddingAuthzClient = SupabaseClient<Database>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WEDDING_ROLES: readonly WeddingRole[] = ["owner", "collaborator"];

function deny(reason: WeddingAccessDenial): WeddingAccessResult {
  return { ok: false, reason };
}

/** The current user is a member (any role) of the wedding. */
export async function requireWeddingMembership(
  supabase: WeddingAuthzClient,
  weddingId: string,
): Promise<WeddingAccessResult> {
  return requireWeddingRole(supabase, weddingId, WEDDING_ROLES);
}

/** The current user holds one of `allowedRoles` in the wedding. */
export async function requireWeddingRole(
  supabase: WeddingAuthzClient,
  weddingId: string,
  allowedRoles: readonly WeddingRole[],
): Promise<WeddingAccessResult> {
  try {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      return deny("unauthenticated");
    }
    const userId = userData.user.id;

    if (!UUID_PATTERN.test(weddingId)) {
      return deny("not_found");
    }

    const { data, error } = await supabase
      .from("wedding_memberships")
      .select("role")
      .eq("wedding_id", weddingId)
      .eq("user_id", userId)
      .limit(1);
    if (error || !data) {
      return deny("error");
    }

    const role = data[0]?.role;
    if (!role || !WEDDING_ROLES.includes(role)) {
      return deny("not_found");
    }
    if (!allowedRoles.includes(role)) {
      return deny("forbidden");
    }

    return { ok: true, access: { weddingId, userId, role } };
  } catch {
    return deny("error");
  }
}
