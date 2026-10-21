import type { AccountType } from "@/lib/accounts/account-type";
import type { PlannerTrial } from "@/lib/billing/campaigns";
import type { BillingEntitlementKey, BillingSubscriptionStatus, CheckoutMode } from "@/lib/billing/plans";

/**
 * The application's view of Stripe (BILLING-01, ADR-021): the five calls it
 * makes, with Stripe objects normalized to the few fields it reads. The
 * Stripe implementation lives only in `@/lib/billing/stripe-gateway`; tests
 * inject fakes and never reach Stripe. Pure types.
 *
 * Every method answers `null` on any failure (network, refusal, unexpected
 * answer); errors and Stripe payloads never travel further.
 */

/** Our own metadata on a Stripe object, already parsed (null = absent or malformed). */
export type BillingObjectMetadata = Readonly<{
  userId: string | null;
  entitlementKey: BillingEntitlementKey | null;
}>;

export type SubscriptionSnapshot = Readonly<{
  id: string;
  customerId: string;
  /** null = a status this application doesn't know (never granted). */
  status: BillingSubscriptionStatus | null;
  priceId: string | null;
  /** Unix seconds; null when Stripe gives none. */
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  /** QA-03a: Unix seconds Stripe will cancel at (`cancel_at`); null when none is scheduled. */
  cancelAt: number | null;
  metadata: BillingObjectMetadata;
}>;

export type CheckoutSessionSnapshot = Readonly<{
  id: string;
  mode: CheckoutMode | "setup";
  /** open | complete | expired */
  status: string | null;
  /** paid | unpaid | no_payment_required */
  paymentStatus: string;
  customerId: string | null;
  subscriptionId: string | null;
  /** May be null when nothing was paid (a promotion code covering the whole amount, BILLING-02). */
  paymentIntentId: string | null;
  priceId: string | null;
  /** Minor units after discounts; null when Stripe gives none. */
  amountTotal: number | null;
  metadata: BillingObjectMetadata;
}>;

export type CreateCustomerInput = Readonly<{
  userId: string;
  accountType: AccountType;
  /** Stable per user, so concurrent starts get the SAME customer back from Stripe. */
  idempotencyKey: string;
}>;

export type CreateCheckoutInput = Readonly<{
  mode: CheckoutMode;
  customerId: string;
  priceId: string;
  userId: string;
  accountType: AccountType;
  entitlementKey: BillingEntitlementKey;
  /**
   * BILLING-02: a server-resolved planner trial (`resolvePlannerTrial`), only
   * ever with `mode: "subscription"`; null = no trial. Promotion codes are
   * always allowed: the customer types one in Stripe Checkout, Stripe decides.
   */
  trial: PlannerTrial | null;
  successUrl: string;
  cancelUrl: string;
}>;

export type RetrieveResult<T> = T | "not_found" | null;

export interface BillingGateway {
  createCustomer(input: CreateCustomerInput): Promise<Readonly<{ id: string }> | null>;
  createCheckoutSession(input: CreateCheckoutInput): Promise<Readonly<{ id: string; url: string }> | null>;
  createPortalSession(input: Readonly<{ customerId: string; returnUrl: string }>): Promise<Readonly<{ url: string }> | null>;
  retrieveSubscription(id: string): Promise<RetrieveResult<SubscriptionSnapshot>>;
  retrieveCheckoutSession(id: string): Promise<RetrieveResult<CheckoutSessionSnapshot>>;
}
