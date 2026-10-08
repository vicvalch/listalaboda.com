"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { formText, type FormState } from "@/lib/forms/result";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  createWeddingVendor,
  deleteWeddingVendor,
  updateWeddingVendor,
  type VendorFailureReason,
} from "@/lib/vendors/service";
import { parseVendorInput, type VendorField, type VendorFormValues } from "@/lib/vendors/validation";

/**
 * Wedding vendor mutations (LB-21, ADR-014): create, update (every field in
 * one write, status included) and delete. Any member of the wedding (owner or
 * collaborator). Forms carry only lookup keys (wedding and vendor ids) and the
 * typed fields; the caller and their membership are derived on the server by
 * the service, which validates again, and the database re-checks every write.
 * Results carry only catalog messages, never database errors or vendor data
 * beyond the echoed form values.
 */

function vendorsPath(weddingId: string): string {
  return `/app/weddings/${encodeURIComponent(weddingId)}/vendors`;
}

function vendorPath(weddingId: string, vendorId: string): string {
  return `${vendorsPath(weddingId)}/${encodeURIComponent(vendorId)}`;
}

/** Maps a service failure to a form message (or a 404 / login redirect). */
async function failureMessage(weddingId: string, reason: VendorFailureReason): Promise<string> {
  const copy = getMessages().vendors.errors;
  switch (reason) {
    case "unauthenticated":
      await requireUser(vendorsPath(weddingId));
      return copy.failed;
    case "not_found":
      // Non-members get the same 404 as a nonexistent wedding.
      notFound();
    case "invalid_target":
      revalidatePath(vendorsPath(weddingId));
      return copy.notFound;
    case "invalid_input":
      return copy.invalid;
    case "forbidden":
    case "database_error":
      return copy.failed;
  }
}

export type VendorFormState = FormState<VendorField, { message: string; nonce: string }> | null;

function formValues(formData: FormData): VendorFormValues {
  return {
    name: formText(formData, "name"),
    category: formText(formData, "category"),
    customCategory: formText(formData, "customCategory"),
    status: formText(formData, "status"),
    contactName: formText(formData, "contactName"),
    email: formText(formData, "email"),
    phone: formText(formData, "phone"),
    instagramHandle: formText(formData, "instagramHandle"),
    currency: formText(formData, "currency"),
    quotedAmount: formText(formData, "quotedAmount"),
    contractedAmount: formText(formData, "contractedAmount"),
    notes: formText(formData, "notes"),
  };
}

async function saveVendor(formData: FormData, vendorId: string | null): Promise<VendorFormState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(vendorId ? vendorPath(weddingId, vendorId) : vendorsPath(weddingId));
  const copy = getMessages().vendors;

  const values = formValues(formData);
  const parsed = parseVendorInput(values);
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors, values };

  const supabase = await createSupabaseServerClient();
  const result = vendorId
    ? await updateWeddingVendor(supabase, weddingId, vendorId, parsed.input)
    : await createWeddingVendor(supabase, weddingId, parsed.input);
  if (!result.ok) return { ok: false, formError: await failureMessage(weddingId, result.reason), values };

  revalidatePath(vendorsPath(weddingId));
  if (vendorId) revalidatePath(vendorPath(weddingId, vendorId));
  return {
    ok: true,
    data: { message: vendorId ? copy.edit.saved : copy.create.created, nonce: crypto.randomUUID() },
  };
}

export async function createVendorAction(_prev: VendorFormState, formData: FormData): Promise<VendorFormState> {
  return saveVendor(formData, null);
}

export async function updateVendorAction(_prev: VendorFormState, formData: FormData): Promise<VendorFormState> {
  return saveVendor(formData, formText(formData, "vendorId"));
}

/** Same shape as the guest list's confirmation state, so the shared ConfirmButton fits. */
export type ConfirmState = FormState<never> | null;

/** Hard delete, then back to the list. "Descartado" is a status change, not this. */
export async function deleteVendorAction(_prev: ConfirmState, formData: FormData): Promise<ConfirmState> {
  const weddingId = formText(formData, "weddingId");
  const vendorId = formText(formData, "vendorId");
  await requireUser(vendorPath(weddingId, vendorId));

  const result = await deleteWeddingVendor(await createSupabaseServerClient(), weddingId, vendorId);
  if (!result.ok) return { ok: false, formError: await failureMessage(weddingId, result.reason) };
  revalidatePath(vendorsPath(weddingId));
  redirect(vendorsPath(weddingId));
}
