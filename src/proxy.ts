import type { NextRequest } from "next/server";

import { refreshSession } from "@/lib/supabase/proxy";

/** Keeps Supabase auth cookies fresh. Not an authorization boundary. */
export async function proxy(request: NextRequest) {
  return refreshSession(request);
}

export const config = {
  matcher: [
    // Everything except static assets and image optimization.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
