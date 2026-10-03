"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { formText, type FormState } from "@/lib/forms/result";
import {
  addGuest,
  createGuestParty,
  deleteGuestParty,
  removeGuest,
  revokeGuestPartyLink,
  rotateGuestPartyLink,
  updateGuestName,
  updateGuestPartyLabel,
} from "@/lib/guests/service";
import {
  parseGuestName,
  parseNewParty,
  parsePartyLabel,
  type NewPartyField,
} from "@/lib/guests/validation";
import { getRequestOrigin } from "@/lib/http/origin";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Guest list mutations. Content (parties, guests) is for any member of the
 * wedding (owner or collaborator); replacing or revoking a link is
 * owner-only (service + database). Forms carry only lookup keys (wedding,
 * party, guest ids) and the typed text; the caller, their membership and
 * role are derived on the server by the service, and the database re-checks
 * every write. A guest link's plaintext comes back only in the
 * create/rotate result, once.
 */

function guestsPath(weddingId: string): string {
  return `/app/weddings/${encodeURIComponent(weddingId)}/guests`;
}

type ServiceFailure = Readonly<{ reason: string }>;

/** Shared mapping of service failures; returns the form message for the rest. */
async function handleFailure(weddingId: string, failure: ServiceFailure): Promise<string> {
  const copy = getMessages().guests.errors;
  switch (failure.reason) {
    case "unauthenticated":
      await requireUser(guestsPath(weddingId));
      return copy.failed;
    case "not_found":
      // Non-members get the same 404 as a nonexistent wedding.
      notFound();
    case "invalid_target":
      revalidatePath(guestsPath(weddingId));
      return copy.notFound;
    case "forbidden":
      // A collaborator invoking an owner-only link action directly.
      return copy.linkOwnerOnly;
    case "last_guest":
      return getMessages().guests.removeGuest.lastGuest;
    default:
      return copy.failed;
  }
}

// ------------------------------------------------------------ create party

export type CreatePartyState =
  | FormState<NewPartyField, { link: string; label: string; nonce: string }>
  | null;

export async function createPartyAction(
  _prev: CreatePartyState,
  formData: FormData,
): Promise<CreatePartyState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(guestsPath(weddingId));

  const values = { label: formText(formData, "label"), guestNames: formText(formData, "guestNames") };
  const parsed = parseNewParty(values);
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors, values };

  const origin = await getRequestOrigin();
  if (!origin) return { ok: false, formError: getMessages().guests.errors.failed, values };

  const result = await createGuestParty(
    await createSupabaseServerClient(),
    weddingId,
    parsed.input,
    origin,
  );
  if (!result.ok) {
    if (result.reason === "invalid") {
      return { ok: false, fieldErrors: { label: getMessages().guests.validation.labelInvalid }, values };
    }
    return { ok: false, formError: await handleFailure(weddingId, result), values };
  }

  revalidatePath(guestsPath(weddingId));
  // The one and only time this link's plaintext is available.
  return {
    ok: true,
    data: { link: result.link, label: parsed.input.label, nonce: crypto.randomUUID() },
  };
}

// ------------------------------------------------- single-field text edits

export type TextEditState = FormState<"text", { message: string; nonce: string }> | null;

export async function updatePartyLabelAction(
  _prev: TextEditState,
  formData: FormData,
): Promise<TextEditState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(guestsPath(weddingId));
  const copy = getMessages().guests;

  const values = { text: formText(formData, "text") };
  const parsed = parsePartyLabel(values.text);
  if (!parsed.ok) return { ok: false, fieldErrors: { text: parsed.error }, values };

  const result = await updateGuestPartyLabel(
    await createSupabaseServerClient(),
    weddingId,
    formText(formData, "guestInvitationId"),
    parsed.value,
  );
  if (!result.ok) {
    if (result.reason === "invalid") return { ok: false, fieldErrors: { text: copy.validation.labelInvalid }, values };
    return { ok: false, formError: await handleFailure(weddingId, result), values };
  }
  revalidatePath(guestsPath(weddingId));
  return { ok: true, data: { message: copy.editParty.saved, nonce: crypto.randomUUID() } };
}

export async function addGuestAction(
  _prev: TextEditState,
  formData: FormData,
): Promise<TextEditState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(guestsPath(weddingId));
  const copy = getMessages().guests;

  const values = { text: formText(formData, "text") };
  const parsed = parseGuestName(values.text);
  if (!parsed.ok) return { ok: false, fieldErrors: { text: parsed.error }, values };

  const result = await addGuest(
    await createSupabaseServerClient(),
    weddingId,
    formText(formData, "guestInvitationId"),
    parsed.value,
  );
  if (!result.ok) {
    if (result.reason === "invalid") return { ok: false, fieldErrors: { text: copy.validation.nameInvalid }, values };
    return { ok: false, formError: await handleFailure(weddingId, result), values };
  }
  revalidatePath(guestsPath(weddingId));
  return { ok: true, data: { message: copy.addGuest.added, nonce: crypto.randomUUID() } };
}

export async function updateGuestNameAction(
  _prev: TextEditState,
  formData: FormData,
): Promise<TextEditState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(guestsPath(weddingId));
  const copy = getMessages().guests;

  const values = { text: formText(formData, "text") };
  const parsed = parseGuestName(values.text);
  if (!parsed.ok) return { ok: false, fieldErrors: { text: parsed.error }, values };

  const result = await updateGuestName(
    await createSupabaseServerClient(),
    weddingId,
    formText(formData, "guestId"),
    parsed.value,
  );
  if (!result.ok) {
    if (result.reason === "invalid") return { ok: false, fieldErrors: { text: copy.validation.nameInvalid }, values };
    return { ok: false, formError: await handleFailure(weddingId, result), values };
  }
  revalidatePath(guestsPath(weddingId));
  return { ok: true, data: { message: copy.editGuest.saved, nonce: crypto.randomUUID() } };
}

// ------------------------------------------------- confirmed (destructive)

export type ConfirmState = FormState<never> | null;

export async function removeGuestAction(
  _prev: ConfirmState,
  formData: FormData,
): Promise<ConfirmState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(guestsPath(weddingId));

  const result = await removeGuest(
    await createSupabaseServerClient(),
    weddingId,
    formText(formData, "guestId"),
  );
  if (!result.ok) return { ok: false, formError: await handleFailure(weddingId, result) };
  revalidatePath(guestsPath(weddingId));
  return { ok: true, data: undefined };
}

export async function revokeLinkAction(
  _prev: ConfirmState,
  formData: FormData,
): Promise<ConfirmState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(guestsPath(weddingId));

  const result = await revokeGuestPartyLink(
    await createSupabaseServerClient(),
    weddingId,
    formText(formData, "guestInvitationId"),
  );
  if (!result.ok) return { ok: false, formError: await handleFailure(weddingId, result) };
  revalidatePath(guestsPath(weddingId));
  // A fixed flag, no data: the page announces it.
  redirect(`${guestsPath(weddingId)}?done=revoked`);
}

export async function deletePartyAction(
  _prev: ConfirmState,
  formData: FormData,
): Promise<ConfirmState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(guestsPath(weddingId));

  const result = await deleteGuestParty(
    await createSupabaseServerClient(),
    weddingId,
    formText(formData, "guestInvitationId"),
  );
  if (!result.ok) return { ok: false, formError: await handleFailure(weddingId, result) };
  revalidatePath(guestsPath(weddingId));
  redirect(`${guestsPath(weddingId)}?done=deleted`);
}

// ------------------------------------------------------------- new link

export type RotateLinkState = FormState<never, { link: string; nonce: string }> | null;

export async function rotateLinkAction(
  _prev: RotateLinkState,
  formData: FormData,
): Promise<RotateLinkState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(guestsPath(weddingId));

  const origin = await getRequestOrigin();
  if (!origin) return { ok: false, formError: getMessages().guests.errors.failed };

  const result = await rotateGuestPartyLink(
    await createSupabaseServerClient(),
    weddingId,
    formText(formData, "guestInvitationId"),
    origin,
  );
  if (!result.ok) return { ok: false, formError: await handleFailure(weddingId, result) };
  revalidatePath(guestsPath(weddingId));
  // The one and only time the new link's plaintext is available.
  return { ok: true, data: { link: result.link, nonce: crypto.randomUUID() } };
}
