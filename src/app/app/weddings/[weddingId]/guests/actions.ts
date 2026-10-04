"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { getEmailDelivery } from "@/lib/email/delivery";
import { formText, type FormState } from "@/lib/forms/result";
import { parseContactEmail } from "@/lib/guests/contact-email";
import {
  rotateLinkAndSendInvitation,
  sendGuestInvitationEmail,
  type SendInvitationOutcome,
} from "@/lib/guests/invitation-email";
import {
  addGuest,
  createGuestParty,
  deleteGuestParty,
  removeGuest,
  revokeGuestPartyLink,
  rotateGuestPartyLink,
  updateGuestName,
  updateGuestPartyContactEmail,
  updateGuestPartyLabel,
} from "@/lib/guests/service";
import {
  parseGuestName,
  parseNewParty,
  parsePartyLabel,
  type NewPartyField,
} from "@/lib/guests/validation";
import { getRequestOrigin } from "@/lib/http/origin";
import { getMessages, interpolate } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Guest list mutations. Content (parties, guests) is for any member of the
 * wedding (owner or collaborator); replacing or revoking a link is
 * owner-only (service + database). Forms carry only lookup keys (wedding,
 * party, guest ids) and the typed text; the caller, their membership and
 * role are derived on the server by the service, and the database re-checks
 * every write. A guest link's plaintext comes back only in the
 * create/rotate result, once.
 *
 * LB-11: the contact email is guest-list content (any member). Sending the
 * invitation email takes either the fresh link's token the caller was just
 * shown (any member; posted back in the form body, never a URL) or, for an
 * owner, an explicit "new link and send". Email configuration and the
 * trusted origin come from the server (`getEmailDelivery`), never the
 * request. Results carry only catalog messages, never provider errors.
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

/** A link just created or rotated, for the organizer's screen only. */
export type FreshLinkData = Readonly<{
  guestInvitationId: string;
  link: string;
  /** The same secret as `link`, so this exact link can be emailed. */
  token: string;
}>;

export type CreatePartyState =
  | FormState<NewPartyField, FreshLinkData & { label: string; nonce: string }>
  | null;

export async function createPartyAction(
  _prev: CreatePartyState,
  formData: FormData,
): Promise<CreatePartyState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(guestsPath(weddingId));

  const values = {
    label: formText(formData, "label"),
    guestNames: formText(formData, "guestNames"),
    contactEmail: formText(formData, "contactEmail"),
  };
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
      // A CHECK refused the label or the email; both were validated above,
      // so this is a mismatch with the database: point at the label.
      return { ok: false, fieldErrors: { label: getMessages().guests.validation.labelInvalid }, values };
    }
    return { ok: false, formError: await handleFailure(weddingId, result), values };
  }

  revalidatePath(guestsPath(weddingId));
  // The one and only time this link's plaintext is available.
  return {
    ok: true,
    data: {
      guestInvitationId: result.guestInvitationId,
      link: result.link,
      token: result.token,
      label: parsed.input.label,
      nonce: crypto.randomUUID(),
    },
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

export async function saveContactEmailAction(
  _prev: TextEditState,
  formData: FormData,
): Promise<TextEditState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(guestsPath(weddingId));
  const copy = getMessages().guests.contactEmail;

  const values = { text: formText(formData, "text") };
  const parsed = parseContactEmail(values.text);
  if (!parsed.ok) return { ok: false, fieldErrors: { text: parsed.error }, values };
  // Removing is its own explicit action ("Quitar correo").
  if (parsed.value === null) return { ok: false, fieldErrors: { text: copy.validation.required }, values };

  const result = await updateGuestPartyContactEmail(
    await createSupabaseServerClient(),
    weddingId,
    formText(formData, "guestInvitationId"),
    parsed.value,
  );
  if (!result.ok) {
    if (result.reason === "invalid") return { ok: false, fieldErrors: { text: copy.validation.invalid }, values };
    return { ok: false, formError: await handleFailure(weddingId, result), values };
  }
  revalidatePath(guestsPath(weddingId));
  return { ok: true, data: { message: copy.saved, nonce: crypto.randomUUID() } };
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

/** "Quitar correo": the link, guests, RSVPs and last-sent status stay. */
export async function removeContactEmailAction(
  _prev: ConfirmState,
  formData: FormData,
): Promise<ConfirmState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(guestsPath(weddingId));

  const result = await updateGuestPartyContactEmail(
    await createSupabaseServerClient(),
    weddingId,
    formText(formData, "guestInvitationId"),
    null,
  );
  if (!result.ok) return { ok: false, formError: await handleFailure(weddingId, result) };
  revalidatePath(guestsPath(weddingId));
  return { ok: true, data: undefined };
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

export type RotateLinkState = FormState<never, FreshLinkData & { nonce: string }> | null;

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
  return {
    ok: true,
    data: {
      guestInvitationId: formText(formData, "guestInvitationId"),
      link: result.link,
      token: result.token,
      nonce: crypto.randomUUID(),
    },
  };
}

// ------------------------------------------------------- invitation email

export type SendInvitationState = Readonly<{
  tone: "success" | "info" | "error";
  message: string;
  nonce: string;
}> | null;

/** Catalog message for an outcome; access failures go through `handleFailure`. */
async function sendOutcomeMessage(
  weddingId: string,
  outcome: SendInvitationOutcome,
): Promise<NonNullable<SendInvitationState>> {
  const copy = getMessages().guests.invitationEmail;
  const nonce = crypto.randomUUID();
  if (outcome.outcome === "sent") {
    return { tone: "success", message: interpolate(copy.sent, { email: outcome.recipient }), nonce };
  }
  if (outcome.outcome === "sent_but_unrecorded") {
    return { tone: "info", message: copy.errors.sentUnrecorded, nonce };
  }
  const errors: Partial<Record<typeof outcome.reason, string>> = {
    invalid_token: copy.errors.linkUnavailable,
    missing_email: copy.errors.missingEmail,
    invalid_email: copy.errors.recipientRejected,
    configuration_error: copy.errors.notConfigured,
    recipient_rejected: copy.errors.recipientRejected,
    provider_failed: copy.errors.providerFailed,
    forbidden: copy.ownerRequired,
  };
  const message = errors[outcome.reason] ?? (await handleFailure(weddingId, outcome));
  return { tone: "error", message, nonce };
}

/**
 * "Enviar invitación por correo" for a link the caller was just shown. Any
 * member. The token is checked against the party's current link by the
 * service; the URL is built on the server from the trusted origin.
 */
export async function sendInvitationAction(
  _prev: SendInvitationState,
  formData: FormData,
): Promise<SendInvitationState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(guestsPath(weddingId));

  const outcome = await sendGuestInvitationEmail(
    await createSupabaseServerClient(),
    weddingId,
    formText(formData, "guestInvitationId"),
    formText(formData, "token"),
    getEmailDelivery(),
  );
  if (outcome.outcome !== "failed") revalidatePath(guestsPath(weddingId));
  return sendOutcomeMessage(weddingId, outcome);
}

export type RotateAndSendState =
  | (NonNullable<SendInvitationState> &
      Readonly<{
        /** Present once the link was replaced, whatever happened to the email. */
        link?: FreshLinkData;
        /** The email can be retried with that link (it failed before sending). */
        canRetry: boolean;
      }>)
  | null;

/** "Generar nuevo enlace y enviar" — owner only (service + database). */
export async function rotateAndSendAction(
  _prev: RotateAndSendState,
  formData: FormData,
): Promise<RotateAndSendState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(guestsPath(weddingId));
  const guestInvitationId = formText(formData, "guestInvitationId");

  const outcome = await rotateLinkAndSendInvitation(
    await createSupabaseServerClient(),
    weddingId,
    guestInvitationId,
    getEmailDelivery(),
  );
  if (outcome.link) revalidatePath(guestsPath(weddingId));

  const state = await sendOutcomeMessage(weddingId, outcome);
  if (!outcome.link) return { ...state, canRetry: false };
  const failedToSend = outcome.outcome === "failed";
  return {
    ...state,
    // The old link is already gone: say so, and hand over the new one.
    message: failedToSend ? getMessages().guests.invitationEmail.errors.rotatedNotSent : state.message,
    link: { guestInvitationId, link: outcome.link.link, token: outcome.link.token },
    canRetry: failedToSend,
  };
}
