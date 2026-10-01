import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getPublicEnv } from "@/lib/env/public";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 *
 * Acts as the current user via the request's session cookies, with the
 * publishable key — RLS applies. This is NOT a privileged client: there is
 * intentionally no service-role client in the codebase (ADR-002 §6).
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
          // Server Components cannot write cookies. Session refresh will be
          // handled by the proxy introduced with the auth prompt.
        }
      },
    },
  });
}
