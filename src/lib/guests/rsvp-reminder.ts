import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { requireWeddingMembership, type WeddingAccess } from "@/lib/authz/wedding";
import type { EmailDelivery } from "@/lib/email/delivery";
import { renderRsvpReminderEmail } from "@/lib/email/rsvp-reminder";
import { isStoredContactEmail } from "@/lib/guests/contact-email";
import { guestRsvpUrl } from "@/lib/guests/link";
import type { GuestLinkConfig } from "@/lib/guests/link-config";
import { recoverCurrentCapability, type RecoverCapabilityResult } from "@/lib/guests/link-recovery";
import { renderRsvpReminderMessage } from "@/lib/guests/rsvp-reminder-message";
import type { RsvpCapabilityEncryptionSettings } from "@/lib/security/rsvp-capability-encryption";
import type { Database } from "@/lib/supabase/database.types";
import { getPublishedSitePath } from "@/lib/wedding-site/service";
import { getWeddingDetail } from "@/lib/weddings/service";

/**
 * Manual RSVP reminders (LB-14, ADR-007): an organizer explicitly reminds a
 * party, with the party's CURRENT RSVP link — the same link it already has.
 * Two channels:
 *
 * - `sendRsvpReminderEmail` — "Enviar recordatorio": one email to the
 *   party's CURRENT contact email (read from the database now, never from
 *   the browser), carrying the current link.
 * - `prepareRsvpReminderMessage` — "Preparar mensaje para WhatsApp": plain
 *   text the organizer copies and sends themselves. Not a delivery: nothing
 *   is sent, stored or recorded.
 *
 * Any member (owner or collaborator), like link recovery. The link is
 * recovered INSIDE the action (`recoverCurrentCapability`, LB-13): never a
 * token from the browser, so a link rotated after the page loaded is the
 * one used, and a revoked/expired one stops everything. This module never
 * generates, rotates, revokes or stores a link: there is no code path from
 * here to `generateCapabilityToken` or the rotation RPC. Legacy (hash-only)
 * or undecryptable links can't be reminded; only an owner's explicit
 * "Generar nuevo enlace" repairs them.
 *
 * Email order: authorize (the user's own session) → validate → email
 * configuration and link key → the party and its current recipient (scoped
 * to the authorized wedding) → recover the current link → wedding context →
 * render → ONE provider call → only after the provider accepted, the
 * privileged recorder (`delivery.recorder`, ADR-007). The provider is never
 * called before every check passed and the recorder never before the
 * provider accepted; neither authorizes. No automatic retries.
 *
 * Nothing is logged. The token exists only in memory, the email body and
 * the prepared text; the recorder gets its hash.
 */

type Client = SupabaseClient<Database>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The caller can't act on this wedding/party at all (handled like any guest-list action). */
export type ReminderAccessFailure = "unauthenticated" | "not_found" | "invalid_target" | "error";

/** Why no reminder could be built: the link itself, never touched. */
type ReminderLinkFailure = "link_not_configured" | "link_unrecoverable" | "link_unavailable";

export type ReminderSendOutcome =
  | Readonly<{ outcome: "sent"; recipient: string; sentAt: string }>
  /** The provider accepted; the status couldn't be saved. Never "not sent". */
  | Readonly<{ outcome: "sent_but_unrecorded"; recipient: string }>
  | Readonly<{
      outcome:
        | "no_email"
        | "email_not_configured"
        | ReminderLinkFailure
        | "recipient_rejected"
        | "provider_failed";
    }>
  | Readonly<{ outcome: "failed"; reason: ReminderAccessFailure }>;

export type ReminderMessageResult =
  | Readonly<{ ok: true; message: string }>
  | Readonly<{ ok: false; reason: ReminderAccessFailure | ReminderLinkFailure }>;

type Authorized = Readonly<{ ok: true; access: WeddingAccess }> | Readonly<{ ok: false; reason: ReminderAccessFailure }>;

async function authorize(supabase: Client, weddingId: string, guestInvitationId: string): Promise<Authorized> {
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) {
    // Membership is the whole permission model here; "forbidden" can't happen.
    return { ok: false, reason: access.reason === "forbidden" ? "error" : access.reason };
  }
  if (!UUID_PATTERN.test(guestInvitationId)) return { ok: false, reason: "invalid_target" };
  return { ok: true, access: access.access };
}

type Party = Readonly<{ id: string; label: string; contactEmail: string | null }>;

/** The party in the authorized wedding, as stored NOW. */
async function loadParty(
  supabase: Client,
  access: WeddingAccess,
  guestInvitationId: string,
): Promise<Party | "invalid_target" | "error"> {
  try {
    const { data, error } = await supabase
      .from("guest_invitations")
      .select("id, label, contact_email")
      .eq("id", guestInvitationId)
      .eq("wedding_id", access.weddingId)
      .maybeSingle();
    if (error) return "error";
    if (!data) return "invalid_target";
    return { id: data.id, label: data.label, contactEmail: data.contact_email };
  } catch {
    return "error";
  }
}

type RecoveryFailure = Extract<RecoverCapabilityResult, { ok: false }>["reason"];

function recoveryFailure(reason: RecoveryFailure): ReminderLinkFailure | "invalid_target" | "error" {
  switch (reason) {
    case "unavailable":
      return "link_unavailable";
    case "legacy":
    case "unrecoverable":
      return "link_unrecoverable";
    default:
      return reason;
  }
}

/** "Enviar recordatorio": the current link to the current contact email, once. */
export async function sendRsvpReminderEmail(
  supabase: Client,
  weddingId: string,
  guestInvitationId: string,
  delivery: EmailDelivery | null,
  /** The server's link key (ADR-006); null = recovery isn't configured. */
  encryption: RsvpCapabilityEncryptionSettings | null,
): Promise<ReminderSendOutcome> {
  const authorized = await authorize(supabase, weddingId, guestInvitationId);
  if (!authorized.ok) return { outcome: "failed", reason: authorized.reason };
  const { access } = authorized;
  if (!delivery) return { outcome: "email_not_configured" };
  if (!encryption) return { outcome: "link_not_configured" };

  const party = await loadParty(supabase, access, guestInvitationId);
  if (typeof party === "string") return { outcome: "failed", reason: party };
  if (!party.contactEmail) return { outcome: "no_email" };
  // Stored values passed the database CHECK; re-checked before they become
  // a provider recipient.
  if (!isStoredContactEmail(party.contactEmail)) return { outcome: "recipient_rejected" };
  const recipient = party.contactEmail;

  const recovered = await recoverCurrentCapability(supabase, access, party.id, encryption);
  if (!recovered.ok) {
    const reason = recoveryFailure(recovered.reason);
    return reason === "invalid_target" || reason === "error" ? { outcome: "failed", reason } : { outcome: reason };
  }
  const { token, tokenHash } = recovered.capability;

  const [wedding, sitePath] = await Promise.all([
    getWeddingDetail(supabase, access.weddingId),
    getPublishedSitePath(supabase, access),
  ]);
  if (!wedding) return { outcome: "failed", reason: "error" };

  const email = renderRsvpReminderEmail({
    partyLabel: party.label,
    weddingName: wedding.name,
    weddingDate: wedding.weddingDate,
    weddingCity: wedding.city,
    rsvpUrl: guestRsvpUrl(token, delivery.appOrigin),
    siteUrl: sitePath ? new URL(sitePath, delivery.appOrigin).toString() : null,
  });

  let sent;
  try {
    sent = await delivery.sender.send({ to: recipient, ...email });
  } catch {
    return { outcome: "provider_failed" };
  }
  if (!sent.ok) {
    if (sent.reason === "configuration") return { outcome: "email_not_configured" };
    if (sent.reason === "invalid_recipient") return { outcome: "recipient_rejected" };
    return { outcome: "provider_failed" };
  }

  // From here on the email is out: any problem is "sent but unrecorded".
  // Without a storable id there is nothing trustworthy to record (the
  // database keeps the three fields together), so it isn't recorded.
  const unrecorded = { outcome: "sent_but_unrecorded", recipient } as const;
  if (!sent.messageId) return unrecorded;
  try {
    const recorded = await delivery.recorder.recordRsvpReminder({
      weddingId: access.weddingId,
      guestInvitationId: party.id,
      tokenHash,
      recipient,
      providerMessageId: sent.messageId,
      // LB-15: the member who sent it, from this action's own membership check.
      actingUserId: access.userId,
    });
    return recorded.ok ? { outcome: "sent", recipient, sentAt: recorded.sentAt } : unrecorded;
  } catch {
    return unrecorded;
  }
}

/**
 * "Preparar mensaje para WhatsApp": the WhatsApp-ready text with the
 * party's current link, for the organizer to copy. Same authorization and
 * recovery as the email; no provider, recorder, phone number or storage.
 */
export async function prepareRsvpReminderMessage(
  supabase: Client,
  weddingId: string,
  guestInvitationId: string,
  /** `getGuestLinkConfig()`: trusted origin + key; null = not configured. */
  config: GuestLinkConfig | null,
): Promise<ReminderMessageResult> {
  const authorized = await authorize(supabase, weddingId, guestInvitationId);
  if (!authorized.ok) return authorized;
  const { access } = authorized;
  if (!config) return { ok: false, reason: "link_not_configured" };

  const party = await loadParty(supabase, access, guestInvitationId);
  if (typeof party === "string") return { ok: false, reason: party };

  const recovered = await recoverCurrentCapability(supabase, access, party.id, config.encryption);
  if (!recovered.ok) return { ok: false, reason: recoveryFailure(recovered.reason) };

  const wedding = await getWeddingDetail(supabase, access.weddingId);
  if (!wedding) return { ok: false, reason: "error" };

  return {
    ok: true,
    message: renderRsvpReminderMessage({
      partyLabel: party.label,
      weddingName: wedding.name,
      weddingDate: wedding.weddingDate,
      rsvpUrl: guestRsvpUrl(recovered.capability.token, config.appOrigin),
    }),
  };
}
