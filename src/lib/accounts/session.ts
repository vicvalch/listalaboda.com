import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import { accountTypeOnboardingPath, type AccountType } from "@/lib/accounts/account-type";
import { isRecentInviteJoin, weddingIdOfAppPath } from "@/lib/accounts/invite-entry";
import { getAccountType } from "@/lib/accounts/service";
import { requireUser, type CurrentUser } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The signed-in user's account type for Server Components and Server Actions
 * (ACCOUNT-01, ADR-020). Memoized per server render, like `getCurrentUser`,
 * so the `/app` layout and its page share one read.
 *
 * `undefined` = the read failed. Never treated as "not chosen" (that would
 * ask an already-typed user again) or as a type.
 */
export const getCurrentAccountType = cache(async (userId: string): Promise<AccountType | null | undefined> => {
  return getAccountType(await createSupabaseServerClient(), userId);
});

export class AccountTypeUnavailableError extends Error {
  constructor() {
    super("account_type_unavailable");
    this.name = "AccountTypeUnavailableError";
  }
}

/**
 * The validated user and their account type. Not signed in → /login; no
 * account type yet → the onboarding page (both carrying `next`, re-validated
 * there). A failed read throws: nothing is inferred and nothing routes on a
 * guess. Every `/app` page goes through the `/app` layout, which applies the
 * same rule (`requireAppEntry`, with the SIT-01 invite exception); pages and
 * actions that depend on the type call this (memoized).
 */
export async function requireAccountType(
  next?: string,
): Promise<Readonly<{ user: CurrentUser; accountType: AccountType }>> {
  const user = await requireUser(next);
  const accountType = await getCurrentAccountType(user.id);
  if (accountType === undefined) throw new AccountTypeUnavailableError();
  if (accountType === null) redirect(accountTypeOnboardingPath(next));
  return { user, accountType };
}

/**
 * Whether this untyped account just joined this wedding through an invite
 * (SIT-01, `@/lib/accounts/invite-entry`): its own membership row, read on
 * its RLS client, created within the invite window. A failed or empty read
 * is "no" (the normal choice applies).
 */
const joinedThroughRecentInvite = cache(async (userId: string, weddingId: string): Promise<boolean> => {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("wedding_memberships")
      .select("created_at")
      .eq("wedding_id", weddingId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return false;
    return isRecentInviteJoin(data.created_at, Date.now());
  } catch {
    return false;
  }
});

/**
 * `requireAccountType` for the `/app` shell: the same, except that an
 * account without a type may open the wedding it has just joined through
 * an invite (SIT-01). `accountType` is then null (nothing planner- or
 * couple-specific is offered). Any other `/app` path, or that wedding once
 * the window has passed, still goes to the one-time choice.
 */
export async function requireAppEntry(
  requestedPath: string,
): Promise<Readonly<{ user: CurrentUser; accountType: AccountType | null }>> {
  const user = await requireUser(requestedPath);
  const accountType = await getCurrentAccountType(user.id);
  if (accountType === undefined) throw new AccountTypeUnavailableError();
  if (accountType !== null) return { user, accountType };
  const weddingId = weddingIdOfAppPath(requestedPath);
  if (weddingId && (await joinedThroughRecentInvite(user.id, weddingId))) return { user, accountType: null };
  redirect(accountTypeOnboardingPath(requestedPath));
}

/**
 * The same rule for one wedding, for the wedding layout: client navigation
 * between weddings doesn't re-render the `/app` shell, so entering another
 * wedding is checked here again. Typed accounts pass unchanged.
 */
export async function requireWeddingEntry(
  userId: string,
  weddingId: string,
  requestedPath: string,
): Promise<AccountType | null> {
  const accountType = await getCurrentAccountType(userId);
  if (accountType === undefined) throw new AccountTypeUnavailableError();
  if (accountType !== null) return accountType;
  const id = weddingIdOfAppPath(`/app/weddings/${weddingId}`);
  if (id && (await joinedThroughRecentInvite(userId, id))) return null;
  redirect(accountTypeOnboardingPath(requestedPath));
}
