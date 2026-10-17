import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AccountType } from "@/lib/accounts/account-type";
import { resolvePlannerTrial, type PlannerTrial } from "@/lib/billing/campaigns";
import type { BillingConfig } from "@/lib/billing/config";
import type { BillingCustomerRecorder } from "@/lib/billing/customer-recorder";
import { getBillingEntitlement } from "@/lib/billing/entitlements";
import type { BillingGateway } from "@/lib/billing/gateway";
import {
  BILLING_CANCEL_PATH,
  BILLING_PATH,
  BILLING_PLANS,
  BILLING_SUCCESS_PATH,
  canStartSubscription,
  parseSubscriptionStatus,
  type BillingError,
} from "@/lib/billing/plans";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Starting Checkout and opening the Customer Portal (BILLING-01, ADR-021).
 *
 * The caller is ALWAYS the authenticated, typed user from the server
 * session (`requireAccountType` in the action): the user id and account
 * type are never taken from the browser, and neither is any price, amount,
 * currency, product, mode, entitlement, customer, coupon, promotion code,
 * discount or trial length. The plan follows from the account type
 * (`BILLING_PLANS`), the price from configuration.
 *
 * BILLING-02: every session allows Stripe promotion codes (typed by the
 * customer in Checkout; Stripe validates and applies them). A planner's
 * trial comes only from a campaign KEY the caller passes through, resolved
 * here against the allowlist and the enabled campaigns
 * (`resolvePlannerTrial`); a couple never gets one.
 *
 * Order (start): configuration → already entitled / live subscription →
 * customer (reuse, else create with a per-user idempotency key, then the
 * privileged mapping write, whose stored value wins) → ONE Checkout Session.
 * Nothing here grants access: only the verified webhook does.
 */

type Client = SupabaseClient<Database>;

export type BillingCaller = Readonly<{ supabase: Client; userId: string; accountType: AccountType }>;

export type BillingRuntime = Readonly<{
  config: BillingConfig;
  gateway: BillingGateway;
  recorder: BillingCustomerRecorder;
}>;

export type BillingRedirect = Readonly<{ ok: true; url: string }> | Readonly<{ ok: false; reason: BillingError }>;

/** The idempotency key for a user's one Stripe Customer (stable, no personal data). */
export function customerIdempotencyKey(userId: string): string {
  return `lb-billing-customer:${userId}`;
}

/** The user's own mapped customer id (RLS: only their row is visible), undefined when the read failed. */
async function readOwnCustomer(supabase: Client, userId: string): Promise<string | null | undefined> {
  try {
    const { data, error } = await supabase
      .from("billing_customers")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return undefined;
    return data?.stripe_customer_id ?? null;
  } catch {
    return undefined;
  }
}

/**
 * The user's one Stripe Customer, created at most once.
 *
 * Concurrency: two starts that both find no mapping send the SAME
 * idempotency key, so Stripe returns the same customer to both (within its
 * 24 h key window); the database keeps the first mapping and returns it to
 * every caller, so even an extra customer (a start more than 24 h after an
 * unrecorded one) is never used.
 */
export async function ensureBillingCustomer(caller: BillingCaller, runtime: BillingRuntime): Promise<string | null> {
  const existing = await readOwnCustomer(caller.supabase, caller.userId);
  if (existing === undefined) return null;
  if (existing) return existing;

  const created = await runtime.gateway.createCustomer({
    userId: caller.userId,
    accountType: caller.accountType,
    idempotencyKey: customerIdempotencyKey(caller.userId),
  });
  if (!created) return null;
  return runtime.recorder.record({ userId: caller.userId, stripeCustomerId: created.id });
}

type SubscriptionHistory = Readonly<{
  /** A subscription is still alive in Stripe (fix it in the portal). */
  live: boolean;
  /** Any subscription row at all, in any status (no repeat trials). */
  any: boolean;
}>;

/** The planner's own subscriptions as far as they matter here (undefined = read failed). */
async function readSubscriptionHistory(supabase: Client, userId: string): Promise<SubscriptionHistory | undefined> {
  try {
    const { data, error } = await supabase.from("billing_subscriptions").select("status").eq("user_id", userId);
    if (error) return undefined;
    const statuses = data.flatMap((row) => {
      const status = parseSubscriptionStatus(row.status);
      return status ? [status] : [];
    });
    return { live: !canStartSubscription(statuses), any: data.length > 0 };
  } catch {
    return undefined;
  }
}

/**
 * `requestedCampaign` is whatever the browser named (unvalidated): only a
 * known, enabled campaign key, for a planner with no subscription history,
 * becomes a trial. Anything else is ignored.
 */
export async function startBillingCheckout(
  caller: BillingCaller,
  runtime: BillingRuntime | null,
  requestedCampaign: unknown = null,
): Promise<BillingRedirect> {
  if (!runtime) return { ok: false, reason: "not_available" };
  const plan = BILLING_PLANS[caller.accountType];

  const entitlement = await getBillingEntitlement(caller.supabase, caller.userId, plan.entitlementKey);
  if (entitlement === null) return { ok: false, reason: "failed" };
  if (entitlement === "active") return { ok: false, reason: "already_active" };
  let trial: PlannerTrial | null = null;
  if (plan.mode === "subscription") {
    const history = await readSubscriptionHistory(caller.supabase, caller.userId);
    if (history === undefined) return { ok: false, reason: "failed" };
    if (history.live) return { ok: false, reason: "manage_existing" };
    trial = resolvePlannerTrial({
      accountType: caller.accountType,
      requested: requestedCampaign,
      enabled: runtime.config.trialCampaigns,
      hasSubscriptionHistory: history.any,
    });
  }

  const customerId = await ensureBillingCustomer(caller, runtime);
  if (!customerId) return { ok: false, reason: "failed" };

  const session = await runtime.gateway.createCheckoutSession({
    mode: plan.mode,
    customerId,
    priceId: runtime.config.prices[caller.accountType],
    userId: caller.userId,
    accountType: caller.accountType,
    entitlementKey: plan.entitlementKey,
    trial,
    successUrl: `${runtime.config.appOrigin}${BILLING_SUCCESS_PATH}`,
    cancelUrl: `${runtime.config.appOrigin}${BILLING_CANCEL_PATH}`,
  });
  return session ? { ok: true, url: session.url } : { ok: false, reason: "failed" };
}

/**
 * The planner's Customer Portal for THEIR OWN customer: the id comes only
 * from their own `billing_customers` row (RLS), never from input. Couples
 * have no subscription to manage (not offered).
 */
export async function openBillingPortal(caller: BillingCaller, runtime: BillingRuntime | null): Promise<BillingRedirect> {
  if (!runtime) return { ok: false, reason: "not_available" };
  if (caller.accountType !== "planner") return { ok: false, reason: "failed" };
  const customerId = await readOwnCustomer(caller.supabase, caller.userId);
  if (customerId === undefined) return { ok: false, reason: "failed" };
  if (customerId === null) return { ok: false, reason: "no_customer" };
  const session = await runtime.gateway.createPortalSession({
    customerId,
    returnUrl: `${runtime.config.appOrigin}${BILLING_PATH}`,
  });
  return session ? { ok: true, url: session.url } : { ok: false, reason: "failed" };
}
