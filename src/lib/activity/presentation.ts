import { interpolate } from "@/lib/i18n";
import { es } from "@/lib/i18n/messages/es";
import type { Database } from "@/lib/supabase/database.types";
import type { LabeledMember } from "@/lib/weddings/members";

/**
 * How the activity history reads (LB-15). Pure functions only.
 *
 * The database stores a closed event type and actor kind, never text; the
 * words live here and in the catalog (`es.activity`), so copy can change
 * without rewriting history. Every known event has a label (the mapping is
 * exhaustive over the database enum); anything unexpected falls back to a
 * neutral word instead of failing the page.
 */

export type ActivityEventType = Database["public"]["Enums"]["wedding_activity_event"];
export type ActivityActorKind = Database["public"]["Enums"]["wedding_activity_actor"];

const copy = es.activity;

const EVENT_LABELS: Readonly<Record<ActivityEventType, string>> = {
  guest_invitation_created: copy.events.guestInvitationCreated,
  guest_invitation_link_rotated: copy.events.guestInvitationLinkRotated,
  guest_invitation_revoked: copy.events.guestInvitationRevoked,
  guest_invitation_contact_email_changed: copy.events.guestInvitationContactEmailChanged,
  guest_invitation_email_sent: copy.events.guestInvitationEmailSent,
  guest_rsvp_submitted: copy.events.guestRsvpSubmitted,
  guest_rsvp_updated: copy.events.guestRsvpUpdated,
  rsvp_confirmation_email_sent: copy.events.rsvpConfirmationEmailSent,
  rsvp_reminder_email_sent: copy.events.rsvpReminderEmailSent,
};

/** "Invitación creada", "RSVP actualizado"…; a neutral word for anything unknown. */
export function activityEventLabel(eventType: string): string {
  return Object.hasOwn(EVENT_LABELS, eventType)
    ? EVENT_LABELS[eventType as ActivityEventType]
    : copy.events.unknown;
}

/** The party's current label, or "Grupo eliminado" once it was deleted. */
export function activityPartyLabel(partyLabel: string | null): string {
  return partyLabel ?? copy.deletedParty;
}

/**
 * Who did it:
 *   - a member still in the wedding: their usual label ("Tú", their name,
 *     "Persona colaboradora"…);
 *   - a member who left (or whose account is gone): a neutral fallback;
 *   - the party's link holder: the group, never a person's name;
 *   - the system: "Sistema" (never "service_role").
 */
export function activityActorLabel(
  actorKind: string,
  actorMembershipId: string | null,
  members: readonly LabeledMember[],
): string {
  switch (actorKind) {
    case "member":
      return (
        (actorMembershipId === null
          ? undefined
          : members.find((m) => m.membershipId === actorMembershipId)?.label) ?? copy.actors.formerMember
      );
    case "guest_capability":
      return copy.actors.guest;
    default:
      return copy.actors.system;
  }
}

/** "Por Tú" reads oddly; "Por {actor}" for everyone else. */
export function activityActorLine(actorLabel: string): string {
  return actorLabel === es.members.you ? copy.byYou : interpolate(copy.by, { actor: actorLabel });
}

/**
 * The full attribution line for one entry. An automatic RSVP reminder (LB-17,
 * ADR-010 §20: `rsvp_reminder_email_sent` by the `system` actor) reads
 * "Automático" — never a person, since nobody clicked it. A manual reminder
 * keeps its member attribution; everything else is `activityActorLine`.
 */
export function activityAttribution(
  eventType: string,
  actorKind: string,
  actorMembershipId: string | null,
  members: readonly LabeledMember[],
): string {
  if (eventType === "rsvp_reminder_email_sent" && actorKind === "system") return copy.automatic;
  return activityActorLine(activityActorLabel(actorKind, actorMembershipId, members));
}
