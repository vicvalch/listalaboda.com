import "server-only";

import type { BillingGateway, CheckoutSessionSnapshot } from "@/lib/billing/gateway";
import type { StripeEventEnvelope, BillingWebhookStore } from "@/lib/billing/webhook-store";
import type { VerifiedStripeEvent } from "@/lib/billing/webhook-auth";

/**
 * What one VERIFIED Stripe event does (BILLING-01, ADR-021 §6).
 *
 * The event is only a NOTIFICATION: its embedded object may be stale (events
 * arrive late, twice and out of order), so the current object is RETRIEVED
 * from Stripe and that state is applied, stamped with the time it was
 * observed. The database refuses an observation older than the stored one
 * and never revives a terminal subscription, so replays and reordering can't
 * move access backwards. Correlation (customer → user) and dedupe (event id)
 * happen in the database.
 *
 * Handled (and the only ones the endpoint should subscribe to):
 *   - customer.subscription.created/updated/deleted → the subscription;
 *   - checkout.session.completed → the subscription (mode=subscription) or
 *     the one-time payment (mode=payment);
 *   - checkout.session.async_payment_succeeded/_failed → the one-time payment
 *     settled or failed later (delayed payment methods).
 * Anything else is acknowledged and ignored. Objects without OUR metadata
 * (not created by our Checkout) are ignored: they never grant.
 *
 * Results: `processed` / `ignored` → 200; `retry` (Stripe or the database
 * unreachable, unexpected answer) → 500 so Stripe redelivers.
 */

export type StripeEventResult = "processed" | "ignored" | "retry";

export type WebhookDeps = Readonly<{
  gateway: BillingGateway;
  store: BillingWebhookStore;
  /** The server clock (injected for tests). */
  now: () => Date;
}>;

export const HANDLED_STRIPE_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
] as const;

function envelope(event: VerifiedStripeEvent): StripeEventEnvelope {
  return {
    eventId: event.id,
    eventType: event.type,
    livemode: event.livemode,
    createdAt: new Date(event.created * 1000).toISOString(),
  };
}

function fromStore(result: Awaited<ReturnType<BillingWebhookStore["applySubscription"]>>): StripeEventResult {
  if (result === "error") return "retry";
  return result === "ignored" ? "ignored" : "processed";
}

async function applySubscription(
  event: VerifiedStripeEvent,
  subscriptionId: string,
  deps: WebhookDeps,
): Promise<StripeEventResult> {
  const subscription = await deps.gateway.retrieveSubscription(subscriptionId);
  // Observed when Stripe answered: the database orders observations by it.
  const observedAt = deps.now().toISOString();
  if (subscription === "not_found") return "ignored";
  if (!subscription) return "retry";
  const { metadata, status } = subscription;
  if (metadata.entitlementKey !== "planner_pro" || !metadata.userId || !status) return "ignored";

  return fromStore(
    await deps.store.applySubscription({
      ...envelope(event),
      customerId: subscription.customerId,
      subscriptionId: subscription.id,
      priceId: subscription.priceId,
      metadataUserId: metadata.userId,
      status,
      currentPeriodEnd:
        subscription.currentPeriodEnd === null ? null : new Date(subscription.currentPeriodEnd * 1000).toISOString(),
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      observedAt,
    }),
  );
}

/**
 * Confirmed only when Stripe says the session is complete AND paid, or
 * complete with nothing to pay (BILLING-02): a promotion code covering the
 * whole amount completes Checkout with `no_payment_required`, a zero
 * `amount_total` and NO PaymentIntent. That is a valid purchase; the
 * PaymentIntent is never required.
 */
function paymentStatusOf(event: VerifiedStripeEvent, session: CheckoutSessionSnapshot): "paid" | "pending" | "failed" {
  if (session.status === "complete" && session.paymentStatus === "paid") return "paid";
  if (session.status === "complete" && session.paymentStatus === "no_payment_required" && session.amountTotal === 0) {
    return "paid";
  }
  if (event.type === "checkout.session.async_payment_failed") return "failed";
  return "pending";
}

async function applyCheckoutSession(event: VerifiedStripeEvent, deps: WebhookDeps): Promise<StripeEventResult> {
  const session = await deps.gateway.retrieveCheckoutSession(event.objectId);
  if (session === "not_found") return "ignored";
  if (!session) return "retry";

  if (session.mode === "subscription") {
    if (event.type !== "checkout.session.completed" || !session.subscriptionId) return "ignored";
    return applySubscription(event, session.subscriptionId, deps);
  }
  if (session.mode !== "payment" || session.status !== "complete") return "ignored";

  const { metadata } = session;
  if (metadata.entitlementKey !== "couple_access" || !metadata.userId || !session.customerId) return "ignored";

  return fromStore(
    await deps.store.applyCheckoutPayment({
      ...envelope(event),
      customerId: session.customerId,
      checkoutSessionId: session.id,
      paymentIntentId: session.paymentIntentId,
      priceId: session.priceId,
      metadataUserId: metadata.userId,
      paymentStatus: paymentStatusOf(event, session),
    }),
  );
}

export async function processStripeEvent(event: VerifiedStripeEvent, deps: WebhookDeps): Promise<StripeEventResult> {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return applySubscription(event, event.objectId, deps);
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed":
      return applyCheckoutSession(event, deps);
    default:
      return "ignored";
  }
}
