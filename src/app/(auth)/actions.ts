"use server";

import { redirect } from "next/navigation";

import { normalizeSignInError, normalizeSignUpError } from "@/lib/auth/errors";
import { safeNextPath } from "@/lib/auth/redirect";
import { parseCredentials, type CredentialField } from "@/lib/auth/validation";
import { formText, type FormState } from "@/lib/forms/result";
import { getRequestOrigin } from "@/lib/http/origin";
import { es } from "@/lib/i18n/messages/es";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Sign-in and sign-up. Both run server-side so the session cookies are set
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
