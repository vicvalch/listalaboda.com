"use server";

import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Ends this browser's session. `scope: "local"` revokes this session's
 * refresh token on the Auth server (other devices stay signed in), and
 * @supabase/ssr clears the auth cookies on this response. Server pages
 * re-validate with `auth.getUser()` on every request, so /app is
 * inaccessible from the next request on.
 *
 * Redirects to /login: the obvious next step after signing out.
 */
export async function logoutAction(): Promise<void> {
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // Still leave the page. If the Auth server was unreachable the session
    // may survive; /login then sends the user back to /app, so they can see
    // they are still signed in and retry.
  }
  redirect("/login");
}
