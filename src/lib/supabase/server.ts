import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getPublicEnv } from "@/lib/env/public";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 *
 * Acts as the current user via the request's session cookies, with the
 * publishable key — RLS applies. This is NOT a privileged client, and it is
 * what every authorization check uses. The codebase's only service-role use
 * is the narrow, non-exported recorder of provider-accepted invitation
 * emails (ADR-004, `@/lib/email/delivery-recorder`).
 *
 * Create one per request; do not share instances across requests.
 */
export async function createSupabaseServerClient() {
  const { supabaseUrl, supabasePublishableKey } = getPublicEnv();
  const cookieStore = await cookies();

  return createServerClient<Database>(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot write cookies; `src/proxy.ts` refreshes
          // the session before rendering. Server Actions and Route Handlers
          // (sign-in, sign-out, code exchange) do write here.
        }
      },
    },
  });
}
