import Stripe from "stripe";

/**
 * FAKE, test-only Stripe webhook signing secrets (BILLING-01). Their text
 * says so; they sign nothing real. Signatures are made with Stripe's own
 * test helper (`generateTestHeaderString`), exactly the scheme the route
 * verifies.
 */
export const TEST_STRIPE_WEBHOOK_SECRET = "whsec_TEST_ONLY_billing_webhook_secret_0001";
export const WRONG_TEST_STRIPE_WEBHOOK_SECRET = "whsec_TEST_ONLY_forger_webhook_secret_0002";

export type StripeEventFixture = Readonly<{
  id: string;
  type: string;
  /** The event's `data.object` (at least its id). */
  object: Readonly<Record<string, unknown>> & { id: string };
  /** Unix seconds. */
  created?: number;
  livemode?: boolean;
}>;

/** A Stripe event envelope as Stripe sends it (snapshot payload). */
export function stripeEventBody(event: StripeEventFixture): string {
  return JSON.stringify({
    id: event.id,
    object: "event",
    api_version: "2026-08-26.dahlia",
    created: event.created ?? Math.floor(Date.now() / 1000),
    livemode: event.livemode ?? false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: event.type,
    data: { object: event.object },
  });
}

export type SignedStripeEvent = Readonly<{ body: string; headers: Record<string, string> }>;

export function signStripeEvent(
  body: string,
  options: Readonly<{ secret?: string; timestamp?: number }> = {},
): SignedStripeEvent {
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: options.secret ?? TEST_STRIPE_WEBHOOK_SECRET,
    ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
  });
  return { body, headers: { "content-type": "application/json", "stripe-signature": signature } };
}
