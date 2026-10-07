import "server-only";

import { createClient } from "@supabase/supabase-js";

import { parseRecorderSettings } from "@/lib/email/delivery-recorder";
import type { NormalizedDeliveryEvent } from "@/lib/email/delivery-events";
import { isStorableMessageId } from "@/lib/email/provider";
import { WEBHOOK_ID_PATTERN } from "@/lib/email/webhook-auth";
import { getPublicEnv } from "@/lib/env/public";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The provider delivery events' database boundary (LB-18.2, ADR-011 §7):
 * the application's THIRD service-role use, beside `@/lib/email/delivery-recorder`
 * and `@/lib/scheduler/rsvp-reminder-store` (ADR-002 §6).
 *
 * A separate trust boundary from both:
 *   - the delivery recorder writes provider results the APPLICATION obtained
 *     after a member's or guest's own credential authorized the send;
 *   - the scheduler store acts on the deployment scheduler's authority;
 *   - this store acts on the PROVIDER's authority, established only by the
 *     webhook signature (`@/lib/email/webhook-auth`) before it is called.
 * No session exists to authorize a webhook, and clients must never be able
 * to fabricate a delivery event, so the one function it calls,
 * `ingest_email_delivery_event`, is SECURITY DEFINER and executable ONLY by
 * service_role.
 *
 * Exactly one operation, `ingest`, one fixed RPC. It takes the provider's
 * event id and the normalized event only: never a raw payload, a Wedding,
 * party or delivery id, or a recipient — the database correlates by the
 * provider email id itself. The privileged client is created inside and
 * never returned or exported: no `from()`, no generic `rpc(name)`, no
 * authorization. The key is read only here (ESLint allows it in this file,
 * the delivery recorder and the scheduler store), never logged, returned or
 * echoed; missing or wrong configuration fails closed (`null`).
 */

export type DeliveryEventIngest = Readonly<{
  /** The verified `svix-id`: the deduplication key. */
  providerEventId: string;
  event: NormalizedDeliveryEvent;
}>;

/** The database's closed outcome, or `error` (unreachable, refused, unexpected answer). */
export type DeliveryEventIngestResult = Database["public"]["Enums"]["email_delivery_ingest_outcome"] | "error";

export interface DeliveryEventStore {
  ingest(input: DeliveryEventIngest): Promise<DeliveryEventIngestResult>;
}

type StoreSettings = Readonly<{ supabaseUrl: string; serviceRoleKey: string }>;

const OUTCOMES: ReadonlySet<string> = new Set(["applied", "no_change", "duplicate", "unknown_message"]);

function isOutcome(value: unknown): value is Exclude<DeliveryEventIngestResult, "error"> {
  return typeof value === "string" && OUTCOMES.has(value);
}

/** Builds the store from explicit settings (the factory below, and DB tests). */
export function createDeliveryEventStore({ supabaseUrl, serviceRoleKey }: StoreSettings): DeliveryEventStore {
  const privileged = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  return {
    async ingest({ providerEventId, event }) {
      if (
        !WEBHOOK_ID_PATTERN.test(providerEventId) ||
        !isStorableMessageId(event.providerMessageId) ||
        (event.eventType === "bounced") !== (event.bounceType !== null)
      ) {
        return "error";
      }
      const args: Database["public"]["Functions"]["ingest_email_delivery_event"]["Args"] = {
        provider_event_id: providerEventId,
        provider_message_id: event.providerMessageId,
        event_type: event.eventType,
        occurred_at: event.occurredAt,
        ...(event.bounceType ? { bounce_type: event.bounceType } : {}),
      };
      try {
        const { data, error } = await privileged.rpc("ingest_email_delivery_event", args);
        if (error || !isOutcome(data)) return "error";
        return data;
      } catch {
        return "error";
      }
    },
  };
}

/** The store from the server environment, or null when not configured. */
export function getDeliveryEventStore(): DeliveryEventStore | null {
  let supabaseUrl: string;
  try {
    supabaseUrl = getPublicEnv().supabaseUrl;
  } catch {
    return null;
  }
  const settings = parseRecorderSettings({
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    // ADR-011 §7, ADR-002 §6: the third sanctioned read of this key (eslint allows it here,
    // in delivery-recorder.ts and in rsvp-reminder-store.ts only).
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  return settings ? createDeliveryEventStore(settings) : null;
}
