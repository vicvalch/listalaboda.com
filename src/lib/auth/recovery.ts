import { accountTypeOnboardingPath, type AccountType } from "@/lib/accounts/account-type";
import { DEFAULT_NEXT_PATH, safeNextPath } from "@/lib/auth/redirect";

/**
 * Password recovery (AUTH-RECOVERY-01) through Supabase Auth's own recovery
 * mechanism: `resetPasswordForEmail` (PKCE) → the emailed link → the shared
 * `/auth/callback` code exchange → `/reset-password` → `updateUser`.
 * No custom tokens, nothing stored by the app. Pure and dependency-free.
 */

export const FORGOT_PASSWORD_PATH = "/forgot-password";
export const RESET_PASSWORD_PATH = "/reset-password";
export const AUTH_CALLBACK_PATH = "/auth/callback";

/**
 * How long after the recovery link was opened the new password can be set.
 * The age comes from the session's signed `amr` claim (the moment Supabase
 * verified the recovery link), never from the browser.
 */
export const RECOVERY_SESSION_MAX_AGE_SECONDS = 30 * 60;

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
 * Whether the session's `amr` claim records a recovery-link verification
 * within the allowed age. Only Supabase's detailed format carries the time;
 * anything else (missing, plain strings, malformed) is not a recovery.
 */
export function hasRecentRecovery(amr: unknown, nowMs: number): boolean {
  if (!Array.isArray(amr)) return false;
  const nowSeconds = Math.floor(nowMs / 1000);
  return amr.some((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return false;
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
    if (method !== "recovery" || typeof timestamp !== "number" || !Number.isFinite(timestamp)) return false;
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
