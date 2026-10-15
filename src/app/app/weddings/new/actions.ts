"use server";

import { redirect } from "next/navigation";

import { accountTypeOnboardingPath, canCreateWedding } from "@/lib/accounts/account-type";
import { requireAccountType } from "@/lib/accounts/session";
import { requireUser } from "@/lib/auth/session";
import type { FormState } from "@/lib/forms/result";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createWedding, listMyWeddings } from "@/lib/weddings/service";
import {
  parseWeddingInput,
  weddingFieldErrorMessage,
  weddingFormValues,
  type WeddingField,
} from "@/lib/weddings/validation";

export type NewWeddingState = FormState<WeddingField> | null;

/**
 * Creates a wedding via `create_wedding` (name, optional date, city and time
 * zone); the database makes the caller its owner. Redirects to the id the
 * RPC returned. The time zone is only what the person chose in the form:
 * never inferred on the server.
 *
 * ACCOUNT-01 (ADR-020 §5): an account without a type is sent to the one-time
 * choice first; a couple who already belongs to a wedding can't create
 * another (checked here, server-side, not only by hiding the links).
 * Planners create as many as they need. `create_wedding` enforces the same
 * rule in the database; its two refusals map to the same outcomes.
 */
export async function createWeddingAction(
  _prev: NewWeddingState,
  formData: FormData,
): Promise<NewWeddingState> {
  const { user, accountType } = await requireAccountType("/app/weddings/new");
  const { app, common } = getMessages();

  const values = weddingFormValues(formData);
  const parsed = parseWeddingInput(values);
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors, values };

  const supabase = await createSupabaseServerClient();
  if (accountType === "couple") {
    const weddings = await listMyWeddings(supabase, user.id);
    if (weddings === null) return { ok: false, formError: common.unexpectedError, values };
    if (!canCreateWedding(accountType, weddings.length)) {
      return { ok: false, formError: app.weddings.couple.createBlocked, values };
    }
  }

  const result = await createWedding(supabase, parsed.input);
  if (!result.ok) {
    if (result.reason === "unauthenticated") await requireUser("/app/weddings/new");
    // Outside any try/catch: redirect() throws Next's control-flow signal.
    if (result.reason === "account_type_required") redirect(accountTypeOnboardingPath("/app/weddings/new"));
    if (result.reason === "couple_wedding_limit") {
      return { ok: false, formError: app.weddings.couple.createBlocked, values };
    }
    const fieldError = weddingFieldErrorMessage(result.reason);
    if (fieldError) return { ok: false, fieldErrors: fieldError, values };
    return { ok: false, formError: common.unexpectedError, values };
  }

  redirect(`/app/weddings/${result.weddingId}`);
}
