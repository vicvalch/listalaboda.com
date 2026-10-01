import "server-only";

/**
 * Invite handoff cookie (ADR-002 §5): `/invite/[token]` moves the plaintext
 * token out of the URL into this cookie and redirects, so the token survives
 * login/signup without being carried in `next=` or re-sent in query strings.
 *
 * It is a short-lived bearer credential, NOT membership authority: accepting
 * still goes through the `accept_membership_invite` RPC as the signed-in
 * user. HttpOnly keeps it away from browser JavaScript.
 *
 * Path is `/`, not `/invite`: after sign-in/sign-up, the Server Action's
 * `redirect()` renders /invite/continue inside the same POST to /login or
 * /signup, and a cookie scoped to `/invite` would not be sent with it.
 */

export const INVITE_HANDOFF_COOKIE = "lb_membership_invite";

/** 30 minutes: enough to sign up or sign in, short enough to not linger. */
export const INVITE_HANDOFF_MAX_AGE_SECONDS = 30 * 60;

export const INVITE_HANDOFF_PATH = "/";

export type HandoffCookieOptions = Readonly<{
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
}>;

/**
 * SameSite=Lax (not Strict) so the cookie is still sent on the top-level
 * navigation back from an email confirmation link. Secure everywhere except
 * local http development.
 */
export function inviteHandoffCookieOptions(
  env: string | undefined = process.env.NODE_ENV,
): HandoffCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: env === "production",
    path: INVITE_HANDOFF_PATH,
    maxAge: INVITE_HANDOFF_MAX_AGE_SECONDS,
  };
}

/** Options that expire the cookie (must match path to delete it). */
export function clearedInviteHandoffCookieOptions(
  env: string | undefined = process.env.NODE_ENV,
): HandoffCookieOptions {
  return { ...inviteHandoffCookieOptions(env), maxAge: 0 };
}
