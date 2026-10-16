"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { normalizeRecoveryVerifyError } from "@/lib/auth/errors";
import { forgotPasswordPath, isWellFormedRecoveryTokenHash, RESET_PASSWORD_PATH } from "@/lib/auth/recovery";
import { RECOVERY_TOKEN_COOKIE, clearedRecoveryTokenCookieOptions } from "@/lib/auth/recovery-handoff";
import type { FormState } from "@/lib/forms/result";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type ConfirmRecoveryState = FormState<never> | null;

/**
 * The explicit "Continuar" (AUTH-RECOVERY-02): the ONLY step that consumes
 * the emailed recovery token. Takes no form input at all: the token comes
 * only from the httpOnly handoff cookie (a field or query value is never
 * read), and the type is fixed here. `verifyOtp` runs once; on success the
 * SSR client sets the session cookies and the reset page's own gate (the
 * signed claim) decides what follows.
 *
 * Cookie cleanup: cleared on success and on any definitive refusal
 * (expired, used, unknown, malformed). Kept on a limit or a failure on our
 * side (the token may still be good), so the person can press again within
 * the cookie's 15 minutes. No retries here; nothing is logged.
 */
export async function confirmRecoveryAction(): Promise<ConfirmRecoveryState> {
  const cookieStore = await cookies();
  const tokenHash = cookieStore.get(RECOVERY_TOKEN_COOKIE)?.value;
  const forget = () => cookieStore.set(RECOVERY_TOKEN_COOKIE, "", clearedRecoveryTokenCookieOptions());

  if (!isWellFormedRecoveryTokenHash(tokenHash)) {
    forget();
    redirect(forgotPasswordPath(undefined, "link"));
  }

  let outcome: "verified" | "invalid" | { retry: string };
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" });
    if (error) {
      const normalized = normalizeRecoveryVerifyError(error);
      outcome = normalized.kind === "invalid" ? "invalid" : { retry: normalized.message };
    } else {
      outcome = data.session ? "verified" : "invalid";
    }
  } catch {
    outcome = { retry: getMessages().auth.recoveryConfirm.retry };
  }

  if (outcome === "verified") {
    forget();
    redirect(RESET_PASSWORD_PATH);
  }
  if (outcome === "invalid") {
    forget();
    redirect(forgotPasswordPath(undefined, "link"));
  }
  return { ok: false, formError: outcome.retry };
}
