import type { AccountType } from "@/lib/accounts/account-type";

/**
 * What each account type can buy, and which Stripe states grant access
 * (BILLING-01, ADR-021). Pure and dependency-free.
 *
 * Application code talks about ENTITLEMENT KEYS (`planner_pro`,
 * `couple_access`), never Stripe ids: price ids are billing configuration
 * (`@/lib/billing/config`), chosen on the server from the account type.
 * Nothing here gates an existing feature (ADR-021 §11).
 */

/** Mirrors the `public.billing_entitlement_key` enum. Values are never removed. */
export const BILLING_ENTITLEMENT_KEYS = ["planner_pro", "couple_access"] as const;
export type BillingEntitlementKey = (typeof BILLING_ENTITLEMENT_KEYS)[number];

export type CheckoutMode = "subscription" | "payment";

export type BillingPlan = Readonly<{
  entitlementKey: BillingEntitlementKey;
  mode: CheckoutMode;
}>;

/**
 * One plan per account type, fixed: a planner subscribes monthly, a couple
 * pays once. Never chosen by the browser.
 */
export const BILLING_PLANS: Readonly<Record<AccountType, BillingPlan>> = {
  planner: { entitlementKey: "planner_pro", mode: "subscription" },
  couple: { entitlementKey: "couple_access", mode: "payment" },
};

/** Mirrors the `public.billing_subscription_status` enum: every Stripe subscription status. */
export const BILLING_SUBSCRIPTION_STATUSES = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
] as const;
export type BillingSubscriptionStatus = (typeof BILLING_SUBSCRIPTION_STATUSES)[number];

/**
 * THE planner policy (ADR-021 §7), mirroring
 * `private.billing_subscription_grants` (the database decides; a DB test
 * compares the two). `past_due` does NOT grant: no grace period until the
 * business decides one.
 */
export const SUBSCRIPTION_GRANTING_STATUSES: readonly BillingSubscriptionStatus[] = ["active", "trialing"];

/** Stripe never moves a subscription out of these. */
export const TERMINAL_SUBSCRIPTION_STATUSES: readonly BillingSubscriptionStatus[] = ["canceled", "incomplete_expired"];

export function parseSubscriptionStatus(value: unknown): BillingSubscriptionStatus | null {
  return typeof value === "string" && (BILLING_SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
    ? (value as BillingSubscriptionStatus)
    : null;
}

export function parseEntitlementKey(value: unknown): BillingEntitlementKey | null {
  return typeof value === "string" && (BILLING_ENTITLEMENT_KEYS as readonly string[]).includes(value)
    ? (value as BillingEntitlementKey)
    : null;
}

export function subscriptionGrantsAccess(status: BillingSubscriptionStatus): boolean {
  return SUBSCRIPTION_GRANTING_STATUSES.includes(status);
}

/**
 * Whether a planner may start a NEW subscription Checkout: only when no
 * subscription of theirs is still alive in Stripe (none, or only terminal
 * ones). A past_due/unpaid/paused/incomplete one is fixed in the Customer
 * Portal instead, so a second subscription is never started by accident.
 */
export function canStartSubscription(statuses: readonly BillingSubscriptionStatus[]): boolean {
  return statuses.every((status) => TERMINAL_SUBSCRIPTION_STATUSES.includes(status));
}

/**
 * Metadata our server writes on Stripe objects (customer, Checkout Session,
 * subscription, payment intent). Ids and closed values only: never an
 * email, name or other personal data. The webhook only trusts it together
 * with the local customer mapping (ADR-021 §6).
 */
export const BILLING_METADATA = {
  userId: "lb_user_id",
  accountType: "lb_account_type",
  entitlement: "lb_entitlement",
} as const;

export const BILLING_PATH = "/app/billing";
export const BILLING_SUCCESS_PATH = "/app/billing/success";
export const BILLING_CANCEL_PATH = "/app/billing/cancel";

/** Closed `?error=` values of the billing page. */
export const BILLING_ERRORS = [
  "not_available",
  "already_active",
  "manage_existing",
  "no_customer",
  "failed",
] as const;
export type BillingError = (typeof BILLING_ERRORS)[number];

export function parseBillingError(value: unknown): BillingError | null {
  return typeof value === "string" && (BILLING_ERRORS as readonly string[]).includes(value)
    ? (value as BillingError)
    : null;
}
