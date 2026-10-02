"use server";

import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import type { FormState } from "@/lib/forms/result";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createWedding } from "@/lib/weddings/service";
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
 */
export async function createWeddingAction(
  _prev: NewWeddingState,
  formData: FormData,
): Promise<NewWeddingState> {
  await requireUser("/app/weddings/new");
  const { common } = getMessages();

  const values = weddingFormValues(formData);
  const parsed = parseWeddingInput(values);
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors, values };

  const result = await createWedding(await createSupabaseServerClient(), parsed.input);
  if (!result.ok) {
    if (result.reason === "unauthenticated") await requireUser("/app/weddings/new");
    const fieldError = weddingFieldErrorMessage(result.reason);
    if (fieldError) return { ok: false, fieldErrors: fieldError, values };
    return { ok: false, formError: common.unexpectedError, values };
  }

  redirect(`/app/weddings/${result.weddingId}`);
}
