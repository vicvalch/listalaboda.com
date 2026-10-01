import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { WeddingInput } from "@/lib/weddings/validation";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Wedding reads and creation for the current user, through their own
 * RLS-bound client. Access to a wedding comes only from membership (RLS);
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
