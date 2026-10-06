import "server-only";

import { createClient } from "@supabase/supabase-js";

import { getPublicEnv } from "@/lib/env/public";
import { isStorableMessageId } from "@/lib/email/provider";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The application's ONLY service-role use (ADR-002 §6), for email delivery
 * metadata and nothing else. Four named operations, each one fixed RPC:
 *
 * - `recordInvitation` (ADR-004): the provider accepted an invitation email.
 * - `readRsvpConfirmationContext` (ADR-005): after a party's RSVP was saved
 *   through its link, the private bits its confirmation needs (the party's
 *   ids, its contact email, the wedding's name/date/city), by that link's
 *   hash. The guest has no account and guest functions must never reveal
 *   the contact email, so only a credential the browser never holds can
 *   read it.
 * - `recordRsvpConfirmation` (ADR-005): the provider accepted an RSVP
 *   confirmation email.
 * - `recordRsvpReminder` (ADR-007): the provider accepted an RSVP reminder
 *   email that an organizer explicitly sent with the party's CURRENT link.
 *
 * Since LB-15 (ADR-008) each record also appends the party's activity
 * history row, inside the same database function and transaction: no
 * history without the metadata, and none for a send that couldn't be
 * recorded. Member-initiated emails (invitation, reminder) carry the
 * acting member's user id, taken by the caller from its own membership
 * check (`WeddingAccess.userId`, i.e. `auth.getUser()`), never from the
 * browser; the database re-checks that it is a member of the wedding.
 * Since LB-18.1 (ADR-011) each record also inserts the send's
 * `email_deliveries` ledger row in that same transaction (no new
 * operation; nothing is written for a send that couldn't be recorded).
 *
 * Why recording is privileged: the database can't authenticate a provider
 * result coming from a client credential. A Server Action talks to Postgres
 * with the user's own JWT (or, for a guest, anon) and the public
 * publishable key — the very request the browser can make itself — so a
 * client-executable "record" RPC would let anyone fabricate a send. The
 * metadata is therefore written only by service_role-only functions,
 * through this module, reached only after:
 *   1. the caller was authorized with their OWN credential (a member's
 *      session, or the guest's link as anon) — never here,
 *   2. the provider accepted the message (its id comes from the provider
 *      response, never from the browser).
 *
 * Scope, deliberately tiny: four functions, four RPCs, one party per call.
 * The privileged client is created inside and never returned or exported;
 * there is no generic service-role client to reuse, no `from()`, no
 * arbitrary RPC name. No authorization. The key is read only here, never
 * logged, returned or echoed; missing or wrong configuration fails closed.
 */

export type DeliveryRecord = Readonly<{
  weddingId: string;
  guestInvitationId: string;
  /** SHA-256 of the party's link (must still be its current one). */
  tokenHash: string;
  /** The party's contact email the provider accepted (must still be current). */
  recipient: string;
  /** From the provider's success response only. */
  providerMessageId: string;
}>;

/**
 * An email a MEMBER explicitly sent (invitation, reminder): the activity
 * history attributes it to them (LB-15, ADR-008).
 */
export type MemberDeliveryRecord = DeliveryRecord &
  Readonly<{
    /** From the server's own membership check (`WeddingAccess.userId`), never from input. */
    actingUserId: string;
  }>;

/** An invitation email a member sent. */
export type InvitationRecord = MemberDeliveryRecord;

/** Same scope as an invitation record: the link whose RSVP was confirmed. No member sent it. */
export type RsvpConfirmationRecord = DeliveryRecord;

/** Same scope: the CURRENT, usable link the reminder carried, sent by a member. */
export type RsvpReminderRecord = MemberDeliveryRecord;

export type DeliveryRecordResult = Readonly<{ ok: true; sentAt: string }> | Readonly<{ ok: false }>;

/** What an RSVP confirmation needs that the guest capability doesn't return. */
export type RsvpConfirmationContext = Readonly<{
  weddingId: string;
  guestInvitationId: string;
  /** The party's CURRENT contact email; null = none, nothing to send. */
  recipient: string | null;
  weddingName: string;
  /** Postgres date (`YYYY-MM-DD`) or null. */
  weddingDate: string | null;
  weddingCity: string | null;
}>;

/** `ok: false` = unreadable, or the link is no longer usable. */
export type RsvpConfirmationContextResult =
  | Readonly<{ ok: true; context: RsvpConfirmationContext }>
  | Readonly<{ ok: false }>;

export interface DeliveryRecorder {
  recordInvitation(entry: InvitationRecord): Promise<DeliveryRecordResult>;
  readRsvpConfirmationContext(tokenHash: string): Promise<RsvpConfirmationContextResult>;
  recordRsvpConfirmation(entry: RsvpConfirmationRecord): Promise<DeliveryRecordResult>;
  recordRsvpReminder(entry: RsvpReminderRecord): Promise<DeliveryRecordResult>;
}

type RecorderSettings = Readonly<{ supabaseUrl: string; serviceRoleKey: string }>;

type EnvSource = Readonly<Record<string, string | undefined>>;

/** Decodes a JWT payload's `role` claim without verifying it (shape check only). */
function jwtRole(key: string): string | undefined {
  const parts = key.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (payload && typeof payload === "object" && "role" in payload) {
      const { role } = payload as { role: unknown };
      return typeof role === "string" ? role : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Pure: the recorder's settings, or null. Accepts only a secret key
 * (`sb_secret_…`) or a legacy `service_role` JWT — never a publishable/anon
 * key, which would silently make every record fail as a permission error.
 */
export function parseRecorderSettings(source: EnvSource): RecorderSettings | null {
  const supabaseUrl = source.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const serviceRoleKey = source.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!supabaseUrl || !serviceRoleKey || /\s/.test(serviceRoleKey)) return null;
  try {
    new URL(supabaseUrl);
  } catch {
    return null;
  }
  const isSecret = serviceRoleKey.startsWith("sb_secret_") || jwtRole(serviceRoleKey) === "service_role";
  return isSecret ? { supabaseUrl, serviceRoleKey } : null;
}

const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RecordArgs = Readonly<{
  target_wedding_id: string;
  target_invitation_id: string;
  invitation_token_hash: string;
  recipient: string;
  provider_message_id: string;
}>;

function recordArgs(entry: DeliveryRecord): RecordArgs {
  return {
    target_wedding_id: entry.weddingId,
    target_invitation_id: entry.guestInvitationId,
    invitation_token_hash: entry.tokenHash,
    recipient: entry.recipient,
    provider_message_id: entry.providerMessageId,
  };
}

function memberRecordArgs(entry: MemberDeliveryRecord): RecordArgs & Readonly<{ acting_user_id: string }> {
  return { ...recordArgs(entry), acting_user_id: entry.actingUserId };
}

/** Builds the recorder from explicit settings (the factory below, and DB tests). */
export function createDeliveryRecorder({ supabaseUrl, serviceRoleKey }: RecorderSettings): DeliveryRecorder {
  const privileged = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  /** Runs one fixed record RPC (chosen below, never by the caller); maps every failure to `ok: false`. */
  async function record(
    entry: DeliveryRecord,
    call: () => PromiseLike<{ data: string | null; error: unknown }>,
  ): Promise<DeliveryRecordResult> {
    if (!isStorableMessageId(entry.providerMessageId)) return { ok: false };
    try {
      const { data, error } = await call();
      if (error || typeof data !== "string") return { ok: false };
      return { ok: true, sentAt: data };
    } catch {
      return { ok: false };
    }
  }

  return {
    recordInvitation: (entry) =>
      UUID_PATTERN.test(entry.actingUserId)
        ? record(entry, () => privileged.rpc("record_guest_invitation_email", memberRecordArgs(entry)))
        : Promise.resolve({ ok: false }),
    recordRsvpConfirmation: (entry) =>
      record(entry, () => privileged.rpc("record_rsvp_confirmation_email", recordArgs(entry))),
    recordRsvpReminder: (entry) =>
      UUID_PATTERN.test(entry.actingUserId)
        ? record(entry, () => privileged.rpc("record_rsvp_reminder_email", memberRecordArgs(entry)))
        : Promise.resolve({ ok: false }),
    async readRsvpConfirmationContext(tokenHash) {
      if (!TOKEN_HASH_PATTERN.test(tokenHash)) return { ok: false };
      try {
        const { data, error } = await privileged.rpc("get_rsvp_confirmation_email_context", {
          invitation_token_hash: tokenHash,
        });
        const row = data?.[0];
        if (error || !row || data.length !== 1) return { ok: false };
        // The generated return type marks every column non-null; the contact
        // email, date and city can be null.
        const contactEmail: string | null = row.contact_email;
        const weddingDate: string | null = row.wedding_date;
        const weddingCity: string | null = row.wedding_city;
        return {
          ok: true,
          context: {
            weddingId: row.wedding_id,
            guestInvitationId: row.guest_invitation_id,
            recipient: contactEmail,
            weddingName: row.wedding_name,
            weddingDate,
            weddingCity,
          },
        };
      } catch {
        return { ok: false };
      }
    },
  };
}

/** The recorder from the server environment, or null when not configured. */
export function getDeliveryRecorder(): DeliveryRecorder | null {
  let supabaseUrl: string;
  try {
    supabaseUrl = getPublicEnv().supabaseUrl;
  } catch {
    return null;
  }
  const settings = parseRecorderSettings({
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    // ADR-004/ADR-005/ADR-007: the one sanctioned read of this key (eslint allows it in this file only).
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  return settings ? createDeliveryRecorder(settings) : null;
}
