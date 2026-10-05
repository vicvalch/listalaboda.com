import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  requireWeddingMembership,
  requireWeddingRole,
  type WeddingAccess,
} from "@/lib/authz/wedding";
import type { GuestPartyOption, RelatedChecklistItem } from "@/lib/checklist/guest-work";
import { guestRsvpUrl } from "@/lib/guests/link";
import type { GuestResponse } from "@/lib/guests/summary";
import type { NewPartyInput } from "@/lib/guests/validation";
import { generateCapabilityToken, type CapabilityToken } from "@/lib/security/capability-token";
import {
  encryptRsvpCapability,
  type RsvpCapabilityEncryptionSettings,
} from "@/lib/security/rsvp-capability-encryption";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Organizer side of the guest list: parties (GuestInvitations), their guests
 * and their links. Any member of the wedding — owner or collaborator — may
 * manage the content: the guest list is shared wedding planning
 * (Constitution §10, PRIVATE: wedding members). Creating a party also
 * creates its first link, so a collaborator's party is usable at once.
 *
 * Replacing or revoking a link later is owner-only: it changes an external
 * bearer-capability boundary. Checked here first (`requireWeddingRole`),
 * then by the database (the rotate/revoke RPCs check the owner role; the
 * link guard trigger backs them up). Since LB-15 each party fact is also
 * recorded in the wedding activity history by the database, in the same
 * transaction (`@/lib/activity/service` reads it).
 *
 * Every function takes the current user's RLS-bound client and resolves
 * membership server-side first (`@/lib/authz/wedding`); ids from the
 * browser are lookup keys, and every write is scoped to the authorized
 * wedding. RLS, column grants, composite same-wedding FKs and the party
 * triggers are the backstop.
 *
 * A guest link's plaintext token is never logged, stored or echoed in
 * errors. Since LB-13 (ADR-006) every new or rotated link is also stored
 * as an AES-256-GCM envelope (server-side key, `encryption`), written in
 * the same transaction as its hash, so members can later recover the SAME
 * link (`@/lib/guests/link-recovery`). Without a valid key, creating a
 * party or rotating a link fails BEFORE any write: no new hash-only links.
 * Organizers never write RSVPs.
 *
 * LB-11: a party may have a contact email (PRIVATE, members only), managed
 * like any guest-list content. Setting, changing or removing it never
 * touches the link or the RSVPs. Sending the invitation email lives in
 * `@/lib/guests/invitation-email`; manual reminders (LB-14) in
 * `@/lib/guests/rsvp-reminder`.
 */

type Client = SupabaseClient<Database>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Denials that mean the caller can't act on this wedding at all. */
type AccessDenial = "unauthenticated" | "not_found" | "error";

function accessDenial(reason: "unauthenticated" | "not_found" | "forbidden" | "error"): AccessDenial {
  // Membership is the whole permission model here; "forbidden" (a member
  // lacking a role) can't happen, and is treated as unexpected.
  return reason === "forbidden" ? "error" : reason;
}

type DbError = Readonly<{ code?: string; message?: string }>;

/**
 * A new link ready to store: the token (for the one link returned), its
 * hash (the validator) and its envelope (for recovery). null when the
 * envelope can't be made — the caller then writes nothing.
 */
function newRecoverableLink(
  encryption: RsvpCapabilityEncryptionSettings | null,
): (CapabilityToken & Readonly<{ envelope: string }>) | null {
  if (!encryption) return null;
  const { token, tokenHash } = generateCapabilityToken();
  try {
    return { token, tokenHash, envelope: encryptRsvpCapability({ token, tokenHash, key: encryption.key }) };
  } catch {
    return null;
  }
}

function isLastGuestError(error: DbError): boolean {
  return error.code === "23514" && error.message === "guest_invitation_needs_guest";
}

/** `origin` must be the trusted `APP_ORIGIN` (`getGuestLinkConfig`), never a request header. */
function linkUrl(token: string, origin: string): string {
  return guestRsvpUrl(token, origin);
}

// -------------------------------------------------------------------- list

export type GuestListGuest = Readonly<{
  id: string;
  name: string;
  /** null = "Sin responder". */
  rsvp: (NonNullable<GuestResponse> & Readonly<{ dietaryNote: string | null }>) | null;
}>;

/** The latest successful invitation email; null = never sent. */
export type InvitationEmailStatus = Readonly<{ sentAt: string; sentTo: string }> | null;

/**
 * The latest successful RSVP confirmation email (LB-12); null = never sent.
 * Separate from the invitation: different email, different moment.
 */
export type RsvpConfirmationEmailStatus = Readonly<{ sentAt: string; sentTo: string }> | null;

/**
 * The latest successful RSVP reminder email (LB-14); null = never sent.
 * Separate from the invitation and the confirmation: a third, distinct email.
 */
export type RsvpReminderEmailStatus = Readonly<{ sentAt: string; sentTo: string }> | null;

export type GuestListParty = Readonly<{
  id: string;
  label: string;
  tokenIssuedAt: string;
  revokedAt: string | null;
  /** PRIVATE: shown only to members, on this page. */
  contactEmail: string | null;
  invitationEmail: InvitationEmailStatus;
  rsvpConfirmationEmail: RsvpConfirmationEmailStatus;
  rsvpReminderEmail: RsvpReminderEmailStatus;
  guests: readonly GuestListGuest[];
  /**
   * LB-16: the checklist items about this party, in the checklist's order.
   * Id, title and status only: navigation back to the list, not a copy of it.
   */
  relatedChecklistItems: readonly RelatedChecklistItem[];
}>;

/**
 * The whole guest list of the wedding — parties, their guests, each guest's
 * current response and (LB-16) the checklist items about each party — in
 * ONE query (nested select), never per party.
 * Takes the `WeddingAccess` of a successful membership check, so it can't
 * run before one. Never selects token_hash (it isn't readable anyway).
 * Returns null on failure.
 */
export async function listGuestParties(
  supabase: Client,
  access: WeddingAccess,
): Promise<GuestListParty[] | null> {
  try {
    const { data, error } = await supabase
      .from("guest_invitations")
      .select(
        "id, label, token_issued_at, revoked_at, contact_email, invitation_email_sent_at, invitation_email_sent_to, rsvp_confirmation_email_sent_at, rsvp_confirmation_email_sent_to, rsvp_reminder_email_sent_at, rsvp_reminder_email_sent_to, created_at, guests(id, name, created_at, rsvps(attending, dietary_note)), checklist_items(id, title, status, sort_order, created_at)",
      )
      .eq("wedding_id", access.weddingId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (error || !data) return null;

    return data.map((party) => ({
      id: party.id,
      label: party.label,
      tokenIssuedAt: party.token_issued_at,
      revokedAt: party.revoked_at,
      contactEmail: party.contact_email,
      invitationEmail:
        party.invitation_email_sent_at && party.invitation_email_sent_to
          ? { sentAt: party.invitation_email_sent_at, sentTo: party.invitation_email_sent_to }
          : null,
      rsvpConfirmationEmail:
        party.rsvp_confirmation_email_sent_at && party.rsvp_confirmation_email_sent_to
          ? { sentAt: party.rsvp_confirmation_email_sent_at, sentTo: party.rsvp_confirmation_email_sent_to }
          : null,
      rsvpReminderEmail:
        party.rsvp_reminder_email_sent_at && party.rsvp_reminder_email_sent_to
          ? { sentAt: party.rsvp_reminder_email_sent_at, sentTo: party.rsvp_reminder_email_sent_to }
          : null,
      guests: [...party.guests]
        .sort((a, b) =>
          a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1,
        )
        .map((guest) => {
          const rsvp = guest.rsvps[0];
          return {
            id: guest.id,
            name: guest.name,
            rsvp: rsvp ? { attending: rsvp.attending, dietaryNote: rsvp.dietary_note } : null,
          };
        }),
      // The checklist's persisted order (sort_order, created_at, id).
      relatedChecklistItems: [...party.checklist_items]
        .sort(
          (a, b) =>
            a.sort_order - b.sort_order ||
            (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1),
        )
        .map((item) => ({ id: item.id, title: item.title, status: item.status })),
    }));
  } catch {
    return null;
  }
}

/**
 * LB-16: the wedding's parties as the checklist offers them for linking —
 * id and CURRENT label only (no guests, contact email, link state or
 * answers) — in one query, in the guest list's order. Takes the
 * `WeddingAccess` of a successful membership check. Returns null on failure.
 */
export async function listGuestPartyOptions(
  supabase: Client,
  access: WeddingAccess,
): Promise<GuestPartyOption[] | null> {
  try {
    const { data, error } = await supabase
      .from("guest_invitations")
      .select("id, label")
      .eq("wedding_id", access.weddingId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (error || !data) return null;
    return data.map((party) => ({ id: party.id, label: party.label }));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ create party

/**
 * A link just created or rotated: `link` to show and copy; `token` (the
 * same secret) only so the organizer's screen can ask for this exact link
 * to be emailed. Neither is ever stored or logged.
 */
export type FreshLink = Readonly<{ link: string; token: string }>;

export type CreatePartyResult =
  | Readonly<{ ok: true; guestInvitationId: string } & FreshLink>
  | Readonly<{ ok: false; reason: AccessDenial | "invalid" | "configuration_error" }>;

/**
 * Creates a party with its first guests (never empty), its optional contact
 * email and its first link (hash + recoverable envelope), atomically,
 * through `create_guest_invitation` (runs as the caller, RLS applies).
 * Returns the link for the organizer's screen. Never sends anything by
 * itself. Without encryption settings nothing is written
 * (`configuration_error`).
 */
export async function createGuestParty(
  supabase: Client,
  weddingId: string,
  input: NewPartyInput,
  origin: string,
  encryption: RsvpCapabilityEncryptionSettings | null,
): Promise<CreatePartyResult> {
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) return { ok: false, reason: accessDenial(access.reason) };

  const fresh = newRecoverableLink(encryption);
  if (!fresh) return { ok: false, reason: "configuration_error" };
  const { token, tokenHash, envelope } = fresh;
  try {
    const { data, error } = await supabase.rpc("create_guest_invitation", {
      target_wedding_id: access.access.weddingId,
      party_label: input.label,
      invitation_token_hash: tokenHash,
      invitation_token_ciphertext: envelope,
      guest_names: [...input.guestNames],
      ...(input.contactEmail ? { party_contact_email: input.contactEmail } : {}),
    });
    if (error) {
      if (error.code === "23514") return { ok: false, reason: "invalid" };
      if (error.code === "42501") return { ok: false, reason: "not_found" };
      return { ok: false, reason: "error" };
    }
    if (!data || !UUID_PATTERN.test(data)) return { ok: false, reason: "error" };
    return { ok: true, guestInvitationId: data, link: linkUrl(token, origin), token };
  } catch {
    return { ok: false, reason: "error" };
  }
}

// ----------------------------------------------------- party label / delete

export type PartyWriteResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: AccessDenial | "invalid_target" | "invalid" }>;

/** Renames a party. `guestInvitationId` is a lookup key within the authorized wedding. */
export async function updateGuestPartyLabel(
  supabase: Client,
  weddingId: string,
  guestInvitationId: string,
  label: string,
): Promise<PartyWriteResult> {
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) return { ok: false, reason: accessDenial(access.reason) };
  if (!UUID_PATTERN.test(guestInvitationId)) return { ok: false, reason: "invalid_target" };

  try {
    const { data, error } = await supabase
      .from("guest_invitations")
      .update({ label })
      .eq("id", guestInvitationId)
      .eq("wedding_id", access.access.weddingId)
      .select("id");
    if (error) return { ok: false, reason: error.code === "23514" ? "invalid" : "error" };
    if (!data || data.length === 0) return { ok: false, reason: "invalid_target" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/**
 * Deletes a party: its guests and their RSVPs cascade, and its link stops
 * working (the hash is gone). Other parties are untouched. No soft delete.
 */
export async function deleteGuestParty(
  supabase: Client,
  weddingId: string,
  guestInvitationId: string,
): Promise<PartyWriteResult> {
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) return { ok: false, reason: accessDenial(access.reason) };
  if (!UUID_PATTERN.test(guestInvitationId)) return { ok: false, reason: "invalid_target" };

  try {
    const { data, error } = await supabase
      .from("guest_invitations")
      .delete()
      .eq("id", guestInvitationId)
      .eq("wedding_id", access.access.weddingId)
      .select("id");
    if (error) return { ok: false, reason: "error" };
    if (!data || data.length === 0) return { ok: false, reason: "invalid_target" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/**
 * Sets, changes (`email` normalized) or removes (`null`) a party's contact
 * email — any member. The link, guests and RSVPs are untouched, nothing is
 * sent, and the last-sent status stays as it was (it records where that
 * email went).
 */
export async function updateGuestPartyContactEmail(
  supabase: Client,
  weddingId: string,
  guestInvitationId: string,
  email: string | null,
): Promise<PartyWriteResult> {
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) return { ok: false, reason: accessDenial(access.reason) };
  if (!UUID_PATTERN.test(guestInvitationId)) return { ok: false, reason: "invalid_target" };

  try {
    const { data, error } = await supabase
      .from("guest_invitations")
      .update({ contact_email: email })
      .eq("id", guestInvitationId)
      .eq("wedding_id", access.access.weddingId)
      .select("id");
    if (error) return { ok: false, reason: error.code === "23514" ? "invalid" : "error" };
    if (!data || data.length === 0) return { ok: false, reason: "invalid_target" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}

// ------------------------------------------------------------------ links

/** Link administration (rotate/revoke) is owner-only: a collaborator gets `forbidden`. */
type LinkAdminDenial = AccessDenial | "forbidden" | "invalid_target";

export type RotateLinkResult =
  | Readonly<{ ok: true } & FreshLink>
  | Readonly<{ ok: false; reason: LinkAdminDenial | "configuration_error" }>;

export type RevokeLinkResult = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: LinkAdminDenial }>;

function linkAdminWriteError(error: DbError): LinkAdminDenial {
  // The rotate/revoke RPC's owner check: the caller's role changed since ours.
  return error.code === "42501" && error.message === "guest_link_owner_only" ? "forbidden" : "error";
}

/**
 * "Generar nuevo enlace" (owner-only): replaces the party's token hash and
 * its recoverable envelope together. The old link stops working at once; a
 * revoked party is reopened with the NEW link (the database re-stamps
 * token_issued_at and clears revoked_at). Same party, same guests, same
 * RSVPs. Returns the new link (later recoverable). Never runs silently:
 * only on an owner's explicit request.
 */
export async function rotateGuestPartyLink(
  supabase: Client,
  weddingId: string,
  guestInvitationId: string,
  origin: string,
  encryption: RsvpCapabilityEncryptionSettings | null,
): Promise<RotateLinkResult> {
  const access = await requireWeddingRole(supabase, weddingId, ["owner"]);
  if (!access.ok) return { ok: false, reason: access.reason };
  if (!UUID_PATTERN.test(guestInvitationId)) return { ok: false, reason: "invalid_target" };
  return replaceGuestPartyLink(supabase, access.access, guestInvitationId, origin, encryption);
}

/**
 * The rotation write itself, for callers that already hold an OWNER's
 * `WeddingAccess` (this function and the owner-only "new link and send").
 * One call to `rotate_guest_invitation_link` (hash + envelope, one
 * transaction; the database re-checks the owner role). Without encryption
 * settings nothing is written and the old link stays current.
 */
export async function replaceGuestPartyLink(
  supabase: Client,
  access: WeddingAccess,
  guestInvitationId: string,
  origin: string,
  encryption: RsvpCapabilityEncryptionSettings | null,
): Promise<RotateLinkResult> {
  if (access.role !== "owner") return { ok: false, reason: "forbidden" };
  const fresh = newRecoverableLink(encryption);
  if (!fresh) return { ok: false, reason: "configuration_error" };
  const { token, tokenHash, envelope } = fresh;
  try {
    const { data, error } = await supabase.rpc("rotate_guest_invitation_link", {
      target_wedding_id: access.weddingId,
      target_invitation_id: guestInvitationId,
      invitation_token_hash: tokenHash,
      invitation_token_ciphertext: envelope,
    });
    if (error) return { ok: false, reason: linkAdminWriteError(error) };
    if (data !== true) return { ok: false, reason: "invalid_target" };
    return { ok: true, link: linkUrl(token, origin), token };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/**
 * "Revocar acceso" (owner-only): the current link stops working; the party,
 * its guests and their RSVPs stay. One call to `revoke_guest_invitation_link`
 * (LB-15: the only way to revoke), which re-checks the owner role, stamps
 * the database clock and records the revocation in the wedding's activity
 * history in the same transaction. Revoking an already-revoked link is a
 * no-op success (and records nothing new).
 */
export async function revokeGuestPartyLink(
  supabase: Client,
  weddingId: string,
  guestInvitationId: string,
): Promise<RevokeLinkResult> {
  const access = await requireWeddingRole(supabase, weddingId, ["owner"]);
  if (!access.ok) return { ok: false, reason: access.reason };
  if (!UUID_PATTERN.test(guestInvitationId)) return { ok: false, reason: "invalid_target" };

  try {
    const { data, error } = await supabase.rpc("revoke_guest_invitation_link", {
      target_wedding_id: access.access.weddingId,
      target_invitation_id: guestInvitationId,
    });
    if (error) return { ok: false, reason: linkAdminWriteError(error) };
    // false: not a party of this wedding (or the caller's membership vanished).
    return data === true ? { ok: true } : { ok: false, reason: "invalid_target" };
  } catch {
    return { ok: false, reason: "error" };
  }
}

// ----------------------------------------------------------------- guests

export type GuestWriteResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      reason: AccessDenial | "invalid_target" | "invalid" | "last_guest";
    }>;

/** Adds one guest to a party of the authorized wedding (no fixed maximum). */
export async function addGuest(
  supabase: Client,
  weddingId: string,
  guestInvitationId: string,
  name: string,
): Promise<GuestWriteResult> {
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) return { ok: false, reason: accessDenial(access.reason) };
  if (!UUID_PATTERN.test(guestInvitationId)) return { ok: false, reason: "invalid_target" };

  try {
    const { error } = await supabase.from("guests").insert({
      wedding_id: access.access.weddingId,
      guest_invitation_id: guestInvitationId,
      name,
    });
    if (error) {
      if (error.code === "23514") return { ok: false, reason: "invalid" };
      // foreign_key_violation: not a party of THIS wedding (or gone).
      if (error.code === "23503") return { ok: false, reason: "invalid_target" };
      if (error.code === "42501") return { ok: false, reason: "not_found" };
      return { ok: false, reason: "error" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/** Renames a guest of the authorized wedding. */
export async function updateGuestName(
  supabase: Client,
  weddingId: string,
  guestId: string,
  name: string,
): Promise<GuestWriteResult> {
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) return { ok: false, reason: accessDenial(access.reason) };
  if (!UUID_PATTERN.test(guestId)) return { ok: false, reason: "invalid_target" };

  try {
    const { data, error } = await supabase
      .from("guests")
      .update({ name })
      .eq("id", guestId)
      .eq("wedding_id", access.access.weddingId)
      .select("id");
    if (error) return { ok: false, reason: error.code === "23514" ? "invalid" : "error" };
    if (!data || data.length === 0) return { ok: false, reason: "invalid_target" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/**
 * Removes one guest; their RSVP cascades, the rest of the party stays. The
 * last guest of a party can't be removed (a party is never empty): delete
 * the party instead.
 */
export async function removeGuest(
  supabase: Client,
  weddingId: string,
  guestId: string,
): Promise<GuestWriteResult> {
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) return { ok: false, reason: accessDenial(access.reason) };
  if (!UUID_PATTERN.test(guestId)) return { ok: false, reason: "invalid_target" };

  try {
    const { data, error } = await supabase
      .from("guests")
      .delete()
      .eq("id", guestId)
      .eq("wedding_id", access.access.weddingId)
      .select("id");
    if (error) {
      if (isLastGuestError(error)) return { ok: false, reason: "last_guest" };
      return { ok: false, reason: "error" };
    }
    if (!data || data.length === 0) return { ok: false, reason: "invalid_target" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}
