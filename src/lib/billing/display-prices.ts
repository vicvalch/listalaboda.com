import type { AccountType } from "@/lib/accounts/account-type";

/**
 * The prices SHOWN to people (BILLING-02, ADR-021 §15): the frozen
 * commercial model, display copy only. Pure.
 *
 * What is CHARGED is the configured Stripe Price (`@/lib/billing/config`):
 * nothing here is sent to Stripe, compared, or used to compute anything.
 * When a Stripe price changes, this file changes in the same release (the
 * live prices are recorded in ADR-021 §15). Stripe Checkout always shows the
 * exact amount, discount and trial before the customer confirms.
 */
export type DisplayPrice = Readonly<{ amount: string; currency: "USD" }>;

export const PLAN_DISPLAY_PRICES: Readonly<Record<AccountType, DisplayPrice>> = {
  /** Monthly subscription. */
  planner: { amount: "$99", currency: "USD" },
  /** One-time payment. */
  couple: { amount: "$149", currency: "USD" },
};

/** "$99 USD" */
export function displayPrice(accountType: AccountType): string {
  const price = PLAN_DISPLAY_PRICES[accountType];
  return `${price.amount} ${price.currency}`;
}
