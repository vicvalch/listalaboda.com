import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  requireWeddingMembership,
  requireWeddingRole,
  type WeddingAccess,
} from "@/lib/authz/wedding";
import type { EmailDelivery } from "@/lib/email/delivery";
import { renderInvitationEmail } from "@/lib/email/invitation";
import { isStoredContactEmail } from "@/lib/guests/contact-email";
import { guestRsvpPath } from "@/lib/guests/link";
import { replaceGuestPartyLink, type FreshLink } from "@/lib/guests/service";
import { hashCapabilityToken, isWellFormedCapabilityToken } from "@/lib/security/capability-token";
import type { Database } from "@/lib/supabase/database.types";
import { getPublishedSitePath } from "@/lib/wedding-site/service";
import { getWeddingDetail } from "@/lib/weddings/service";

/**
 * Sending a party's invitation by email (LB-11). Two entry points, because
 * the stored link can't be reconstructed (only its hash exists):
 *
 * - `sendGuestInvitationEmail` — any member, with a FRESH link they were
 *   just shown (party created, or link rotated): the browser sends the
 *   token back, the database confirms it is the party's current, usable
 *   link (`guest_invitation_link_is_current`), and the server builds the
 *   URL itself. Never rotates anything.
 * - `rotateLinkAndSendInvitation` — OWNER only: "Generar nuevo enlace y
 *   enviar". Replaces the link (the old one stops working; guests and RSVPs
 *   stay), then sends the new one. A collaborator gets `forbidden` before
 *   anything happens, and the database refuses the rotation anyway.
 *
 * Order, for both: authorize (the user's own session) → validate input →
 * configuration → load the party (scoped to the authorized wedding) and its
 * recipient → current link → everything the email needs → [rotate] → ONE
 * provider call → only after the provider accepted, record the send through
 * the privileged recorder (`delivery.recorder`, ADR-004). The provider is
 * never called before every check passed, the recorder never before the
 * provider accepted, and neither takes part in authorization. No automatic
 * retries. The provider id comes from the provider's response only.
 *
 * Not transactional with the provider, and it doesn't pretend to be:
 * - provider fails → nothing recorded; a rotated link stays rotated (never
 *   rolled back) and is returned so the owner can copy it or retry;
 * - provider accepts but recording fails → `sent_but_unrecorded` (never
 *   "not sent", which would invite a duplicate).
 *
 * Nothing is logged. The token and the link exist only in memory, the
 * email body and the returned fresh link.
 */

type Client = SupabaseClient<Database>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SendInvitationFailure =
  | "unauthenticated"
  | "not_found"
  | "forbidden"
  | "invalid_target"
  | "invalid_token"
  | "missing_email"
  | "invalid_email"
  | "configuration_error"
  | "recipient_rejected"
  | "provider_failed"
  | "error";

export type SendInvitationOutcome =
  | Readonly<{ outcome: "sent"; recipient: string; sentAt: string }>
  | Readonly<{ outcome: "sent_but_unrecorded"; recipient: string }>
  | Readonly<{ outcome: "failed"; reason: SendInvitationFailure }>;

/** Rotate + send: the new link is returned whenever the rotation happened. */
export type RotateAndSendOutcome = SendInvitationOutcome & Readonly<{ link?: FreshLink }>;

function failed(reason: SendInvitationFailure): SendInvitationOutcome {
  return { outcome: "failed", reason };
}

type PartyForEmail = Readonly<{ id: string; label: string; recipient: string }>;

/** The party in the authorized wedding, with a usable recipient. */
async function loadParty(
  supabase: Client,
  access: WeddingAccess,
  guestInvitationId: string,
): Promise<PartyForEmail | SendInvitationFailure> {
  try {
    const { data, error } = await supabase
      .from("guest_invitations")
      .select("id, label, contact_email")
      .eq("id", guestInvitationId)
      .eq("wedding_id", access.weddingId)
      .maybeSingle();
    if (error) return "error";
    if (!data) return "invalid_target";
    if (!data.contact_email) return "missing_email";
    // Stored values passed the database CHECK; re-checked before they
    // become a provider recipient.
    if (!isStoredContactEmail(data.contact_email)) return "invalid_email";
    return { id: data.id, label: data.label, recipient: data.contact_email };
  } catch {
    return "error";
  }
}

type EmailContext = Readonly<{
  weddingName: string;
  weddingDate: string | null;
  weddingCity: string | null;
  siteUrl: string | null;
}>;

async function loadContext(
  supabase: Client,
  access: WeddingAccess,
  appOrigin: string,
): Promise<EmailContext | null> {
  const [wedding, sitePath] = await Promise.all([
    getWeddingDetail(supabase, access.weddingId),
    getPublishedSitePath(supabase, access),
  ]);
  if (!wedding) return null;
  return {
    weddingName: wedding.name,
    weddingDate: wedding.weddingDate,
    weddingCity: wedding.city,
    siteUrl: sitePath ? new URL(sitePath, appOrigin).toString() : null,
  };
}

/** Renders, sends once, records. Every check has already passed. */
async function deliver(
  supabase: Client,
  access: WeddingAccess,
  party: PartyForEmail,
  token: string,
  context: EmailContext,
  delivery: EmailDelivery,
): Promise<SendInvitationOutcome> {
  const email = renderInvitationEmail({
    partyLabel: party.label,
    weddingName: context.weddingName,
    weddingDate: context.weddingDate,
    weddingCity: context.weddingCity,
    rsvpUrl: new URL(guestRsvpPath(token), delivery.appOrigin).toString(),
    siteUrl: context.siteUrl,
  });

  let sent;
  try {
    sent = await delivery.sender.send({ to: party.recipient, ...email });
  } catch {
    return failed("provider_failed");
  }
  if (!sent.ok) {
    if (sent.reason === "configuration") return failed("configuration_error");
    if (sent.reason === "invalid_recipient") return failed("recipient_rejected");
    return failed("provider_failed");
  }

  // From here on the email is out: any problem is "sent but unrecorded".
  // Without a storable id there is nothing trustworthy to record (the
  // database keeps the three send fields together), so it isn't recorded.
  const unrecorded = { outcome: "sent_but_unrecorded", recipient: party.recipient } as const;
  if (!sent.messageId) return unrecorded;
  try {
    const recorded = await delivery.recorder.record({
      weddingId: access.weddingId,
      guestInvitationId: party.id,
      tokenHash: hashCapabilityToken(token),
      recipient: party.recipient,
      providerMessageId: sent.messageId,
    });
    if (!recorded.ok) return unrecorded;
    return { outcome: "sent", recipient: party.recipient, sentAt: recorded.sentAt };
  } catch {
    return unrecorded;
  }
}

/**
 * "Enviar invitación por correo" with the fresh link the caller was just
 * shown. Any member. `token` is untrusted input: it must be well formed AND
 * be this party's current, usable link, or nothing is sent.
 */
export async function sendGuestInvitationEmail(
  supabase: Client,
  weddingId: string,
  guestInvitationId: string,
  token: string,
  delivery: EmailDelivery | null,
): Promise<SendInvitationOutcome> {
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) return failed(access.reason);
  if (!UUID_PATTERN.test(guestInvitationId)) return failed("invalid_target");
  if (!isWellFormedCapabilityToken(token)) return failed("invalid_token");
  if (!delivery) return failed("configuration_error");

  const party = await loadParty(supabase, access.access, guestInvitationId);
  if (typeof party === "string") return failed(party);

  try {
    const { data, error } = await supabase.rpc("guest_invitation_link_is_current", {
      target_wedding_id: access.access.weddingId,
      target_invitation_id: party.id,
      invitation_token_hash: hashCapabilityToken(token),
    });
    if (error) return failed("error");
    if (data !== true) return failed("invalid_token");
  } catch {
    return failed("error");
  }

  const context = await loadContext(supabase, access.access, delivery.appOrigin);
  if (!context) return failed("error");
  return deliver(supabase, access.access, party, token, context, delivery);
}

/**
 * "Generar nuevo enlace y enviar" — owner only, explicit. Everything that
 * could stop the email (role, party, recipient, configuration, wedding
 * data) is checked BEFORE the link is replaced, so a doomed send never
 * kills a working link. After the rotation the new link is always
 * returned, whatever happens to the email.
 */
export async function rotateLinkAndSendInvitation(
  supabase: Client,
  weddingId: string,
  guestInvitationId: string,
  delivery: EmailDelivery | null,
): Promise<RotateAndSendOutcome> {
  const access = await requireWeddingRole(supabase, weddingId, ["owner"]);
  if (!access.ok) return failed(access.reason);
  if (!UUID_PATTERN.test(guestInvitationId)) return failed("invalid_target");
  if (!delivery) return failed("configuration_error");

  const party = await loadParty(supabase, access.access, guestInvitationId);
  if (typeof party === "string") return failed(party);
  const context = await loadContext(supabase, access.access, delivery.appOrigin);
  if (!context) return failed("error");

  const rotated = await replaceGuestPartyLink(supabase, access.access, party.id, delivery.appOrigin);
  if (!rotated.ok) return failed(rotated.reason);
  const link: FreshLink = { link: rotated.link, token: rotated.token };

  const outcome = await deliver(supabase, access.access, party, rotated.token, context, delivery);
  return { ...outcome, link };
}
