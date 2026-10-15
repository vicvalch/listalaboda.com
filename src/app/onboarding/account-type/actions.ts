"use server";

import { redirect } from "next/navigation";

import { accountTypeOnboardingPath, afterAccountTypePath, parseAccountType } from "@/lib/accounts/account-type";
import { selectAccountType } from "@/lib/accounts/service";
import { requireUser } from "@/lib/auth/session";
import { formText, type FormState } from "@/lib/forms/result";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type AccountTypeState = FormState<"accountType"> | null;

/**
 * Chooses the signed-in user's account type, once (ACCOUNT-01, ADR-020).
 * Identity is `auth.getUser()` and the database writes only `auth.uid()`'s
 * row: the form sends the type and a continuation, never a user id.
 *
 * - no or unknown type → stays on the page with a field error
 * - chosen (or the same type again) → continues
 * - already chosen differently (e.g. in another tab) → nothing changes; the
 *   stored type stands and the user continues with it, routed by `/app`
 * - any other failure → stays on the page with a retryable error
 */
export async function selectAccountTypeAction(
  _prev: AccountTypeState,
  formData: FormData,
): Promise<AccountTypeState> {
  const next = afterAccountTypePath(formText(formData, "next"));
  await requireUser(accountTypeOnboardingPath(next));
  const { accountType: copy, common } = getMessages();

  const requested = parseAccountType(formText(formData, "accountType"));
  if (!requested) return { ok: false, fieldErrors: { accountType: copy.required } };

  const result = await selectAccountType(await createSupabaseServerClient(), requested);
  if (!result.ok) {
    if (result.reason === "unauthenticated") await requireUser(accountTypeOnboardingPath(next));
    // Outside any try/catch: redirect() throws Next's control-flow signal.
    if (result.reason === "already_selected") redirect(next);
    return { ok: false, formError: common.unexpectedError, values: { accountType: requested } };
  }

  redirect(next);
}
