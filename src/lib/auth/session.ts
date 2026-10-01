import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import { loginPath } from "@/lib/auth/redirect";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Current-user identity for Server Components and Server Actions (ADR-002 §3).
 *
 * Identity always comes from `auth.getUser()`, which validates the session
 * with the Auth server. Never from `getSession()`, cookie presence,
 * `user_metadata` or anything the browser sends.
 */

export type CurrentUser = Readonly<{ id: string; email: string | null }>;

/**
 * The validated user, or null. Memoized per server render so a layout and
 * page share one Auth round-trip (React `cache` is request-scoped; outside a
 * render it simply calls through).
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  // Outside the try: reading cookies is what marks a render as per-request,
  // and Next signals that by throwing. Swallowing it would let a protected
  // page be prerendered as "signed out" at build time.
  const supabase = await createSupabaseServerClient();
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? null };
  } catch {
    return null;
  }
});

/**
 * The validated user; otherwise redirects to /login carrying `next` (which
 * is re-validated there). Call it in every protected page and action:
 * layouts don't re-run on client navigation, so they can't be the only gate.
 */
export async function requireUser(next?: string): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect(loginPath(next));
  return user;
}
