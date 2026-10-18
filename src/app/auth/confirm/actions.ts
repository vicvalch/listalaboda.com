"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { normalizeSignupVerifyError } from "@/lib/auth/errors";
import { safeNextPath } from "@/lib/auth/redirect";
import { isWellFormedSignupTokenHash, signupConfirmFailurePath } from "@/lib/auth/signup-confirmation";
import { SIGNUP_TOKEN_COOKIE, clearedSignupTokenCookieOptions } from "@/lib/auth/signup-confirmation-handoff";
import { formText, type FormState } from "@/lib/forms/result";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type ConfirmSignupState = FormState<never> | null;

/**
 * The explicit "Confirmar mi cuenta" (Batch 3): the ONLY step that consumes
 * the emailed signup token. The token comes only from the httpOnly handoff
 * cookie (a field or query value is never read as one) and the type is fixed
 * here; the form carries only the continuation, validated again. `verifyOtp`
 * runs once; on success the SSR client sets the session cookies and the
 * continuation's own guards decide what follows (`/app` → the account-type
 * choice for a new account, `/invite/continue` → the pending invite).
 *
 * A definitive refusal (used, replaced by a newer email, expired, unknown)
 * goes to the login page with the same guidance whatever the account's state;
 * someone already signed in there just continues. Cookie cleanup: cleared on
 * success and on a refusal, kept on a limit or a failure on our side (the
 * token may still be good). No retries here; nothing is logged.
 */
export async function confirmSignupAction(_prev: ConfirmSignupState, formData: FormData): Promise<ConfirmSignupState> {
  const next = safeNextPath(formText(formData, "next"));
  const cookieStore = await cookies();
  const tokenHash = cookieStore.get(SIGNUP_TOKEN_COOKIE)?.value;
  const forget = () => cookieStore.set(SIGNUP_TOKEN_COOKIE, "", clearedSignupTokenCookieOptions());

  if (!isWellFormedSignupTokenHash(tokenHash)) {
    forget();
    redirect(signupConfirmFailurePath(next));
  }

  let outcome: "verified" | "invalid" | { retry: string };
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "email" });
    if (error) {
      const normalized = normalizeSignupVerifyError(error);
      outcome = normalized.kind === "invalid" ? "invalid" : { retry: normalized.message };
    } else {
      outcome = data.session ? "verified" : "invalid";
    }
  } catch {
    outcome = { retry: getMessages().auth.signupConfirm.retry };
  }

  // Outside the try/catch: redirect() throws Next's control-flow signal.
  if (outcome === "verified") {
    forget();
    redirect(next);
  }
  if (outcome === "invalid") {
    forget();
    redirect(signupConfirmFailurePath(next));
  }
  return { ok: false, formError: outcome.retry };
}
