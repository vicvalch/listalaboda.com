"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { formText, type FormState } from "@/lib/forms/result";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  createTimelineEntry,
  deleteTimelineEntry,
  updateTimelineEntry,
  type TimelineFailureReason,
} from "@/lib/timeline/service";
import {
  parseTimelineInput,
  type TimelineField,
  type TimelineFormField,
  type TimelineFormValues,
} from "@/lib/timeline/validation";

/**
 * Wedding timeline mutations (LB-23, ADR-016): create, update (every field
 * in one write, vendor link included) and delete. Any member of the wedding
 * (owner or collaborator). Forms carry only lookup keys (wedding, entry and
 * vendor ids) and the typed fields; the caller and their membership are
 * derived on the server by the service, which validates again, and the
 * database re-checks every write (including that the vendor belongs to the
 * same wedding). Results carry only catalog messages, never database errors.
 */

function timelinePath(weddingId: string): string {
  return `/app/weddings/${encodeURIComponent(weddingId)}/timeline`;
}

/** Maps a service failure to a form message (or a 404 / login redirect). */
async function failureMessage(weddingId: string, reason: TimelineFailureReason): Promise<string> {
  const copy = getMessages().timeline.errors;
  switch (reason) {
    case "unauthenticated":
      await requireUser(timelinePath(weddingId));
      return copy.failed;
    case "not_found":
      // Non-members get the same 404 as a nonexistent wedding.
      notFound();
    case "invalid_target":
      revalidatePath(timelinePath(weddingId));
      return copy.notFound;
    case "invalid_vendor":
      return copy.invalidVendor;
    case "invalid_input":
      return copy.invalid;
    case "forbidden":
    case "database_error":
      return copy.failed;
  }
}

export type TimelineFormState = FormState<TimelineField, { message: string; nonce: string }> | null;

const FORM_FIELDS: readonly TimelineFormField[] = [
  "title",
  "dayOffset",
  "startTime",
  "durationHours",
  "durationMinutes",
  "phase",
  "location",
  "responsibleName",
  "weddingVendorId",
  "notes",
];

function formValues(formData: FormData): TimelineFormValues {
  return Object.fromEntries(FORM_FIELDS.map((field) => [field, formText(formData, field)])) as TimelineFormValues;
}

async function saveEntry(formData: FormData, entryId: string | null): Promise<TimelineFormState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(timelinePath(weddingId));
  const copy = getMessages().timeline;

  const values = formValues(formData);
  const parsed = parseTimelineInput(values);
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors, values };

  const supabase = await createSupabaseServerClient();
  const result = entryId
    ? await updateTimelineEntry(supabase, weddingId, entryId, parsed.input)
    : await createTimelineEntry(supabase, weddingId, parsed.input);
  if (!result.ok) {
    const message = await failureMessage(weddingId, result.reason);
    // The vendor is what the database refused: point at it.
    if (result.reason === "invalid_vendor") return { ok: false, fieldErrors: { weddingVendorId: message }, values };
    return { ok: false, formError: message, values };
  }

  revalidatePath(timelinePath(weddingId));
  return {
    ok: true,
    data: { message: entryId ? copy.edit.saved : copy.create.created, nonce: crypto.randomUUID() },
  };
}

export async function createTimelineEntryAction(
  _prev: TimelineFormState,
  formData: FormData,
): Promise<TimelineFormState> {
  return saveEntry(formData, null);
}

export async function updateTimelineEntryAction(
  _prev: TimelineFormState,
  formData: FormData,
): Promise<TimelineFormState> {
  return saveEntry(formData, formText(formData, "entryId"));
}

/** Same shape as the guest list's confirmation state, so the shared ConfirmButton fits. */
export type ConfirmState = FormState<never> | null;

/** Hard delete of one entry; the linked vendor is never touched. */
export async function deleteTimelineEntryAction(_prev: ConfirmState, formData: FormData): Promise<ConfirmState> {
  const weddingId = formText(formData, "weddingId");
  const entryId = formText(formData, "entryId");
  await requireUser(timelinePath(weddingId));

  const result = await deleteTimelineEntry(await createSupabaseServerClient(), weddingId, entryId);
  if (!result.ok) return { ok: false, formError: await failureMessage(weddingId, result.reason) };
  revalidatePath(timelinePath(weddingId));
  return { ok: true, data: undefined };
}
