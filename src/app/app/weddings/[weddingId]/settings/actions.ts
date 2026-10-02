"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { formText, type FormState } from "@/lib/forms/result";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { updateWeddingSettings } from "@/lib/weddings/service";
import { parseWeddingInput, type WeddingField } from "@/lib/weddings/validation";

export type WeddingSettingsState = FormState<WeddingField> | null;

/**
 * Owner-only: saves the wedding's name and date. The wedding id from the
 * form is only a lookup key; the service re-checks the owner role and RLS
 * re-checks it in the database, so a collaborator posting this action
 * directly changes nothing. A blank date clears it (stored as null).
 */
export async function updateWeddingSettingsAction(
  _prev: WeddingSettingsState,
  formData: FormData,
): Promise<WeddingSettingsState> {
  const weddingId = formText(formData, "weddingId");
  const weddingPath = `/app/weddings/${encodeURIComponent(weddingId)}`;
  const settingsPath = `${weddingPath}/settings`;
  await requireUser(settingsPath);
  const { common, weddingNew, weddingSettings } = getMessages();

  const values = { name: formText(formData, "name"), weddingDate: formText(formData, "weddingDate") };
  const parsed = parseWeddingInput(values);
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors, values };

  const result = await updateWeddingSettings(
    await createSupabaseServerClient(),
    weddingId,
    parsed.input,
  );
  if (!result.ok) {
    // Non-members get the same 404 as a nonexistent wedding.
    if (result.reason === "not_found") notFound();
    if (result.reason === "unauthenticated") await requireUser(settingsPath);
    if (result.reason === "forbidden") {
      return { ok: false, formError: weddingSettings.ownerOnly, values };
    }
    if (result.reason === "invalid_name") {
      return { ok: false, fieldErrors: { name: weddingNew.validation.nameRequired }, values };
    }
    if (result.reason === "invalid_date") {
      return { ok: false, fieldErrors: { weddingDate: weddingNew.validation.dateInvalid }, values };
    }
    return { ok: false, formError: common.unexpectedError, values };
  }

  revalidatePath(weddingPath);
  revalidatePath(settingsPath);
  // A fixed flag, no user data: the wedding page shows "saved".
  redirect(`${weddingPath}?saved=settings`);
}
