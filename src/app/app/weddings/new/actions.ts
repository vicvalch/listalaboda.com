"use server";

import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { formText, type FormState } from "@/lib/forms/result";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createWedding } from "@/lib/weddings/service";
import { parseWeddingInput, type WeddingField } from "@/lib/weddings/validation";

export type NewWeddingState = FormState<WeddingField> | null;

/**
 * Creates a wedding via `create_wedding`; the database makes the caller its
 * owner. Redirects to the id the RPC returned.
 */
export async function createWeddingAction(
  _prev: NewWeddingState,
  formData: FormData,
): Promise<NewWeddingState> {
  await requireUser("/app/weddings/new");
  const { common, weddingNew } = getMessages();

  const raw = { name: formText(formData, "name"), weddingDate: formText(formData, "weddingDate") };
  const values = raw;
  const parsed = parseWeddingInput(raw);
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors, values };

  const result = await createWedding(await createSupabaseServerClient(), parsed.input);
  if (!result.ok) {
    if (result.reason === "unauthenticated") await requireUser("/app/weddings/new");
    if (result.reason === "invalid_name") {
      return { ok: false, fieldErrors: { name: weddingNew.validation.nameRequired }, values };
    }
    if (result.reason === "invalid_date") {
      return { ok: false, fieldErrors: { weddingDate: weddingNew.validation.dateInvalid }, values };
    }
    return { ok: false, formError: common.unexpectedError, values };
  }

  redirect(`/app/weddings/${result.weddingId}`);
}
