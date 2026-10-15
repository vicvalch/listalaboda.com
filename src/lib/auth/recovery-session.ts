import "server-only";

import { cache } from "react";

import { hasRecentRecovery } from "@/lib/auth/recovery";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/session";
import { getAppOrigin, isLocalOrigin } from "@/lib/http/app-origin";
import { getRequestOrigin } from "@/lib/http/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Server side of password recovery (AUTH-RECOVERY-01).
 *
 * A recovery session is an ordinary Supabase session whose signed `amr`
 * claim records the recovery-link verification. That claim, read through
 * `getClaims()` (signature-verified) for the user `auth.getUser()` already
 * validated, is the only thing that unlocks the new-password form: never a
 * query parameter, a cookie of ours or anything the browser sends.
 */

/** The validated user, if their session comes from a recent recovery link; otherwise null. */
export const getRecoveryUser = cache(async (): Promise<CurrentUser | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  const supabase = await createSupabaseServerClient();
  try {
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data || data.claims.sub !== user.id) return null;
    return hasRecentRecovery(data.claims.amr, Date.now()) ? user : null;
  } catch {
    return null;
  }
});

/**
 * The origin the emailed recovery link returns to: the trusted `APP_ORIGIN`
 * (as every emailed link). Without it, only a local development request may
 * use its own origin; anywhere else there is no link to send (null), so a
 * forged Host header can never pick where the link goes.
 */
export async function getRecoveryRedirectOrigin(): Promise<string | null> {
  const configured = getAppOrigin();
  if (configured) return configured;
  const requestOrigin = await getRequestOrigin();
  return requestOrigin && isLocalOrigin(requestOrigin) ? requestOrigin : null;
}
