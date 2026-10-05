import type { ChecklistStatus } from "@/lib/checklist/types";

/**
 * Checklist ↔ guest work (LB-16, ADR-009): pure helpers shared by the
 * checklist and the guest list. An item may be about zero or one guest
 * party of its own wedding (`checklist_items.guest_invitation_id`); the
 * relation is navigation and context, never authorization.
 *
 * Routes are derived here from ids and app constants only: nothing about
 * them is stored, read from user input or carries a capability (no token,
 * no RSVP URL, no query string).
 */

/** What the checklist knows about a party: its id and CURRENT label, nothing else. */
export type GuestPartyOption = Readonly<{ id: string; label: string }>;

/** A checklist item as the guest list shows it: no description, assignee or timing. */
export type RelatedChecklistItem = Readonly<{
  id: string;
  title: string;
  status: ChecklistStatus;
}>;

function weddingPath(weddingId: string): string {
  return `/app/weddings/${encodeURIComponent(weddingId)}`;
}

/** DOM id of a checklist row (also its `#` target). */
export function checklistItemAnchor(itemId: string): string {
  return `item-${itemId}`;
}

/** DOM id of a party card on "Invitados" (also its `#` target). */
export function guestPartyAnchor(guestInvitationId: string): string {
  return `party-${guestInvitationId}`;
}

/** The item on the wedding's home (the default list view, where every item is rendered). */
export function checklistItemHref(weddingId: string, itemId: string): string {
  return `${weddingPath(weddingId)}#${encodeURIComponent(checklistItemAnchor(itemId))}`;
}

/** The party's card on "Invitados". */
export function guestPartyHref(weddingId: string, guestInvitationId: string): string {
  return `${weddingPath(weddingId)}/guests#${encodeURIComponent(guestPartyAnchor(guestInvitationId))}`;
}

/**
 * The party an item is linked to, from the wedding's current parties. null
 * when the item isn't linked, or when its party is no longer in the list
 * (deleted between reads): then it shows as unlinked, never as a broken link.
 */
export function linkedParty(
  parties: readonly GuestPartyOption[],
  guestInvitationId: string | null,
): GuestPartyOption | null {
  if (guestInvitationId === null) return null;
  return parties.find((party) => party.id === guestInvitationId) ?? null;
}
