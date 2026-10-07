import { isStorableMessageId } from "@/lib/email/provider";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Normalizes a signature-verified Resend webhook body into the few safe
 * fields delivery ingestion needs (LB-18.2, ADR-011 §7). Pure: no I/O.
 *
 * Read, and nothing else: `type`, the top-level `created_at` (when the
 * event happened), `data.email_id` (the id `emails.send` returned — the only
 * correlation key) and, for bounces, `data.bounce.type`. Recipients,
 * subject, sender, tags, `data.message_id` (the SMTP Message-ID, never used
 * for correlation), failure/bounce text and click data are never read.
 *
 * Only the six subscribed delivery events are accepted. Everything else
 * (`email.sent`, `email.opened`, `email.clicked`, contact/domain/
 * suppression events, unknown types) is `ignored`, as is a malformed body:
 * it is signed by the provider, so retrying it can't make it valid, and
 * refusing it would only make the provider retry and eventually disable the
 * endpoint. Nothing malformed ever reaches the database.
 */

export type DeliveryEventType = Database["public"]["Enums"]["email_delivery_event_type"];
export type BounceType = Database["public"]["Enums"]["email_bounce_type"];

export type NormalizedDeliveryEvent = Readonly<{
  /** `data.email_id`: matched against `email_deliveries.provider_message_id`. */
  providerMessageId: string;
  eventType: DeliveryEventType;
  /** Top-level `created_at`, as an ISO 8601 UTC string. */
  occurredAt: string;
  /** Bounces only (`undetermined` when the provider's value is missing or unknown); null otherwise. */
  bounceType: BounceType | null;
}>;

export type DeliveryEventParse =
  | Readonly<{ status: "event"; event: NormalizedDeliveryEvent }>
  | Readonly<{ status: "ignored"; reason: "unsupported" | "malformed" }>;

const SUPPORTED: Readonly<Record<string, DeliveryEventType>> = {
  "email.delivered": "delivered",
  "email.delivery_delayed": "delivery_delayed",
  "email.failed": "failed",
  "email.suppressed": "suppressed",
  "email.bounced": "bounced",
  "email.complained": "complained",
};

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resend documents `Permanent`, `Transient` and `Undetermined` (its bounce
 * guide) and `Permanent`/`Temporary` (its webhook reference). Case-insensitive;
 * anything else, or nothing, is `undetermined`.
 */
export function normalizeBounceType(value: unknown): BounceType {
  if (typeof value !== "string") return "undetermined";
  switch (value.trim().toLowerCase()) {
    case "permanent":
      return "permanent";
    case "transient":
    case "temporary":
      return "transient";
    default:
      return "undetermined";
  }
}

function parseOccurredAt(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Normalizes the raw (already verified) body. Never throws. */
export function parseResendDeliveryEvent(rawBody: string): DeliveryEventParse {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: "ignored", reason: "malformed" };
  }
  if (!isRecord(payload) || typeof payload.type !== "string") {
    return { status: "ignored", reason: "malformed" };
  }

  const eventType = Object.hasOwn(SUPPORTED, payload.type) ? SUPPORTED[payload.type] : undefined;
  if (!eventType) return { status: "ignored", reason: "unsupported" };

  const data = payload.data;
  const occurredAt = parseOccurredAt(payload.created_at);
  if (!isRecord(data) || !isStorableMessageId(data.email_id) || !occurredAt) {
    return { status: "ignored", reason: "malformed" };
  }

  const bounceType =
    eventType === "bounced" ? normalizeBounceType(isRecord(data.bounce) ? data.bounce.type : undefined) : null;

  return {
    status: "event",
    event: { providerMessageId: data.email_id, eventType, occurredAt, bounceType },
  };
}
