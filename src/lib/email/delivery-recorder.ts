import "server-only";

import { createClient } from "@supabase/supabase-js";

import { getPublicEnv } from "@/lib/env/public";
import { isStorableMessageId } from "@/lib/email/provider";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The application's ONLY service-role use (ADR-004, ADR-002 §6): recording
 * that the email provider accepted an invitation email.
 *
 * Why it exists: the database can't authenticate a provider result coming
 * from a normal user session. A Server Action talks to Postgres with the
 * user's own JWT and the public publishable key — the very request the
 * user's browser can make itself — so a member-executable "record" RPC
 * would let any member fabricate a send. The send metadata is therefore
 * written only by `record_guest_invitation_email`, executable by
 * service_role alone, through this module, which is reached only after:
 *   1. the user was authorized with their OWN session (never here),
 *   2. the party, recipient and link were checked with that session,
 *   3. the provider accepted the message (its id comes from the provider
 *      response, never from the browser).
 *
 * Scope, deliberately tiny: one function, one RPC, one party per call.
 * The privileged client is created inside and never returned or exported;
 * there is no generic service-role client to reuse. No reads, no
 * authorization, no other writes. The key is read only here, never logged,
 * returned or echoed; missing or wrong configuration fails closed.
 */

export type DeliveryRecord = Readonly<{
  weddingId: string;
  guestInvitationId: string;
  /** SHA-256 of the link that was emailed (must still be the party's current one). */
  tokenHash: string;
  /** The party's contact email the provider accepted (must still be current). */
  recipient: string;
  /** From the provider's success response only. */
  providerMessageId: string;
}>;

export type DeliveryRecordResult = Readonly<{ ok: true; sentAt: string }> | Readonly<{ ok: false }>;

export interface DeliveryRecorder {
  record(entry: DeliveryRecord): Promise<DeliveryRecordResult>;
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

/** Builds the recorder from explicit settings (the factory below, and DB tests). */
export function createDeliveryRecorder({ supabaseUrl, serviceRoleKey }: RecorderSettings): DeliveryRecorder {
  const privileged = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    async record(entry) {
      if (!isStorableMessageId(entry.providerMessageId)) return { ok: false };
      try {
        const { data, error } = await privileged.rpc("record_guest_invitation_email", {
          target_wedding_id: entry.weddingId,
          target_invitation_id: entry.guestInvitationId,
          invitation_token_hash: entry.tokenHash,
          recipient: entry.recipient,
          provider_message_id: entry.providerMessageId,
        });
        if (error || typeof data !== "string") return { ok: false };
        return { ok: true, sentAt: data };
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
    // ADR-004: the one sanctioned read of this key (eslint allows it in this file only).
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  return settings ? createDeliveryRecorder(settings) : null;
}
