import { NextResponse, type NextRequest } from "next/server";

import {
  continuationFromRedirectTo,
  isWellFormedSignupTokenHash,
  signupConfirmPath,
} from "@/lib/auth/signup-confirmation";
import {
  SIGNUP_TOKEN_COOKIE,
  clearedSignupTokenCookieOptions,
  signupTokenCookieOptions,
} from "@/lib/auth/signup-confirmation-handoff";

/**
 * Signup confirmation email link entry point (Batch 3).
 *
 * A Route Handler, not a page: it moves the emailed token hash out of the URL
 * into the short-lived httpOnly handoff cookie and redirects to the
 * confirmation page (carrying only the validated continuation), so the token
 * stops appearing in the address bar, history and Referer, and nothing is
 * ever rendered (or cached) with it.
 *
 * This GET NEVER verifies, exchanges or consumes anything and makes no Auth
 * or database call: link scanners, prefetchers and previews may open it any
 * number of times and the link still works for the person. Only the explicit
 * "Confirmar mi cuenta" POST on the confirm page calls `verifyOtp`. A
 * malformed or missing token is dropped without being echoed (and forgets any
 * earlier one: this link is what was just opened). Nothing is logged.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const next = continuationFromRedirectTo(searchParams.get("redirect_to"));
  const response = NextResponse.redirect(new URL(signupConfirmPath(next), request.nextUrl.origin), 303);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");

  if (isWellFormedSignupTokenHash(tokenHash)) {
    response.cookies.set(SIGNUP_TOKEN_COOKIE, tokenHash, signupTokenCookieOptions());
  } else {
    response.cookies.set(SIGNUP_TOKEN_COOKIE, "", clearedSignupTokenCookieOptions());
  }
  return response;
}
