import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import { accountTypeOnboardingPath, type AccountType } from "@/lib/accounts/account-type";
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
 * guess. Every `/app` page goes through the `/app` layout, which calls this;
 * pages and actions that depend on the type call it again (memoized).
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
