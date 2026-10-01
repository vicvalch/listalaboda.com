"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { INVITE_CONTINUE_PATH, loginPath } from "@/lib/auth/redirect";
import { requireUser } from "@/lib/auth/session";
import type { FormState } from "@/lib/forms/result";
import { getMessages } from "@/lib/i18n";
import {
  INVITE_HANDOFF_COOKIE,
  clearedInviteHandoffCookieOptions,
} from "@/lib/membership-invites/handoff";
import { acceptMembershipInvite } from "@/lib/membership-invites/service";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type AcceptInviteState = FormState<never> | null;

/**
 * Accepts the pending invite held in the handoff cookie, as the signed-in
 * user. Takes no form input: the token comes only from the httpOnly cookie
 * and the user only from the validated session.
 *
 * Cookie cleanup: cleared on success and on any definitive failure
 * (malformed, unknown, expired, revoked, used, wrong account). Kept on a
 * transient error so the user can retry within the cookie's 30 minutes.
 */
export async function acceptInviteAction(): Promise<AcceptInviteState> {
  await requireUser(INVITE_CONTINUE_PATH);
  const cookieStore = await cookies();
  const token = cookieStore.get(INVITE_HANDOFF_COOKIE)?.value ?? "";

  const result = await acceptMembershipInvite(await createSupabaseServerClient(), token);

  if (result.ok) {
    cookieStore.set(INVITE_HANDOFF_COOKIE, "", clearedInviteHandoffCookieOptions());
    const joined = result.alreadyMember ? "existing" : "new";
    redirect(`/app/weddings/${result.weddingId}?joined=${joined}`);
  }
  if (result.reason === "invalid") {
    cookieStore.set(INVITE_HANDOFF_COOKIE, "", clearedInviteHandoffCookieOptions());
    // Without the cookie, /invite/continue renders the generic invalid state.
    redirect(INVITE_CONTINUE_PATH);
  }
  if (result.reason === "unauthenticated") await requireUser(INVITE_CONTINUE_PATH);
  return { ok: false, formError: getMessages().common.unexpectedError };
}

/** Signs out but keeps the pending invite, to accept it with another account. */
export async function switchAccountAction(): Promise<void> {
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // /login redirects back here if the session survived.
  }
  redirect(loginPath(INVITE_CONTINUE_PATH));
}
