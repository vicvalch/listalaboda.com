import "server-only";

/**
 * Guest link handoff cookie (ADR-002 §5): `/rsvp/[token]` moves the
 * plaintext GuestInvitation token out of the URL into this cookie and
 * redirects to `/rsvp`, so the token stops appearing in the address bar,
 * history, Referer and logs, and no page is ever rendered (or cached) under
 * a token URL.
 *
 * Unlike the MembershipInvite handoff, the guest link is NOT single-use:
 * the party may come back to change its answer until the link expires. So
 * the cookie is only a short-lived carrier for one visit; the original link
 * (or a bookmark of it) performs the handoff again every time it is opened.
 *
 * It is a bearer capability for ONE party, not an identity: every read and
 * write still goes through the token functions, which re-check the link
 * (revoked, expired, rotated) on each request. HttpOnly keeps it away from
 * browser JavaScript; the path keeps it off every other route.
 */

export const GUEST_RSVP_COOKIE = "lb_guest_rsvp";

/** Two hours: enough to answer calmly, short enough to not linger. */
export const GUEST_RSVP_COOKIE_MAX_AGE_SECONDS = 2 * 60 * 60;

/** The RSVP page and its Server Action both live under /rsvp. */
export const GUEST_RSVP_COOKIE_PATH = "/rsvp";

export const GUEST_RSVP_PAGE_PATH = "/rsvp";

export type GuestRsvpCookieOptions = Readonly<{
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
}>;

/**
 * SameSite=Lax so the cookie survives the top-level redirect from the link
 * (opened from a chat or email app). Secure everywhere except local http.
 */
export function guestRsvpCookieOptions(
  env: string | undefined = process.env.NODE_ENV,
): GuestRsvpCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: env === "production",
    path: GUEST_RSVP_COOKIE_PATH,
    maxAge: GUEST_RSVP_COOKIE_MAX_AGE_SECONDS,
  };
}

/** Options that expire the cookie (must match path to delete it). */
export function clearedGuestRsvpCookieOptions(
  env: string | undefined = process.env.NODE_ENV,
): GuestRsvpCookieOptions {
  return { ...guestRsvpCookieOptions(env), maxAge: 0 };
}
