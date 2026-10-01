import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getPublicEnv } from "@/lib/env/public";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Request header carrying the requested path to layouts, which otherwise
 * can't see it. Always overwritten here (a client-sent value never survives)
 * and only ever used as a login `next=` hint, re-validated by
 * `safeNextPath`. Never an authorization input.
 */
export const REQUEST_PATH_HEADER = "x-lb-request-path";

/**
 * Session refresh for `src/proxy.ts` — and nothing else.
 *
 * Server Components can't write cookies, so an expired access token is
 * refreshed here, before rendering: the new cookies are written both to the
 * forwarded request (so this render sees them) and to the response (so the
 * browser stores them).
 *
 * This is deliberately NOT an authorization layer. It makes no redirect and
 * trusts nothing: pages and actions still validate the user with
 * `auth.getUser()` and wedding access with `@/lib/authz/wedding`.
 */
export async function refreshSession(request: NextRequest): Promise<NextResponse> {
  const requestPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  const forward = () => {
    // Built from request.headers each time, so refreshed cookies set below
    // are included.
    const headers = new Headers(request.headers);
    headers.set(REQUEST_PATH_HEADER, requestPath);
    return NextResponse.next({ request: { headers } });
  };
  let response = forward();

  const { supabaseUrl, supabasePublishableKey } = getPublicEnv();
  const supabase = createServerClient<Database>(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = forward();
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        // Responses carrying auth cookies must never be cached and replayed
        // to another user.
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value);
        }
      },
    },
  });

  // Triggers a refresh when the access token has expired. The result is
  // intentionally unused: this is session upkeep, not an identity check.
  await supabase.auth.getClaims();

  return response;
}
