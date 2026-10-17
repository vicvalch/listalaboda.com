import { NextResponse, type NextRequest } from "next/server";

import { getStripeGateway } from "@/lib/billing/stripe-gateway";
import { processStripeEvent } from "@/lib/billing/webhook";
import { STRIPE_WEBHOOK_MAX_BODY_BYTES, getStripeWebhookSecret, verifyStripeWebhook } from "@/lib/billing/webhook-auth";
import { getBillingWebhookStore } from "@/lib/billing/webhook-store";

/**
 * Stripe's webhook (BILLING-01, ADR-021 §6): the ONLY way paid access is
 * granted or revoked. NOT ACTIVATED in production (no endpoint registered,
 * no `STRIPE_WEBHOOK_SECRET`); activation is a separately approved step.
 *
 * - POST only; Next answers 405 for every other method (none is exported).
 * - The Stripe-Signature is the ONLY authority: no cookies, session, CSRF
 *   token or redirect. `/api/stripe/webhook` is excluded from the session proxy.
 * - Order: configuration (503) → raw body, at most 256 KiB (413) →
 *   signature over the raw body, before any parsing (401) → retrieve the
 *   current object from Stripe → one database call (dedupe by event id,
 *   local correlation, monotonic state, entitlement recomputed).
 * - Handled, ignored (unsupported type, not our object) and duplicate events
 *   answer 200. Stripe or the database unreachable answers 500, so Stripe
 *   redelivers (replays are harmless).
 * - Responses are empty: never ids, payloads or signatures. Nothing is logged.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function empty(status: number): NextResponse {
  return new NextResponse(null, { status, headers: NO_STORE });
}

/** The body as text, or null once it exceeds the limit (stops reading there). */
async function readRawBody(request: NextRequest): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > STRIPE_WEBHOOK_MAX_BODY_BYTES) return null;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > STRIPE_WEBHOOK_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(request: NextRequest) {
  const secret = getStripeWebhookSecret();
  if (!secret) return empty(503);

  let rawBody: string | null;
  try {
    rawBody = await readRawBody(request);
  } catch {
    return empty(400);
  }
  if (rawBody === null) return empty(413);

  const verification = verifyStripeWebhook(rawBody, request.headers.get("stripe-signature"), secret);
  if (verification.status === "not_configured") return empty(503);
  if (verification.status === "malformed") return empty(200);
  if (verification.status !== "verified") return empty(401);

  const gateway = getStripeGateway();
  const store = getBillingWebhookStore();
  if (!gateway || !store) return empty(503);

  const result = await processStripeEvent(verification.event, { gateway, store, now: () => new Date() });
  return empty(result === "retry" ? 500 : 200);
}
