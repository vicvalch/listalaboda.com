import { normalizeEmailForComparison } from "@/lib/guests/contact-email";
import { es } from "@/lib/i18n/messages/es";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Email delivery status for organizers (LB-18.3, ADR-011 §9). Pure, so the
 * rules are unit-tested; the guest page applies them to the rows it loaded in
 * its one guest-list query.
 *
 * Two different questions, never mixed up:
 *
 * 1. "What happened to the email shown on this line?" — the status of the
 *    latest recorded delivery of that kind for the party (`latestDelivery`),
 *    shown next to the existing "enviada el … a …" text, which names the
 *    address it went to. Sends recorded before LB-18.1 have no row:
 *    "Estado de entrega no disponible".
 * 2. "Can we email the CURRENT contact address?" (`recipientBlock`) — blocked
 *    only when a delivery to that address in this wedding was suppressed,
 *    bounced or complained, compared case-insensitively
 *    (`normalizeEmailForComparison`: a case-only edit is the same address). A
 *    genuinely different address is never blocked by an old one; delayed,
 *    failed, delivered and accepted never block.
 *
 * The sends themselves are guarded by the database's own determination
 * (`private.email_recipient_block`, through `@/lib/guests/email-block`); this
 * mirror only decides what the page shows.
 */

export type DeliveryStatus = Database["public"]["Enums"]["email_delivery_status"];
export type DeliveryKind = Database["public"]["Enums"]["email_delivery_kind"];

/** What a member may read of one ledger row (never the provider id). */
export type PartyDelivery = Readonly<{
  kind: DeliveryKind;
  recipient: string;
  acceptedAt: string;
  status: DeliveryStatus;
}>;

/** The three statuses that mean "don't email this address again". */
export type RecipientBlock = "none" | "suppressed" | "bounced" | "complained";

const BLOCK_STRENGTH: Readonly<Record<RecipientBlock, number>> = {
  none: 0,
  suppressed: 1,
  bounced: 2,
  complained: 3,
};

/** Only suppressed, bounced and complained block; everything else is retryable. */
export function blockOfStatus(status: DeliveryStatus): RecipientBlock {
  switch (status) {
    case "suppressed":
    case "bounced":
    case "complained":
      return status;
    case "accepted":
    case "delayed":
    case "failed":
    case "delivered":
      return "none";
  }
}

/**
 * The strongest block of `recipient` among one wedding's deliveries (the
 * caller passes only that wedding's rows). Addresses are compared in their
 * comparison form, like the database. No address → nothing to block.
 */
export function recipientBlock(deliveries: readonly PartyDelivery[], recipient: string | null): RecipientBlock {
  if (!recipient) return "none";
  const target = normalizeEmailForComparison(recipient);
  let strongest: RecipientBlock = "none";
  for (const delivery of deliveries) {
    if (normalizeEmailForComparison(delivery.recipient) !== target) continue;
    const block = blockOfStatus(delivery.status);
    if (BLOCK_STRENGTH[block] > BLOCK_STRENGTH[strongest]) strongest = block;
  }
  return strongest;
}

/** Which warning a blocked current address shows; null = sendable. */
export type RecipientWarning = "undeliverable" | "complained" | null;

/** The warning a blocked current address shows (complaints are worded more strongly). */
export function recipientWarning(block: RecipientBlock): RecipientWarning {
  if (block === "none") return null;
  return block === "complained" ? "complained" : "undeliverable";
}

/**
 * The latest delivery among `kinds` for one party (newest `acceptedAt`). The
 * two reminder kinds are passed together: the reminder line shows the latest
 * reminder of either channel, and keeps its kind so an automatic one is
 * labelled as such.
 */
export function latestDelivery(
  deliveries: readonly PartyDelivery[],
  kinds: readonly DeliveryKind[],
): PartyDelivery | null {
  let latest: PartyDelivery | null = null;
  for (const delivery of deliveries) {
    if (!kinds.includes(delivery.kind)) continue;
    if (!latest || Date.parse(delivery.acceptedAt) > Date.parse(latest.acceptedAt)) latest = delivery;
  }
  return latest;
}

/**
 * The delivery a "last sent" line is about: the latest of its kinds, but only
 * when it IS that send (same database clock; the record writes both in one
 * transaction). A send recorded before the ledger existed has no row, and a
 * mismatch is never guessed: both are `null` ("no disponible").
 */
export function deliveryForSend(
  deliveries: readonly PartyDelivery[],
  kinds: readonly DeliveryKind[],
  sentAt: string,
): PartyDelivery | null {
  const latest = latestDelivery(deliveries, kinds);
  return latest && Date.parse(latest.acceptedAt) === Date.parse(sentAt) ? latest : null;
}

export const INVITATION_KINDS: readonly DeliveryKind[] = ["guest_invitation"];
export const CONFIRMATION_KINDS: readonly DeliveryKind[] = ["rsvp_confirmation"];
export const REMINDER_KINDS: readonly DeliveryKind[] = ["rsvp_reminder_manual", "rsvp_reminder_automatic"];

/**
 * The words shown for a line's delivery (catalog copy only; never enum names,
 * provider ids or event times). `accepted` is "Enviado", never "Entregado". An
 * automatic reminder says so.
 */
export function deliveryStatusLabel(delivery: PartyDelivery | null): string {
  const copy = es.guests.delivery;
  if (!delivery) return copy.unavailable;
  const label = copy.status[delivery.status];
  return delivery.kind === "rsvp_reminder_automatic" ? `${label} (${copy.automatic})` : label;
}
