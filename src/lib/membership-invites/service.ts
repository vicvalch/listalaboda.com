import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { requireWeddingRole, type WeddingRole } from "@/lib/authz/wedding";
import {
  generateMembershipInviteToken,
  hashMembershipInviteToken,
  isWellFormedMembershipInviteToken,
  membershipInviteExpiresAt,
} from "@/lib/membership-invites/token";
import type { InviteInput } from "@/lib/membership-invites/validation";
import type { Database } from "@/lib/supabase/database.types";

/**
 * MembershipInvite application layer: create, list, revoke, accept.
 *
 * Every function takes the current user's RLS-bound client. Authorization
 * goes through `@/lib/authz/wedding` first; RLS and column grants are the
 * backstop. The plaintext token exists only in this module's return value
 * (to build the one link shown to the owner) and is never logged, stored or
 * echoed in errors.
 */

type Client = SupabaseClient<Database>;

/** Path of an invite link. The token travels in the path, never a query. */
export function invitePath(token: string): string {
  return `/invite/${token}`;
}

// ------------------------------------------------------------------ create

export type CreateInviteResult =
  | Readonly<{ ok: true; inviteUrl: string }>
  | Readonly<{ ok: false; reason: "unauthenticated" | "not_found" | "forbidden" | "error" }>;

export async function createMembershipInvite(
  supabase: Client,
  weddingId: string,
  input: InviteInput,
  origin: string,
  now: Date = new Date(),
): Promise<CreateInviteResult> {
  const access = await requireWeddingRole(supabase, weddingId, ["owner"]);
  if (!access.ok) return { ok: false, reason: access.reason };

  const { token, tokenHash } = generateMembershipInviteToken();
  try {
    // Only columns the owner may supply. created_by defaults to auth.uid();
    // acceptance/revocation state isn't insertable. No `.select()`: the row
    // (and token_hash, which isn't readable anyway) is not read back.
    const { error } = await supabase.from("membership_invites").insert({
      wedding_id: access.access.weddingId,
      token_hash: tokenHash,
      intended_role: input.role,
      email: input.email,
      expires_at: membershipInviteExpiresAt(now).toISOString(),
    });
    if (error) return { ok: false, reason: error.code === "42501" ? "forbidden" : "error" };
  } catch {
    return { ok: false, reason: "error" };
  }

  return { ok: true, inviteUrl: new URL(invitePath(token), origin).toString() };
}

// -------------------------------------------------------------------- list

export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

export type InviteSummary = Readonly<{
  id: string;
  email: string | null;
  role: WeddingRole;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
}>;

export function inviteStatus(
  invite: { accepted_at: string | null; revoked_at: string | null; expires_at: string },
  now: Date = new Date(),
): InviteStatus {
  if (invite.accepted_at) return "accepted";
  if (invite.revoked_at) return "revoked";
  if (new Date(invite.expires_at).getTime() <= now.getTime()) return "expired";
  return "pending";
}

/** Owner-only list (RLS returns nothing to others). Never selects token_hash. */
export async function listMembershipInvites(
  supabase: Client,
  weddingId: string,
  now: Date = new Date(),
): Promise<InviteSummary[] | null> {
  try {
    const { data, error } = await supabase
      .from("membership_invites")
      .select("id, email, intended_role, created_at, expires_at, accepted_at, revoked_at")
      .eq("wedding_id", weddingId)
      .order("created_at", { ascending: false });
    if (error || !data) return null;
    return data.map((invite) => ({
      id: invite.id,
      email: invite.email,
      role: invite.intended_role,
      status: inviteStatus(invite, now),
      createdAt: invite.created_at,
      expiresAt: invite.expires_at,
    }));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ revoke

export type RevokeInviteResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: "unauthenticated" | "not_found" | "forbidden" | "error" }>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Revokes a pending invite. Only `revoked_at` is sent (the only updatable
 * column); the database stamps its own clock and refuses to reopen or
 * revoke accepted invites.
 */
export async function revokeMembershipInvite(
  supabase: Client,
  weddingId: string,
  inviteId: string,
): Promise<RevokeInviteResult> {
  const access = await requireWeddingRole(supabase, weddingId, ["owner"]);
  if (!access.ok) return { ok: false, reason: access.reason };
  if (!UUID_PATTERN.test(inviteId)) return { ok: false, reason: "not_found" };

  try {
    const { data, error } = await supabase
      .from("membership_invites")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", inviteId)
      .eq("wedding_id", access.access.weddingId)
      .is("revoked_at", null)
      .is("accepted_at", null)
      .select("id");
    if (error) return { ok: false, reason: "error" };
    if (!data || data.length === 0) return { ok: false, reason: "not_found" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}

// ------------------------------------------------------------------ accept

export type AcceptInviteResult =
  | Readonly<{ ok: true; weddingId: string; role: WeddingRole; alreadyMember: boolean }>
  /**
   * `invalid`: malformed, unknown, expired, revoked, used or bound to another
   * email — deliberately indistinguishable. `unauthenticated`: no session.
   * `error`: transient/unexpected; the handoff may be retried.
   */
  | Readonly<{ ok: false; reason: "invalid" | "unauthenticated" | "error" }>;

const INVITE_INVALID_CODE = "P0001";
const INVITE_INVALID_MESSAGE = "membership_invite_invalid";

/**
 * Accepts an invite for the signed-in user. The token is shape-checked and
 * hashed here; the RPC receives only the hash and derives the user from the
 * session (no user id, no role is sent). Malformed tokens never reach the
 * database.
 */
export async function acceptMembershipInvite(
  supabase: Client,
  token: string,
): Promise<AcceptInviteResult> {
  if (!isWellFormedMembershipInviteToken(token)) return { ok: false, reason: "invalid" };

  try {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) return { ok: false, reason: "unauthenticated" };

    const { data, error } = await supabase.rpc("accept_membership_invite", {
      invite_token_hash: hashMembershipInviteToken(token),
    });
    if (error) {
      if (error.code === INVITE_INVALID_CODE && error.message === INVITE_INVALID_MESSAGE) {
        return { ok: false, reason: "invalid" };
      }
      if (error.code === "42501") return { ok: false, reason: "unauthenticated" };
      return { ok: false, reason: "error" };
    }

    const row = data?.[0];
    if (!row || !UUID_PATTERN.test(row.wedding_id)) return { ok: false, reason: "error" };
    return {
      ok: true,
      weddingId: row.wedding_id,
      role: row.role,
      alreadyMember: row.already_member,
    };
  } catch {
    return { ok: false, reason: "error" };
  }
}
