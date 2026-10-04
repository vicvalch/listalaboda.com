import "server-only";

import { createClient } from "@supabase/supabase-js";

import { getPublicEnv } from "@/lib/env/public";
import { isStorableMessageId } from "@/lib/email/provider";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The application's ONLY service-role use (ADR-002 §6), for email delivery
 * metadata and nothing else. Three named operations, each one fixed RPC:
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
 * Scope, deliberately tiny: three functions, three RPCs, one party per call.
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

/** Same scope as an invitation record: the link whose RSVP was confirmed. */
export type RsvpConfirmationRecord = DeliveryRecord;

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
  recordInvitation(entry: DeliveryRecord): Promise<DeliveryRecordResult>;
  readRsvpConfirmationContext(tokenHash: string): Promise<RsvpConfirmationContextResult>;
  recordRsvpConfirmation(entry: RsvpConfirmationRecord): Promise<DeliveryRecordResult>;
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

/** Builds the recorder from explicit settings (the factory below, and DB tests). */
export function createDeliveryRecorder({ supabaseUrl, serviceRoleKey }: RecorderSettings): DeliveryRecorder {
  const privileged = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  /** One of the two fixed record RPCs; never a caller-chosen name. */
  async function record(
    rpc: "record_guest_invitation_email" | "record_rsvp_confirmation_email",
    entry: DeliveryRecord,
  ): Promise<DeliveryRecordResult> {
    if (!isStorableMessageId(entry.providerMessageId)) return { ok: false };
    try {
      const { data, error } = await privileged.rpc(rpc, recordArgs(entry));
      if (error || typeof data !== "string") return { ok: false };
      return { ok: true, sentAt: data };
    } catch {
      return { ok: false };
    }
  }

  return {
    recordInvitation: (entry) => record("record_guest_invitation_email", entry),
    recordRsvpConfirmation: (entry) => record("record_rsvp_confirmation_email", entry),
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
    // ADR-004/ADR-005: the one sanctioned read of this key (eslint allows it in this file only).
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  return settings ? createDeliveryRecorder(settings) : null;
}
