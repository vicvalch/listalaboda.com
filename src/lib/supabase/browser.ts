import { createBrowserClient } from "@supabase/ssr";

import { getPublicEnv } from "@/lib/env/public";

/**
 * Supabase client for Client Components.
 *
 * Uses only the public URL and publishable key; every request is subject to
 * RLS as the signed-in user (or anon). Never pass a secret key here.
 */
export function createSupabaseBrowserClient() {
  const { supabaseUrl, supabasePublishableKey } = getPublicEnv();
  return createBrowserClient(supabaseUrl, supabasePublishableKey);
}
