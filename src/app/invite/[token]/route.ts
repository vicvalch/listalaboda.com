import { NextResponse, type NextRequest } from "next/server";

import { INVITE_CONTINUE_PATH } from "@/lib/auth/redirect";
import {
  INVITE_HANDOFF_COOKIE,
  clearedInviteHandoffCookieOptions,
  inviteHandoffCookieOptions,
} from "@/lib/membership-invites/handoff";
import { isWellFormedMembershipInviteToken } from "@/lib/membership-invites/token";

/**
 * Invite link entry point (ADR-002 §5).
 *
 * A Route Handler, not a page: it moves the bearer token out of the URL into
 * the short-lived httpOnly handoff cookie and redirects to
 * /invite/continue, so the token stops appearing in the address bar,
 * history and Referer, and nothing is rendered (or cached) with it.
 *
 * This GET never accepts anything — acceptance is an explicit POST from
 * /invite/continue — so link previews and prefetchers can't consume an
 * invite. A malformed token is dropped without touching the database and
 * without being echoed.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: RouteContext<"/invite/[token]">) {
  const { token } = await params;
  const response = NextResponse.redirect(
    new URL(INVITE_CONTINUE_PATH, request.nextUrl.origin),
    303,
  );
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");

  if (isWellFormedMembershipInviteToken(token)) {
    response.cookies.set(INVITE_HANDOFF_COOKIE, token, inviteHandoffCookieOptions());
  } else {
    // Also forget any earlier pending invite: this link is what the user
    // just opened, and it is invalid.
    response.cookies.set(INVITE_HANDOFF_COOKIE, "", clearedInviteHandoffCookieOptions());
  }
  return response;
}
