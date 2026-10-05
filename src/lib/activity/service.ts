import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { WeddingAccess } from "@/lib/authz/wedding";
import type { Database } from "@/lib/supabase/database.types";

import type { ActivityActorKind, ActivityEventType } from "./presentation";

/**
 * Reading a wedding's activity history (LB-15, ADR-008). Read-only: there is
 * no way to write history from the application. Rows are appended by the
 * database functions that perform each fact (party created, link replaced
 * or revoked, contact email changed, RSVP saved, email recorded), in the
 * same transaction.
 *
 * One bounded call to `get_wedding_activity` (SECURITY INVOKER, so RLS
 * restricts it to members): the newest `ACTIVITY_LIMIT` events, newest
 * first. Each entry carries the party's CURRENT label (null once deleted)
 * and, for a member still in the wedding, their membership id, labelled
 * like everywhere else (`@/lib/weddings/members`). Never a token, hash,
 * answer, note, email address, provider id or user id.
 */

type Client = SupabaseClient<Database>;

/** The database pins the same maximum; asking for more returns this many. */
export const ACTIVITY_LIMIT = 50;

export type ActivityEntry = Readonly<{
  id: string;
  eventType: ActivityEventType;
  /** ISO timestamp (database clock). */
  occurredAt: string;
  /** null once the party was deleted (its history stays). */
  guestInvitationId: string | null;
  /** The party's CURRENT label; null once deleted. */
  partyLabel: string | null;
  actorKind: ActivityActorKind;
  /** The acting member's membership, while they are still in the wedding. */
  actorMembershipId: string | null;
}>;

/**
 * The wedding's latest activity. Takes the `WeddingAccess` of a successful
 * membership check, so it can't run before one. Returns null on failure.
 */
export async function listWeddingActivity(
  supabase: Client,
  access: WeddingAccess,
): Promise<ActivityEntry[] | null> {
  try {
    const { data, error } = await supabase.rpc("get_wedding_activity", {
      target_wedding_id: access.weddingId,
      max_events: ACTIVITY_LIMIT,
    });
    if (error || !data) return null;
    return data.map((row) => {
      // The generated return type marks every column non-null; these can be null.
      const guestInvitationId: string | null = row.guest_invitation_id;
      const partyLabel: string | null = row.party_label;
      const actorMembershipId: string | null = row.actor_membership_id;
      return {
        id: row.id,
        eventType: row.event_type,
        occurredAt: row.occurred_at,
        guestInvitationId,
        partyLabel,
        actorKind: row.actor_kind,
        actorMembershipId,
      };
    });
  } catch {
    return null;
  }
}
