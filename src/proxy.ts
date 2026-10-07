import type { NextRequest } from "next/server";

import { refreshSession } from "@/lib/supabase/proxy";

/** Keeps Supabase auth cookies fresh. Not an authorization boundary. */
export async function proxy(request: NextRequest) {
  return refreshSession(request);
}

export const config = {
  matcher: [
    // Everything except static assets, image optimization, the scheduler
    // route (LB-17, ADR-010 §4: a cron call has no session to refresh and
    // must never read or set cookies) and the Resend webhook (LB-18.2,
    // ADR-011 §7: the provider's signature is its only authority).
    "/((?!api/cron/|api/webhooks/resend$|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
