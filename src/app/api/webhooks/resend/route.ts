import { NextResponse, type NextRequest } from "next/server";

import { getDeliveryEventStore } from "@/lib/email/delivery-event-store";
import { parseResendDeliveryEvent } from "@/lib/email/delivery-events";
import { WEBHOOK_MAX_BODY_BYTES, getWebhookSecret, verifyWebhook } from "@/lib/email/webhook-auth";

/**
 * Resend's delivery webhook (LB-18.2, ADR-011 §7). Passive ingestion only:
 * it records signed delivery events and advances a recorded email's
 * delivery status; nothing else reads it yet. NOT ACTIVATED in production
 * (no webhook configured, no `RESEND_WEBHOOK_SECRET`; LB-18.5).
 *
 * - POST only; Next answers 405 for every other method (none is exported).
 * - The provider's signature is the ONLY authority: no cookies, member
 *   session, CSRF token or redirect. `/api/webhooks/resend` is excluded
 *   from the session proxy.
 * - Order: configuration (503) → raw body, at most 64 KiB (413) → signature
 *   headers and Standard Webhooks verification over the raw body (401) →
 *   only then JSON parsing and normalization → one ingest call.
 * - Every verified event is acknowledged with 200 once handled: applied,
 *   no change, duplicate, unknown message (pre-ledger sends, deleted
 *   parties, provider test events, other environments), unsupported types
 *   (opens, clicks, sent, contact/domain events…) and malformed bodies
 *   (signed, so a retry can't fix them). A database failure answers 500 so
 *   the provider retries; duplicates of a retried event are harmless.
 * - Responses are empty: never ids, addresses, payloads or signatures.
 *   Nothing is logged.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function empty(status: number): NextResponse {
  return new NextResponse(null, { status, headers: NO_STORE });
}

/** The body as text, or null once it exceeds the limit (stops reading there). */
async function readRawBody(request: NextRequest): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > WEBHOOK_MAX_BODY_BYTES) return null;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > WEBHOOK_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(request: NextRequest) {
  const secret = getWebhookSecret();
  if (!secret) return empty(503);

  let rawBody: string | null;
  try {
    rawBody = await readRawBody(request);
  } catch {
    return empty(400);
  }
  if (rawBody === null) return empty(413);

  const verification = verifyWebhook(
    rawBody,
    {
      id: request.headers.get("svix-id"),
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
    },
    secret,
  );
  if (verification.status === "not_configured") return empty(503);
  if (verification.status !== "verified") return empty(401);

  const parsed = parseResendDeliveryEvent(rawBody);
  if (parsed.status === "ignored") return empty(200);

  const store = getDeliveryEventStore();
  if (!store) return empty(503);

  const result = await store.ingest({ providerEventId: verification.eventId, event: parsed.event });
  return empty(result === "error" ? 500 : 200);
}
