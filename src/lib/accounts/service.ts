import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { parseAccountType, type AccountType } from "@/lib/accounts/account-type";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The account type, read and chosen as the current user through their own
 * RLS-bound client (ACCOUNT-01, ADR-020). No user id is ever sent to the
 * database for the choice: `select_account_type` acts on auth.uid().
 */

type Client = SupabaseClient<Database>;

/**
 * The user's account type, null when not chosen yet (no row), or
 * `undefined` when the read failed: callers must never read a failure as
 * "not chosen" (that would ask again) nor as a type.
 */
export async function getAccountType(supabase: Client, userId: string): Promise<AccountType | null | undefined> {
  try {
    const { data, error } = await supabase
      .from("user_accounts")
      .select("account_type")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return undefined;
    if (!data) return null;
    return parseAccountType(data.account_type) ?? undefined;
  } catch {
    return undefined;
  }
}

export type SelectAccountTypeResult =
  | Readonly<{ ok: true; accountType: AccountType }>
  | Readonly<{ ok: false; reason: "already_selected" | "unauthenticated" | "error" }>;

/**
 * Chooses the caller's account type once. The same type again succeeds
 * (idempotent); the other type is `already_selected` and changes nothing.
 */
export async function selectAccountType(supabase: Client, requested: AccountType): Promise<SelectAccountTypeResult> {
  try {
    const { data, error } = await supabase.rpc("select_account_type", { requested });
    if (error) {
      if (error.code === "55000" && error.message === "account_type_already_selected") {
        return { ok: false, reason: "already_selected" };
      }
      if (error.code === "42501") return { ok: false, reason: "unauthenticated" };
      return { ok: false, reason: "error" };
    }
    const accountType = parseAccountType(data);
    return accountType ? { ok: true, accountType } : { ok: false, reason: "error" };
  } catch {
    return { ok: false, reason: "error" };
  }
}
