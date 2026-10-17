import type { AccountType } from "@/lib/accounts/account-type";
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
  paymentIntentId: string | null;
  priceId: string | null;
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
