import "server-only";

import { Webhook } from "standardwebhooks";

/**
 * The Resend webhook route's authentication (LB-18.2, ADR-011 §7). The ONLY
 * module that reads `process.env.RESEND_WEBHOOK_SECRET` (ESLint-enforced).
 *
 * Resend signs every webhook with Svix, i.e. the Standard Webhooks scheme:
 * `v1,<base64 HMAC-SHA256(secret, "<svix-id>.<svix-timestamp>.<raw body>")>`
 * in `svix-signature` (space-separated, possibly several). Verification uses
 * the `standardwebhooks` library directly, with only the webhook secret: no
 * Resend client and no `RESEND_API_KEY` are involved.
 *
 * Responsibilities, and nothing else:
 *   - parse the `RESEND_WEBHOOK_SECRET` configuration (`whsec_<base64>`);
 *   - check the three signature headers are present and well-formed;
 *   - check the timestamp is within the library's tolerance (± 5 minutes);
 *   - verify the signature over the RAW body exactly as received.
 *
 * It never parses the body, has no Supabase client, never reads the
 * service-role key and holds no business rules. The secret and signatures
 * are never logged, returned or echoed.
 */

/** The Standard Webhooks library's own tolerance (its WEBHOOK_TOLERANCE_IN_SECONDS). */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/** The largest webhook body the route reads (Resend delivery events are a few KiB). */
export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

/** Svix signing secrets carry 24 random bytes; anything shorter is a misconfiguration. */
export const WEBHOOK_SECRET_MIN_BYTES = 24;

/** A Svix message id (`msg_…`): what `email_delivery_events.provider_event_id` stores. */
export const WEBHOOK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const SECRET_PATTERN = /^whsec_([A-Za-z0-9+/]+={0,2})$/;
const TIMESTAMP_PATTERN = /^[0-9]{1,12}$/;
const SIGNATURE_MAX_LENGTH = 4096;

declare const webhookSecretBrand: unique symbol;

/** A parsed, usable secret. Opaque: the key material never leaves this module. */
export type WebhookSecret = Readonly<{ [webhookSecretBrand]: true }>;

const verifiers = new WeakMap<WebhookSecret, Webhook>();

/** The three Svix headers, exactly as received (null = absent). */
export type WebhookSignatureHeaders = Readonly<{
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}>;

export type WebhookVerification =
  | Readonly<{ status: "verified"; eventId: string }>
  | Readonly<{ status: "not_configured" | "missing_headers" | "expired" | "invalid_signature" }>;

/** Pure: the configured secret, or null when missing or malformed. */
export function parseWebhookSecret(raw: string | undefined): WebhookSecret | null {
  if (typeof raw !== "string") return null;
  const encoded = SECRET_PATTERN.exec(raw)?.[1];
  if (!encoded) return null;
  const key = Buffer.from(encoded, "base64");
  // Strict base64: decoding and re-encoding must give back the same text.
  if (key.toString("base64") !== encoded || key.length < WEBHOOK_SECRET_MIN_BYTES) return null;
  const secret = Object.freeze({}) as WebhookSecret;
  verifiers.set(secret, new Webhook(encoded));
  return secret;
}

/** Reads `RESEND_WEBHOOK_SECRET` from the server environment. */
export function getWebhookSecret(): WebhookSecret | null {
  return parseWebhookSecret(process.env.RESEND_WEBHOOK_SECRET);
}

/**
 * Verifies one webhook delivery. `rawBody` must be the request body exactly
 * as received, before any parsing.
 */
export function verifyWebhook(
  rawBody: string,
  headers: WebhookSignatureHeaders,
  secret: WebhookSecret | null,
): WebhookVerification {
  const verifier = secret ? verifiers.get(secret) : undefined;
  if (!verifier) return { status: "not_configured" };

  const { id, timestamp, signature } = headers;
  if (
    !id ||
    !timestamp ||
    !signature ||
    !WEBHOOK_ID_PATTERN.test(id) ||
    !TIMESTAMP_PATTERN.test(timestamp) ||
    signature.length > SIGNATURE_MAX_LENGTH
  ) {
    return { status: "missing_headers" };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) {
    return { status: "expired" };
  }

  try {
    // jsonParse: false — the body is parsed only after this returns.
    verifier.verify(
      rawBody,
      { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signature },
      { jsonParse: false },
    );
  } catch {
    return { status: "invalid_signature" };
  }
  return { status: "verified", eventId: id };
}
