import type { NextRequest } from "next/server";

import { refreshSession } from "@/lib/supabase/proxy";

/** Keeps Supabase auth cookies fresh. Not an authorization boundary. */
export async function proxy(request: NextRequest) {
  return refreshSession(request);
}

export const config = {
  matcher: [
    // Everything except static assets, image optimization and the scheduler
    // route (LB-17, ADR-010 §4: a cron call has no session to refresh and
    // must never read or set cookies).
    "/((?!api/cron/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
