import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { EmailDelivery } from "@/lib/email/delivery";
import { renderRsvpConfirmationEmail } from "@/lib/email/rsvp-confirmation";
import { isStoredContactEmail } from "@/lib/guests/contact-email";
import type { ConfirmationOutcome } from "@/lib/rsvp/confirmation-notice";
import {
  getGuestPartySiteSlug,
  submitGuestRsvp,
  type GuestParty,
  type SubmitRsvpResult,
} from "@/lib/rsvp/service";
import type { RsvpResponse } from "@/lib/rsvp/validation";
import { hashCapabilityToken } from "@/lib/security/capability-token";
import type { Database } from "@/lib/supabase/database.types";
import { publicSitePath } from "@/lib/wedding-site/slug";

/**
 * A party's RSVP followed by its confirmation email (LB-12).
 *
 * The RSVP is PRIMARY and the email SECONDARY, in this causal order:
 *   1. `submitGuestRsvp` — the guest capability, unchanged: the token hash
 *      is the only authority, checked by `submit_guest_rsvp` as anon, and the
 *      answers are saved and committed. Any failure here is an RSVP failure
 *      and nothing else happens (no configuration read, provider or recorder).
 *   2. Only then, the email: configuration → the party's private context
 *      (contact email, wedding name/date/city) through the privileged reader
 *      (ADR-005; never the guest's own functions, which must not reveal it) →
 *      the published-site address through the existing guest helper →
 *      render from the database's post-save result → ONE provider call →
 *      only after the provider accepted, the privileged recorder.
 *
 * Nothing in step 2 can turn a saved RSVP into a failure: every outcome
 * there is reported separately as `confirmation`. No automatic retries.
 * The confirmation never carries the RSVP link or token, and nothing is
 * logged.
 */

type Client = SupabaseClient<Database>;

/** See `ConfirmationOutcome` (`@/lib/rsvp/confirmation-notice`). */
export type RsvpConfirmationOutcome = ConfirmationOutcome;

type RsvpFailure = Extract<SubmitRsvpResult, { ok: false }>["reason"];

export type SubmitRsvpWithConfirmationResult =
  | Readonly<{ rsvp: "saved"; party: GuestParty; confirmation: RsvpConfirmationOutcome }>
  | Readonly<{ rsvp: "failed"; reason: RsvpFailure }>;

/**
 * `getDelivery` is called only AFTER the RSVP was saved, so a missing or
 * broken email configuration can never block or precede the answer.
 */
export async function submitRsvpWithConfirmation(
  supabase: Client,
  token: string,
  responses: readonly RsvpResponse[],
  getDelivery: () => EmailDelivery | null,
): Promise<SubmitRsvpWithConfirmationResult> {
  const saved = await submitGuestRsvp(supabase, token, responses);
  if (!saved.ok) return { rsvp: "failed", reason: saved.reason };

  let confirmation: RsvpConfirmationOutcome;
  try {
    confirmation = await sendRsvpConfirmation(supabase, token, saved.party, getDelivery);
  } catch {
    // Defensive: every step below already maps its own failures. Nothing
    // here may ever undo or hide a saved RSVP.
    confirmation = "not_sent";
  }
  return { rsvp: "saved", party: saved.party, confirmation };
}

async function sendRsvpConfirmation(
  supabase: Client,
  token: string,
  party: GuestParty,
  getDelivery: () => EmailDelivery | null,
): Promise<RsvpConfirmationOutcome> {
  const delivery = getDelivery();
  if (!delivery) return "not_configured";

  const tokenHash = hashCapabilityToken(token);
  const read = await delivery.recorder.readRsvpConfirmationContext(tokenHash);
  if (!read.ok) return "not_sent";
  const context = read.context;
  if (!context.recipient) return "skipped_no_email";
  // Stored values passed the database CHECK; re-checked before they become
  // a provider recipient.
  if (!isStoredContactEmail(context.recipient)) return "not_sent";

  const siteSlug = await getGuestPartySiteSlug(supabase, token);
  const email = renderRsvpConfirmationEmail({
    partyLabel: party.label,
    weddingName: context.weddingName,
    weddingDate: context.weddingDate,
    weddingCity: context.weddingCity,
    guests: party.guests.flatMap((guest) =>
      guest.attending === null ? [] : [{ name: guest.name, attending: guest.attending }],
    ),
    siteUrl: siteSlug ? new URL(publicSitePath(siteSlug), delivery.appOrigin).toString() : null,
  });

  let sent;
  try {
    sent = await delivery.sender.send({ to: context.recipient, ...email });
  } catch {
    return "provider_failed";
  }
  if (!sent.ok) return "provider_failed";

  // From here on the email is out: any problem is "sent but unrecorded".
  // Without a storable id there is nothing trustworthy to record (the
  // database keeps the three fields together).
  if (!sent.messageId) return "sent_but_unrecorded";
  try {
    const recorded = await delivery.recorder.recordRsvpConfirmation({
      weddingId: context.weddingId,
      guestInvitationId: context.guestInvitationId,
      tokenHash,
      recipient: context.recipient,
      providerMessageId: sent.messageId,
    });
    return recorded.ok ? "sent" : "sent_but_unrecorded";
  } catch {
    return "sent_but_unrecorded";
  }
}
