"use server";

import { redirect } from "next/navigation";

import { getCurrentAccountType } from "@/lib/accounts/session";
import {
  normalizePasswordResetRequestError,
  normalizePasswordUpdateError,
  normalizeSignInError,
  normalizeSignUpError,
} from "@/lib/auth/errors";
import { afterPasswordResetPath, forgotPasswordPath, recoveryNext, recoveryRedirectUrl } from "@/lib/auth/recovery";
import { getRecoveryRedirectOrigin, getRecoveryUser } from "@/lib/auth/recovery-session";
import { safeNextPath } from "@/lib/auth/redirect";
import {
  parseCredentials,
  parseEmail,
  parseNewPassword,
  type CredentialField,
  type NewPasswordField,
} from "@/lib/auth/validation";
import { formText, type FormState } from "@/lib/forms/result";
import { getRequestOrigin } from "@/lib/http/origin";
import { es } from "@/lib/i18n/messages/es";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Sign-in, sign-up and password recovery. All run server-side so the session cookies are set
 * by @supabase/ssr on the response; the browser never handles tokens.
 * Passwords are never logged, returned or echoed back into the form.
 */

export type LoginState = FormState<CredentialField> | null;
export type SignupState = FormState<CredentialField, { confirmationRequired: true }> | null;

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const next = safeNextPath(formText(formData, "next"));
  const parsed = parseCredentials(
    { email: formText(formData, "email"), password: formText(formData, "password") },
    "login",
  );
  const values = { email: formText(formData, "email").trim() };
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors, values };

  let failed: { formError: string } | null = null;
  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signInWithPassword(parsed.credentials);
    if (error) failed = normalizeSignInError(error);
  } catch {
    failed = { formError: es.common.unexpectedError };
  }
  if (failed) return { ok: false, formError: failed.formError, values };

  redirect(next);
}

export async function signupAction(_prev: SignupState, formData: FormData): Promise<SignupState> {
  const next = safeNextPath(formText(formData, "next"));
  const parsed = parseCredentials(
    { email: formText(formData, "email"), password: formText(formData, "password") },
    "signup",
  );
  const values = { email: formText(formData, "email").trim() };
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors, values };

  let hasSession = false;
  try {
    const supabase = await createSupabaseServerClient();
    const origin = await getRequestOrigin();
    // If Supabase Auth requires email confirmation, the emailed link lands on
    // /auth/callback, which exchanges the code and continues to `next`.
    const emailRedirectTo = origin
      ? `${origin}/auth/callback?${new URLSearchParams({ next }).toString()}`
      : undefined;

    const { data, error } = await supabase.auth.signUp({
      ...parsed.credentials,
      options: emailRedirectTo ? { emailRedirectTo } : undefined,
    });
    if (error) {
      const outcome = normalizeSignUpError(error);
      if (outcome.kind === "confirmation_required") {
        return { ok: true, data: { confirmationRequired: true } };
      }
      if (outcome.kind === "field") {
        return { ok: false, fieldErrors: { [outcome.field]: outcome.message }, values };
      }
      return { ok: false, formError: outcome.message, values };
    }
    hasSession = data.session !== null;
  } catch {
    return { ok: false, formError: es.common.unexpectedError, values };
  }

  // Confirmation required (or an existing address, indistinguishably).
  if (!hasSession) return { ok: true, data: { confirmationRequired: true } };

  redirect(next);
}

export type ForgotPasswordState = FormState<"email", { requested: true }> | null;

/**
 * Asks Supabase Auth to email a password recovery link (AUTH-RECOVERY-01).
 * The answer never says whether an account exists: success, unknown
 * addresses and every account-dependent Auth outcome look the same. The
 * PKCE code verifier lands in an httpOnly cookie, so the link only works in
 * this browser; it returns through the shared `/auth/callback` exchange.
 */
export async function requestPasswordResetAction(
  _prev: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const next = recoveryNext(formText(formData, "next"));
  const values = { email: formText(formData, "email").trim() };
  const parsed = parseEmail(formText(formData, "email"));
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors, values };

  // Configuration, not the address: says nothing about any account.
  const origin = await getRecoveryRedirectOrigin();
  if (!origin) return { ok: false, formError: es.auth.forgotPassword.unavailable, values };

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.resetPasswordForEmail(parsed.email, {
      redirectTo: recoveryRedirectUrl(origin, next),
    });
    if (error) {
      const outcome = normalizePasswordResetRequestError(error);
      if (outcome.kind === "form") return { ok: false, formError: outcome.message, values };
    }
  } catch {
    // Same neutral answer: a failure here may depend on the account too.
  }
  return { ok: true, data: { requested: true } };
}

export type ResetPasswordState = FormState<NewPasswordField> | null;

/**
 * Sets the new password on a recovery session, then continues by the
 * account's current type (ACCOUNT-01). The user and the recovery proof come
 * from the server-validated session only; the form carries the two password
 * fields and a continuation, never a user id or a token. No (or an expired)
 * recovery session → back to the request page.
 */
export async function resetPasswordAction(
  _prev: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const next = recoveryNext(formText(formData, "next"));
  const user = await getRecoveryUser();
  if (!user) redirect(forgotPasswordPath(next, "expired"));

  const parsed = parseNewPassword({
    password: formText(formData, "password"),
    confirmPassword: formText(formData, "confirmPassword"),
  });
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };

  let failure: ReturnType<typeof normalizePasswordUpdateError> | null = null;
  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.updateUser({ password: parsed.password });
    if (error) failure = normalizePasswordUpdateError(error);
  } catch {
    failure = { kind: "form", message: es.common.unexpectedError };
  }
  // Outside any try/catch: redirect() throws Next's control-flow signal.
  if (failure?.kind === "session_expired") redirect(forgotPasswordPath(next, "expired"));
  if (failure?.kind === "field") return { ok: false, fieldErrors: { password: failure.message } };
  if (failure) return { ok: false, formError: failure.message };

  redirect(afterPasswordResetPath(await getCurrentAccountType(user.id), next));
}
