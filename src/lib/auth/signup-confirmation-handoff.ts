import "server-only";

/**
 * Signup confirmation link handoff cookie (Batch 3; the AUTH-RECOVERY-02
 * pattern).
 *
 * `/auth/confirm/prepare` moves the emailed token hash out of the URL into
 * this cookie and redirects to `/auth/confirm`, so the token stops appearing
 * in the address bar, history and Referer, and no page is ever rendered (or
 * cached) under a token URL. Nothing is verified on the way: only the
 * "Confirmar mi cuenta" action on the confirm page hands it to `verifyOtp`.
 *
 * Each browser (or link scanner) that opens the link gets its own copy in its
 * own cookie jar; a copy that is never confirmed consumes nothing. It is a
 * carrier, never an identity or an authorization. HttpOnly keeps it from
 * browser JavaScript; the path keeps it off every other route (and apart from
 * the recovery cookie).
 */

export const SIGNUP_TOKEN_COOKIE = "lb_signup_token";

/** Fifteen minutes: enough to press the button, short enough not to linger. */
export const SIGNUP_TOKEN_COOKIE_MAX_AGE_SECONDS = 15 * 60;

/** The prepare route and the confirm page (and its action) both live under it. */
export const SIGNUP_TOKEN_COOKIE_PATH = "/auth/confirm";

export type SignupTokenCookieOptions = Readonly<{
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
export function signupTokenCookieOptions(
  env: string | undefined = process.env.NODE_ENV,
): SignupTokenCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: env === "production",
    path: SIGNUP_TOKEN_COOKIE_PATH,
    maxAge: SIGNUP_TOKEN_COOKIE_MAX_AGE_SECONDS,
  };
}

/** Options that expire the cookie (must match path to delete it). */
export function clearedSignupTokenCookieOptions(
  env: string | undefined = process.env.NODE_ENV,
): SignupTokenCookieOptions {
  return { ...signupTokenCookieOptions(env), maxAge: 0 };
}
