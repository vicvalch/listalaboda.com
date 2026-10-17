import "server-only";

import type { AccountType } from "@/lib/accounts/account-type";
import { parseAppOrigin } from "@/lib/http/app-origin";

/**
 * Billing configuration (BILLING-01, ADR-021 §4): the canonical origin and
 * the two configured Stripe Price ids. Billing CONFIGURATION, never
 * authorization: application code reasons about entitlement keys
 * (`@/lib/billing/plans`), and the server picks the price from the
 * authenticated account type. Amounts and currencies live in Stripe only;
 * nothing here (or anywhere in the code) hardcodes a price.
 *
 * The Stripe secret key is read only by `@/lib/billing/stripe-gateway`, the
 * webhook secret only by `@/lib/billing/webhook-auth` (ESLint). Missing or
 * malformed values are a uniform "not available": nothing is sold, nothing
 * else breaks. Values are never echoed.
 */

export type BillingConfig = Readonly<{
  appOrigin: string;
  prices: Readonly<Record<AccountType, string>>;
}>;

type EnvSource = Readonly<Record<string, string | undefined>>;

/** A Stripe Price id (`price_…`). */
export const STRIPE_PRICE_ID_PATTERN = /^price_[A-Za-z0-9_]{1,250}$/;

/** Pure: the billing configuration, or null when anything is missing or malformed. */
export function parseBillingConfig(source: EnvSource): BillingConfig | null {
  const read = (name: string) => source[name]?.trim() ?? "";
  const appOrigin = parseAppOrigin(read("APP_ORIGIN"));
  const planner = read("STRIPE_PLANNER_MONTHLY_PRICE_ID");
  const couple = read("STRIPE_COUPLE_ONE_TIME_PRICE_ID");
  if (!appOrigin || !STRIPE_PRICE_ID_PATTERN.test(planner) || !STRIPE_PRICE_ID_PATTERN.test(couple)) return null;
  // One price per plan: the same id for both would sell one product as the other.
  if (planner === couple) return null;
  return { appOrigin, prices: { planner, couple } };
}

export function getBillingConfig(): BillingConfig | null {
  return parseBillingConfig({
    APP_ORIGIN: process.env.APP_ORIGIN,
    STRIPE_PLANNER_MONTHLY_PRICE_ID: process.env.STRIPE_PLANNER_MONTHLY_PRICE_ID,
    STRIPE_COUPLE_ONE_TIME_PRICE_ID: process.env.STRIPE_COUPLE_ONE_TIME_PRICE_ID,
  });
}
