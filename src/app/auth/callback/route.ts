import { NextResponse, type NextRequest } from "next/server";

import { callbackFailurePath } from "@/lib/auth/recovery";
import { safeNextPath } from "@/lib/auth/redirect";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * PKCE code exchange for Supabase Auth email links (signup confirmation and,
 * since AUTH-RECOVERY-01, password recovery, which continues to
 * `/reset-password`). The code verifier lives in an httpOnly cookie set when
 * the flow started, so the link must be opened in the same browser.
 *
 * The code is never logged or echoed; `next` is re-validated so this route
 * can't be used as an open redirect. Failures land on /login with a generic
 * message, or for a recovery link on the request page ("ask for a new one").
 * Reaching the reset page proves nothing by itself: it checks the session's
 * signed recovery claim.
 */
export const dynamic = "force-dynamic";

const MAX_CODE_LENGTH = 1024;

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const next = safeNextPath(searchParams.get("next"));
  const code = searchParams.get("code");

  if (code && code.length <= MAX_CODE_LENGTH) {
    try {
      const supabase = await createSupabaseServerClient();
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) return redirectTo(request, next);
    } catch {
      // Fall through to the generic failure.
    }
  }

  return redirectTo(request, callbackFailurePath(next));
}

function redirectTo(request: NextRequest, path: string) {
  // `path` is a validated same-origin path; resolve it against this request.
  const response = NextResponse.redirect(new URL(path, request.nextUrl.origin), 303);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
