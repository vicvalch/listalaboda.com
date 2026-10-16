import { accountTypeOnboardingPath, type AccountType } from "@/lib/accounts/account-type";
import { DEFAULT_NEXT_PATH, safeNextPath } from "@/lib/auth/redirect";

/**
 * Password recovery through Supabase Auth's own recovery mechanism.
 *
 * AUTH-RECOVERY-02 (scanner-safe): `resetPasswordForEmail` → the email links
 * to the app's `/auth/recovery/prepare?token_hash=…` (Supabase's
 * `{{ .TokenHash }}`), which only moves the token into a short-lived
 * httpOnly cookie → `/auth/recovery/confirm` → the person presses
 * "Continuar" → `verifyOtp({ token_hash, type: "recovery" })` (a POST, the
 * only step that consumes the token) → `/reset-password` → `updateUser`.
 * A link scanner's GETs change nothing.
 *
 * AUTH-RECOVERY-01's path (`{{ .ConfirmationURL }}` → Supabase verify →
 * the shared `/auth/callback` PKCE exchange) still works for links sent
 * with the previous email template. No custom tokens, nothing stored by the
 * app. Pure and dependency-free.
 */

export const FORGOT_PASSWORD_PATH = "/forgot-password";
export const RESET_PASSWORD_PATH = "/reset-password";
export const AUTH_CALLBACK_PATH = "/auth/callback";
/** The emailed link's entry point (a GET that never verifies anything). */
export const RECOVERY_PREPARE_PATH = "/auth/recovery/prepare";
/** The explicit confirmation page; its "Continuar" action verifies the token. */
export const RECOVERY_CONFIRM_PATH = "/auth/recovery/confirm";

/**
 * How long after the recovery link was verified the new password can be set.
 * The age comes from the session's signed `amr` claim (the moment Supabase
 * verified the link), never from the browser.
 */
export const RECOVERY_SESSION_MAX_AGE_SECONDS = 30 * 60;

/**
 * The `amr` methods that prove a fresh recovery. `recovery`: the PKCE link
 * exchanged through `/auth/callback` (AUTH-RECOVERY-01). `otp`: a token hash
 * verified with `verifyOtp` (AUTH-RECOVERY-02), which Supabase records as an
 * email one-time code.
 *
 * Accepted consequence (an explicit product decision): a fresh magic-link /
 * email-OTP sign-in is ALSO `otp`, so such a session satisfies the reset gate
 * for the same 30 minutes. Both prove fresh control of the account's email,
 * which is exactly what a recovery link proves. A password sign-in never does.
 */
export const RECOVERY_AMR_METHODS: readonly string[] = ["recovery", "otp"];

/**
 * A Supabase Auth email token hash as the link carries it: lowercase hex,
 * `pkce_`-prefixed for PKCE requests (56 hex characters today; bounded, not
 * pinned, so a longer hash keeps working). Anything else is dropped unread.
 */
const RECOVERY_TOKEN_HASH = /^(?:pkce_)?[0-9a-f]{40,128}$/;

export function isWellFormedRecoveryTokenHash(value: unknown): value is string {
  return typeof value === "string" && RECOVERY_TOKEN_HASH.test(value);
}

// Tolerates a server clock slightly behind the Auth server's.
const CLOCK_SKEW_SECONDS = 60;

/** Why the request page is shown again: fixed values, presentation only. */
export type RecoveryNotice = "link" | "expired";

function isRecoveryPage(path: string): boolean {
  return [FORGOT_PASSWORD_PATH, RESET_PASSWORD_PATH].some(
    (page) => path === page || path.startsWith(`${page}?`) || path.startsWith(`${page}#`),
  );
}

/** A validated continuation for after the reset; never a recovery page itself. */
export function recoveryNext(value: unknown): string {
  const safe = safeNextPath(value);
  return isRecoveryPage(safe) ? DEFAULT_NEXT_PATH : safe;
}

function withQuery(path: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return query ? `${path}?${query}` : path;
}

/** `/forgot-password`, carrying a validated continuation and an optional notice. */
export function forgotPasswordPath(next?: string, notice?: RecoveryNotice): string {
  const safe = recoveryNext(next);
  return withQuery(FORGOT_PASSWORD_PATH, {
    ...(safe === DEFAULT_NEXT_PATH ? {} : { next: safe }),
    ...(notice ? { error: notice } : {}),
  });
}

/** `/reset-password`, carrying a validated continuation when it isn't the default. */
export function resetPasswordPath(next?: string): string {
  const safe = recoveryNext(next);
  return withQuery(RESET_PASSWORD_PATH, safe === DEFAULT_NEXT_PATH ? {} : { next: safe });
}

/**
 * The `redirectTo` for `resetPasswordForEmail`: the shared code exchange,
 * continuing to the reset page. `origin` must be the trusted app origin
 * (`APP_ORIGIN`); Supabase Auth also checks it against its allow-list.
 */
export function recoveryRedirectUrl(origin: string, next?: string): string {
  return `${origin}${withQuery(AUTH_CALLBACK_PATH, { next: resetPasswordPath(next) })}`;
}

/**
 * Where a failed code exchange goes. A recovery continuation gets the
 * request page with a "link not valid" notice (keeping its own `next`);
 * anything else keeps the login page's generic callback error.
 */
export function callbackFailurePath(next: string): string {
  if (next !== RESET_PASSWORD_PATH && !next.startsWith(`${RESET_PASSWORD_PATH}?`)) {
    return "/login?error=callback";
  }
  const inner = new URL(next, "https://listalaboda.invalid").searchParams.get("next") ?? undefined;
  return forgotPasswordPath(inner, "link");
}

/**
 * Whether the session's `amr` claim records a recovery verification (one of
 * `RECOVERY_AMR_METHODS`) within the allowed age. Only Supabase's detailed
 * format carries the time; anything else (missing, plain strings, other
 * methods such as `password`, malformed) is not a recovery.
 */
export function hasRecentRecovery(amr: unknown, nowMs: number): boolean {
  if (!Array.isArray(amr)) return false;
  const nowSeconds = Math.floor(nowMs / 1000);
  return amr.some((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return false;
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
    if (typeof method !== "string" || !RECOVERY_AMR_METHODS.includes(method)) return false;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return false;
    const age = nowSeconds - timestamp;
    return age >= -CLOCK_SKEW_SECONDS && age <= RECOVERY_SESSION_MAX_AGE_SECONDS;
  });
}

/**
 * Where to go once the new password is saved, by the account's current
 * type (ACCOUNT-01): not chosen yet → the onboarding choice; planner or
 * couple → the continuation (`/app` by default, whose entry is already
 * role-aware). A failed read (`undefined`) also continues: the `/app` guard
 * re-reads and never routes on a guess.
 */
export function afterPasswordResetPath(accountType: AccountType | null | undefined, next: unknown): string {
  const safe = recoveryNext(next);
  return accountType === null ? accountTypeOnboardingPath(safe) : safe;
}
