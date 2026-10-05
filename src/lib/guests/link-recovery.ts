import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { requireWeddingMembership } from "@/lib/authz/wedding";
import { guestRsvpUrl } from "@/lib/guests/link";
import type { GuestLinkConfig } from "@/lib/guests/link-config";
import { decryptRsvpCapability } from "@/lib/security/rsvp-capability-encryption";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Recovering a party's CURRENT guest link (LB-13, ADR-006), so organizers
 * can share the same link again (copy today; reminders and other channels
 * later). Delivery-neutral: it returns an RSVP URL, nothing email-specific.
 *
 * Any member (owner or collaborator) may recover; only owners rotate (that
 * stays in `@/lib/guests/service`). Only on an explicit organizer request,
 * one party at a time: page loads never decrypt anything.
 *
 * Order: authorize (the user's own session) → validate the id → config →
 * one member-scoped database read (`get_guest_invitation_recovery_envelope`,
 * which itself re-checks membership and refuses revoked/expired links) →
 * decrypt on the server and re-check the token against the CURRENT hash →
 * build the URL from the trusted `APP_ORIGIN`. The envelope never leaves
 * the server; the browser only ever receives the final URL.
 *
 * Failure never touches the link: nothing is rotated, revoked, deleted or
 * rewritten, and the guest's link keeps working (the hash validates it, not
 * the envelope). Every cryptographic failure is the same `unrecoverable`;
 * no detail reaches the caller. Nothing is logged.
 */

type Client = SupabaseClient<Database>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RecoverLinkFailure =
  | "unauthenticated"
  | "not_found"
  | "invalid_target"
  /** Revoked or expired: never handed out for sharing. */
  | "unavailable"
  /** Created before LB-13 (hash only): works for guests, can't be shown again. */
  | "legacy"
  /** The envelope couldn't be decrypted or doesn't match the current link. */
  | "unrecoverable"
  | "configuration_error"
  | "error";

export type RecoverLinkResult =
  | Readonly<{ ok: true; link: string }>
  | Readonly<{ ok: false; reason: RecoverLinkFailure }>;

export async function recoverGuestPartyLink(
  supabase: Client,
  weddingId: string,
  guestInvitationId: string,
  /** `getGuestLinkConfig()`: trusted origin + key; null = not configured. */
  config: GuestLinkConfig | null,
): Promise<RecoverLinkResult> {
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) {
    // Membership is the whole permission model here.
    return { ok: false, reason: access.reason === "forbidden" ? "error" : access.reason };
  }
  if (!UUID_PATTERN.test(guestInvitationId)) return { ok: false, reason: "invalid_target" };
  if (!config) return { ok: false, reason: "configuration_error" };

  let row: Readonly<{ link_state: string; token_hash: string | null; token_ciphertext: string | null }>;
  try {
    const { data, error } = await supabase.rpc("get_guest_invitation_recovery_envelope", {
      target_wedding_id: access.access.weddingId,
      target_invitation_id: guestInvitationId,
    });
    if (error || !data) return { ok: false, reason: "error" };
    if (data.length === 0) return { ok: false, reason: "invalid_target" };
    row = data[0];
  } catch {
    return { ok: false, reason: "error" };
  }

  if (row.link_state === "unavailable") return { ok: false, reason: "unavailable" };
  if (row.link_state === "legacy") return { ok: false, reason: "legacy" };
  if (row.link_state !== "recoverable" || !row.token_hash || !row.token_ciphertext) {
    return { ok: false, reason: "error" };
  }

  const token = decryptRsvpCapability({
    envelope: row.token_ciphertext,
    expectedTokenHash: row.token_hash,
    key: config.encryption.key,
  });
  if (!token) return { ok: false, reason: "unrecoverable" };
  return { ok: true, link: guestRsvpUrl(token, config.appOrigin) };
}
