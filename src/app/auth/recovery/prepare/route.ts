import { NextResponse, type NextRequest } from "next/server";

import { isWellFormedRecoveryTokenHash, RECOVERY_CONFIRM_PATH } from "@/lib/auth/recovery";
import {
  RECOVERY_TOKEN_COOKIE,
  clearedRecoveryTokenCookieOptions,
  recoveryTokenCookieOptions,
} from "@/lib/auth/recovery-handoff";

/**
 * Password recovery email link entry point (AUTH-RECOVERY-02).
 *
 * A Route Handler, not a page: it moves the emailed token hash out of the
 * URL into the short-lived httpOnly handoff cookie and redirects to the
 * confirmation page, so the token stops appearing in the address bar,
 * history and Referer, and nothing is ever rendered (or cached) with it.
 *
 * This GET NEVER verifies, exchanges or consumes anything and makes no Auth
 * or database call: link scanners, prefetchers and previews may open it any
 * number of times and the link still works for the person. Only the
 * explicit "Continuar" POST on the confirm page calls `verifyOtp`. A
 * malformed or missing token is dropped without being echoed (and forgets
 * any earlier one: this link is what was just opened). Nothing is logged.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const response = NextResponse.redirect(new URL(RECOVERY_CONFIRM_PATH, request.nextUrl.origin), 303);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");

  if (isWellFormedRecoveryTokenHash(tokenHash)) {
    response.cookies.set(RECOVERY_TOKEN_COOKIE, tokenHash, recoveryTokenCookieOptions());
  } else {
    response.cookies.set(RECOVERY_TOKEN_COOKIE, "", clearedRecoveryTokenCookieOptions());
  }
  return response;
}
