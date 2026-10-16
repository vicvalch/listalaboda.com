import "server-only";

/**
 * Recovery link handoff cookie (AUTH-RECOVERY-02).
 *
 * `/auth/recovery/prepare` moves the emailed token hash out of the URL into
 * this cookie and redirects to `/auth/recovery/confirm`, so the token stops
 * appearing in the address bar, history and Referer, and no page is ever
 * rendered (or cached) under a token URL. Nothing is verified on the way:
 * only the "Continuar" action on the confirm page hands it to `verifyOtp`.
 *
 * Each browser (or link scanner) that opens the link gets its own copy in
 * its own cookie jar; a copy that is never confirmed consumes nothing.
 * It is a carrier, never an identity or an authorization: it can't unlock
 * the reset page (only a verified session's signed claim does). HttpOnly
 * keeps it from browser JavaScript; the path keeps it off every other route.
 */

export const RECOVERY_TOKEN_COOKIE = "lb_recovery_token";

/** Fifteen minutes: enough to press "Continuar", short enough not to linger. */
export const RECOVERY_TOKEN_COOKIE_MAX_AGE_SECONDS = 15 * 60;

/** The prepare route and the confirm page (and its action) both live under it. */
export const RECOVERY_TOKEN_COOKIE_PATH = "/auth/recovery";

export type RecoveryTokenCookieOptions = Readonly<{
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
}>;

/**
 * SameSite=Lax so the cookie survives the top-level redirect from the link
 * (opened from a mail app). Secure everywhere except local http.
 */
export function recoveryTokenCookieOptions(
  env: string | undefined = process.env.NODE_ENV,
): RecoveryTokenCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: env === "production",
    path: RECOVERY_TOKEN_COOKIE_PATH,
    maxAge: RECOVERY_TOKEN_COOKIE_MAX_AGE_SECONDS,
  };
}

/** Options that expire the cookie (must match path to delete it). */
export function clearedRecoveryTokenCookieOptions(
  env: string | undefined = process.env.NODE_ENV,
): RecoveryTokenCookieOptions {
  return { ...recoveryTokenCookieOptions(env), maxAge: 0 };
}
