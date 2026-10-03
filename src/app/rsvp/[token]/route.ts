import { NextResponse, type NextRequest } from "next/server";

import {
  GUEST_RSVP_COOKIE,
  GUEST_RSVP_PAGE_PATH,
  clearedGuestRsvpCookieOptions,
  guestRsvpCookieOptions,
} from "@/lib/rsvp/handoff";
import { isWellFormedCapabilityToken } from "@/lib/security/capability-token";

/**
 * Guest link entry point (ADR-002 §5).
 *
 * A Route Handler, not a page: it moves the party's bearer token out of the
 * URL into the short-lived httpOnly handoff cookie and redirects to /rsvp,
 * so the token stops appearing in the address bar, history and Referer, and
 * nothing is ever rendered (or cached) under a token URL. No login, no
 * account.
 *
 * The link is reusable until it expires, so opening it again simply
 * repeats the handoff. This GET reads and writes nothing in the database
 * (link previews can't change anything); /rsvp checks the link on every
 * request. A malformed token is dropped without being echoed.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: RouteContext<"/rsvp/[token]">) {
  const { token } = await params;
  const response = NextResponse.redirect(new URL(GUEST_RSVP_PAGE_PATH, request.nextUrl.origin), 303);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");

  if (isWellFormedCapabilityToken(token)) {
    response.cookies.set(GUEST_RSVP_COOKIE, token, guestRsvpCookieOptions());
  } else {
    // Forget any earlier party: this link is what the guest just opened.
    response.cookies.set(GUEST_RSVP_COOKIE, "", clearedGuestRsvpCookieOptions());
  }
  return response;
}
