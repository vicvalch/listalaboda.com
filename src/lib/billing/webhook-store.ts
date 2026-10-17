import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { BillingSubscriptionStatus } from "@/lib/billing/plans";
import { parseRecorderSettings } from "@/lib/email/delivery-recorder";
import { getPublicEnv } from "@/lib/env/public";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The Stripe webhook's database boundary (BILLING-01, ADR-021 §6): a
 * sanctioned service-role use (ADR-002 §6), separate from the customer
 * recorder and from every email/scheduler store.
 *
 * Authority: STRIPE's, established only by the webhook signature
 * (`@/lib/billing/webhook-auth`) before this store is called. No session
 * exists to authorize a webhook and clients must never be able to grant
 * themselves paid access, so subscriptions, purchases, entitlements and the
 * event ledger have no client write privilege, and the two functions called
 * here are SECURITY DEFINER and executable ONLY by service_role.
 *
 * Exactly two operations, each one fixed RPC, one event per call. They take
 * the verified event's envelope plus the object state the application
 * RETRIEVED from Stripe, never a raw payload; the database correlates the
 * customer to its user itself, dedupes by event id and recomputes the
 * entitlement in the same transaction. The privileged client is created
 * inside and never returned or exported: no `from()`, no generic
 * `rpc(name)`. The key is never logged, returned or echoed; missing
 * configuration fails closed.
 */

export type StripeEventEnvelope = Readonly<{
  eventId: string;
  eventType: string;
  livemode: boolean;
  /** ISO timestamp of the event's creation. */
  createdAt: string;
}>;

export type SubscriptionApplication = StripeEventEnvelope &
  Readonly<{
    customerId: string;
    subscriptionId: string;
    priceId: string | null;
    metadataUserId: string;
    status: BillingSubscriptionStatus;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    /** When the application retrieved this state from Stripe (ISO). */
    observedAt: string;
  }>;

export type CheckoutPaymentApplication = StripeEventEnvelope &
  Readonly<{
    customerId: string;
    checkoutSessionId: string;
    paymentIntentId: string | null;
    priceId: string | null;
    metadataUserId: string;
    paymentStatus: Database["public"]["Enums"]["billing_purchase_status"];
  }>;

export type StripeWebhookApplyResult = Database["public"]["Enums"]["stripe_webhook_outcome"] | "error";

export interface BillingWebhookStore {
  applySubscription(input: SubscriptionApplication): Promise<StripeWebhookApplyResult>;
  applyCheckoutPayment(input: CheckoutPaymentApplication): Promise<StripeWebhookApplyResult>;
}

type StoreSettings = Readonly<{ supabaseUrl: string; serviceRoleKey: string }>;

const OUTCOMES: ReadonlySet<string> = new Set(["applied", "no_change", "stale", "ignored", "duplicate"]);

function toResult(data: unknown, error: unknown): StripeWebhookApplyResult {
  if (error || typeof data !== "string" || !OUTCOMES.has(data)) return "error";
  return data as Exclude<StripeWebhookApplyResult, "error">;
}

export function createBillingWebhookStore({ supabaseUrl, serviceRoleKey }: StoreSettings): BillingWebhookStore {
  const privileged = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  return {
    async applySubscription(input) {
      const args: Database["public"]["Functions"]["apply_stripe_subscription_event"]["Args"] = {
        stripe_event_id: input.eventId,
        event_type: input.eventType,
        event_livemode: input.livemode,
        event_created_at: input.createdAt,
        stripe_customer_id: input.customerId,
        stripe_subscription_id: input.subscriptionId,
        metadata_user_id: input.metadataUserId,
        entitlement_key: "planner_pro",
        subscription_status: input.status,
        cancel_at_period_end: input.cancelAtPeriodEnd,
        observed_at: input.observedAt,
        ...(input.priceId ? { stripe_price_id: input.priceId } : {}),
        ...(input.currentPeriodEnd ? { current_period_end: input.currentPeriodEnd } : {}),
      };
      try {
        const { data, error } = await privileged.rpc("apply_stripe_subscription_event", args);
        return toResult(data, error);
      } catch {
        return "error";
      }
    },

    async applyCheckoutPayment(input) {
      const args: Database["public"]["Functions"]["apply_stripe_checkout_payment_event"]["Args"] = {
        stripe_event_id: input.eventId,
        event_type: input.eventType,
        event_livemode: input.livemode,
        event_created_at: input.createdAt,
        stripe_customer_id: input.customerId,
        stripe_checkout_session_id: input.checkoutSessionId,
        metadata_user_id: input.metadataUserId,
        entitlement_key: "couple_access",
        payment_status: input.paymentStatus,
        ...(input.paymentIntentId ? { stripe_payment_intent_id: input.paymentIntentId } : {}),
        ...(input.priceId ? { stripe_price_id: input.priceId } : {}),
      };
      try {
        const { data, error } = await privileged.rpc("apply_stripe_checkout_payment_event", args);
        return toResult(data, error);
      } catch {
        return "error";
      }
    },
  };
}

/** The store from the server environment, or null when not configured. */
export function getBillingWebhookStore(): BillingWebhookStore | null {
  let supabaseUrl: string;
  try {
    supabaseUrl = getPublicEnv().supabaseUrl;
  } catch {
    return null;
  }
  const settings = parseRecorderSettings({
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    // ADR-021 §6, ADR-002 §6: a sanctioned read of this key (ESLint allows it in the named stores only).
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  return settings ? createBillingWebhookStore(settings) : null;
}
