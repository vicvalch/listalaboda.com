import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { RsvpResponse } from "@/lib/rsvp/validation";
import {
  hashCapabilityToken,
  isWellFormedCapabilityToken,
} from "@/lib/security/capability-token";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The guest side of GuestInvitation: a token holder reads and answers for
 * ONE party, with no account and no wedding membership (ADR-002 §5).
 *
 * The token is the only authority. It is shape-checked and hashed here; the
 * database functions receive only the hash and decide everything else
 * (which party, whether the link is still usable, which guests may be
 * answered). Guest ids from the browser are references, never authority.
 * Whatever session the client carries is irrelevant to these functions.
 *
 * Every unusable link — malformed, unknown, revoked, expired, rotated away,
 * party deleted — is the same `unavailable`, so nothing can be probed. The
 * token is never logged or echoed.
 */

type Client = SupabaseClient<Database>;

export type GuestPartyGuest = Readonly<{
  id: string;
  name: string;
  /** null = "Sin responder". */
  attending: boolean | null;
  dietaryNote: string | null;
}>;

export type GuestParty = Readonly<{
  label: string;
  guests: readonly GuestPartyGuest[];
}>;

type PartyRow = Readonly<{
  party_label: string;
  guest_id: string;
  guest_name: string;
  attending: boolean | null;
  dietary_note: string | null;
}>;

function toParty(rows: readonly PartyRow[]): GuestParty | null {
  const first = rows[0];
  if (!first) return null;
  return {
    label: first.party_label,
    guests: rows.map((row) => ({
      id: row.guest_id,
      name: row.guest_name,
      attending: row.attending,
      dietaryNote: row.dietary_note,
    })),
  };
}

export type GuestPartyResult =
  | Readonly<{ ok: true; party: GuestParty }>
  | Readonly<{ ok: false; reason: "unavailable" | "error" }>;

export async function getGuestPartyByToken(
  supabase: Client,
  token: string,
): Promise<GuestPartyResult> {
  if (!isWellFormedCapabilityToken(token)) return { ok: false, reason: "unavailable" };
  try {
    const { data, error } = await supabase.rpc("get_guest_invitation", {
      invitation_token_hash: hashCapabilityToken(token),
    });
    if (error || !data) return { ok: false, reason: "error" };
    const party = toParty(data);
    // A party always has at least one guest, so no rows = unusable link.
    if (!party) return { ok: false, reason: "unavailable" };
    return { ok: true, party };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/**
 * The public address of the party's wedding website, or null. Two separate
 * authorities meet here: the token must still be usable (it says WHICH
 * wedding), and the wedding must be published (that alone makes its fields
 * public). Holding a link never reveals an unpublished wedding; the page
 * then reads the public fields through the public site boundary, exactly
 * like any visitor. Errors and unusable links are simply null.
 */
export async function getGuestPartySiteSlug(supabase: Client, token: string): Promise<string | null> {
  if (!isWellFormedCapabilityToken(token)) return null;
  try {
    const { data, error } = await supabase.rpc("get_guest_invitation_site_slug", {
      invitation_token_hash: hashCapabilityToken(token),
    });
    if (error || typeof data !== "string") return null;
    return data;
  } catch {
    return null;
  }
}

export type SubmitRsvpResult =
  | Readonly<{ ok: true; party: GuestParty }>
  /**
   * `unavailable`: the link can't be used (any reason, indistinguishable).
   * `stale`: the answers don't match the party's current guests (the party
   * changed while the form was open, or ids were tampered with). `invalid`:
   * malformed answers. Nothing is saved in any of these cases.
   */
  | Readonly<{ ok: false; reason: "unavailable" | "stale" | "invalid" | "error" }>;

export async function submitGuestRsvp(
  supabase: Client,
  token: string,
  responses: readonly RsvpResponse[],
): Promise<SubmitRsvpResult> {
  if (!isWellFormedCapabilityToken(token)) return { ok: false, reason: "unavailable" };
  try {
    const { data, error } = await supabase.rpc("submit_guest_rsvp", {
      invitation_token_hash: hashCapabilityToken(token),
      responses: responses.map((response) => ({
        guest_id: response.guestId,
        attending: response.attending,
        dietary_note: response.dietaryNote,
      })),
    });
    if (error) {
      if (error.message === "guest_invitation_unavailable") return { ok: false, reason: "unavailable" };
      if (error.message === "guest_rsvp_mismatch") return { ok: false, reason: "stale" };
      // guest_rsvp_invalid, or the note CHECK (check_violation).
      if (error.message === "guest_rsvp_invalid" || error.code === "23514") {
        return { ok: false, reason: "invalid" };
      }
      return { ok: false, reason: "error" };
    }
    const party = data ? toParty(data) : null;
    if (!party) return { ok: false, reason: "error" };
    return { ok: true, party };
  } catch {
    return { ok: false, reason: "error" };
  }
}
