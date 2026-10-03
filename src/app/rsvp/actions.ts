"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getMessages } from "@/lib/i18n";
import { GUEST_RSVP_COOKIE, GUEST_RSVP_PAGE_PATH } from "@/lib/rsvp/handoff";
import { submitGuestRsvp } from "@/lib/rsvp/service";
import { parseRsvpForm, type RsvpFormValue } from "@/lib/rsvp/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type RsvpFormState = Readonly<{
  ok: false;
  fieldErrors: Readonly<Record<string, string>>;
  formError?: string;
  values: Readonly<Record<string, RsvpFormValue>>;
}> | null;

/**
 * Saves the party's answers. The token comes only from the httpOnly handoff
 * cookie — never from the form — and is the only authority; guest ids in
 * the form are references that `submit_guest_rsvp` re-checks against the
 * token's party. No account, no session involved. All-or-nothing: on any
 * failure nothing is saved.
 */
export async function submitRsvpAction(
  _prev: RsvpFormState,
  formData: FormData,
): Promise<RsvpFormState> {
  const copy = getMessages().rsvp;
  const token = (await cookies()).get(GUEST_RSVP_COOKIE)?.value ?? "";

  const parsed = parseRsvpForm(formData);
  if (!parsed.ok) return parsed;

  const result = await submitGuestRsvp(await createSupabaseServerClient(), token, parsed.responses);
  if (!result.ok) {
    // /rsvp re-checks the link and shows the generic unavailable state.
    if (result.reason === "unavailable") redirect(GUEST_RSVP_PAGE_PATH);
    if (result.reason === "stale") {
      return { ok: false, fieldErrors: {}, formError: copy.validation.stale, values: {} };
    }
    return { ok: false, fieldErrors: {}, formError: copy.errors.failed, values: {} };
  }

  // A fixed flag, no data: the page shows the thanks + summary.
  redirect(`${GUEST_RSVP_PAGE_PATH}?saved=1`);
}
