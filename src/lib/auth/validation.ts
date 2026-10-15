import { es } from "@/lib/i18n/messages/es";

/**
 * UX-level credential validation. Supabase Auth stays authoritative (it
 * enforces its own password policy); this only catches obvious mistakes
 * early with Spanish field errors.
 */

export type CredentialField = "email" | "password";

export type Credentials = Readonly<{ email: string; password: string }>;

export type CredentialsResult =
  | Readonly<{ ok: true; credentials: Credentials }>
  | Readonly<{ ok: false; fieldErrors: Partial<Record<CredentialField, string>> }>;

export const PASSWORD_MIN_LENGTH = 8;
// bcrypt (used by Supabase Auth) only considers the first 72 bytes.
export const PASSWORD_MAX_LENGTH = 72;
const EMAIL_MAX_LENGTH = 320;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isPlausibleEmail(email: string): boolean {
  return email.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email);
}

/**
 * `login` only checks presence: enforcing the signup policy at login would
 * lock out accounts created under an older policy.
 */
export function parseCredentials(
  input: { email: string; password: string },
  mode: "login" | "signup",
): CredentialsResult {
  const messages = es.auth.validation;
  const fieldErrors: Partial<Record<CredentialField, string>> = {};

  const email = normalizeEmail(input.email);
  if (!email) fieldErrors.email = messages.emailRequired;
  else if (!isPlausibleEmail(email)) fieldErrors.email = messages.emailInvalid;

  const { password } = input;
  if (!password) fieldErrors.password = messages.passwordRequired;
  else if (mode === "signup" && password.length < PASSWORD_MIN_LENGTH) {
    fieldErrors.password = messages.passwordTooShort;
  } else if (new TextEncoder().encode(password).length > PASSWORD_MAX_LENGTH) {
    fieldErrors.password = messages.passwordTooLong;
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return { ok: true, credentials: { email, password } };
}

export type EmailResult =
  | Readonly<{ ok: true; email: string }>
  | Readonly<{ ok: false; fieldErrors: Partial<Record<"email", string>> }>;

/** The recovery request's only field, with the same rules as sign-in. */
export function parseEmail(value: string): EmailResult {
  const messages = es.auth.validation;
  const email = normalizeEmail(value);
  if (!email) return { ok: false, fieldErrors: { email: messages.emailRequired } };
  if (!isPlausibleEmail(email)) return { ok: false, fieldErrors: { email: messages.emailInvalid } };
  return { ok: true, email };
}

export type NewPasswordField = "password" | "confirmPassword";

export type NewPasswordResult =
  | Readonly<{ ok: true; password: string }>
  | Readonly<{ ok: false; fieldErrors: Partial<Record<NewPasswordField, string>> }>;

/**
 * A new password (recovery): the sign-up policy, typed twice. Supabase Auth
 * stays authoritative for its own policy (`weak_password`).
 */
export function parseNewPassword(input: { password: string; confirmPassword: string }): NewPasswordResult {
  const messages = es.auth.validation;
  const fieldErrors: Partial<Record<NewPasswordField, string>> = {};
  const { password, confirmPassword } = input;

  if (!password) fieldErrors.password = messages.passwordRequired;
  else if (password.length < PASSWORD_MIN_LENGTH) fieldErrors.password = messages.passwordTooShort;
  else if (new TextEncoder().encode(password).length > PASSWORD_MAX_LENGTH) {
    fieldErrors.password = messages.passwordTooLong;
  }

  if (!confirmPassword) fieldErrors.confirmPassword = messages.confirmPasswordRequired;
  else if (password && confirmPassword !== password) fieldErrors.confirmPassword = messages.passwordMismatch;

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return { ok: true, password };
}
