import "server-only";

import Stripe from "stripe";

/**
 * The Stripe webhook route's authentication (BILLING-01, ADR-021 §6). The
 * ONLY module that reads `process.env.STRIPE_WEBHOOK_SECRET`
 * (ESLint-enforced).
 *
 * Verification is Stripe's own (`Stripe.webhooks.constructEvent`): HMAC-SHA256
 * of `<t>.<raw body>` with the endpoint's signing secret, compared against
 * every `v1` signature of the `Stripe-Signature` header, with Stripe's
 * default ± 5 minute timestamp tolerance. It runs over the RAW body exactly
 * as received, before anything is parsed; only then are the few envelope
 * fields read. No Stripe API call, no Supabase client, no business rules.
 * The secret, signatures and payloads are never logged, returned or echoed.
 */

/** The largest webhook body the route reads (Stripe snapshot events are a few KiB). */
export const STRIPE_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

const SECRET_PATTERN = /^whsec_[A-Za-z0-9+/=_-]{16,250}$/;
const EVENT_ID_PATTERN = /^evt_[A-Za-z0-9_]{1,250}$/;
const OBJECT_ID_PATTERN = /^[a-z]{2,8}_[A-Za-z0-9_]{1,250}$/;
const SIGNATURE_MAX_LENGTH = 4096;

declare const secretBrand: unique symbol;

/** A parsed, usable secret. Opaque: the key material never leaves this module. */
export type StripeWebhookSecret = Readonly<{ [secretBrand]: true }>;

const secrets = new WeakMap<StripeWebhookSecret, string>();

/** The few envelope fields the application reads from a VERIFIED event. */
export type VerifiedStripeEvent = Readonly<{
  id: string;
  type: string;
  livemode: boolean;
  /** Unix seconds. */
  created: number;
  /** `data.object.id`: the object the event is about. */
  objectId: string;
}>;

export type StripeWebhookVerification =
  | Readonly<{ status: "verified"; event: VerifiedStripeEvent }>
  | Readonly<{ status: "not_configured" | "missing_signature" | "invalid_signature" | "malformed" }>;

/** Pure: the configured secret, or null when missing or malformed. */
export function parseStripeWebhookSecret(raw: string | undefined): StripeWebhookSecret | null {
  const value = raw?.trim() ?? "";
  if (!SECRET_PATTERN.test(value)) return null;
  const secret = Object.freeze({}) as StripeWebhookSecret;
  secrets.set(secret, value);
  return secret;
}

export function getStripeWebhookSecret(): StripeWebhookSecret | null {
  return parseStripeWebhookSecret(process.env.STRIPE_WEBHOOK_SECRET);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Verifies one delivery. `rawBody` must be the request body exactly as received. */
export function verifyStripeWebhook(
  rawBody: string,
  signature: string | null,
  secret: StripeWebhookSecret | null,
): StripeWebhookVerification {
  const key = secret ? secrets.get(secret) : undefined;
  if (!key) return { status: "not_configured" };
  if (!signature || signature.length > SIGNATURE_MAX_LENGTH) return { status: "missing_signature" };

  let event: unknown;
  try {
    event = Stripe.webhooks.constructEvent(rawBody, signature, key);
  } catch {
    return { status: "invalid_signature" };
  }

  if (!isRecord(event) || !isRecord(event.data) || !isRecord(event.data.object)) return { status: "malformed" };
  const { id, type, livemode, created } = event;
  const objectId = event.data.object.id;
  if (
    typeof id !== "string" ||
    !EVENT_ID_PATTERN.test(id) ||
    typeof type !== "string" ||
    typeof livemode !== "boolean" ||
    typeof created !== "number" ||
    !Number.isFinite(created) ||
    typeof objectId !== "string" ||
    !OBJECT_ID_PATTERN.test(objectId)
  ) {
    return { status: "malformed" };
  }
  return { status: "verified", event: { id, type, livemode, created, objectId } };
}
