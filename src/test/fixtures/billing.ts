import { vi } from "vitest";

import type {
  BillingGateway,
  CheckoutSessionSnapshot,
  CreateCheckoutInput,
  CreateCustomerInput,
  RetrieveResult,
  SubscriptionSnapshot,
} from "@/lib/billing/gateway";

/**
 * Billing test doubles (BILLING-01): a fake Stripe gateway that records
 * every call, and a minimal fake of the user's RLS Supabase client for the
 * three billing reads (rows per table, filtered by the `eq` calls).
 * Nothing here reaches Stripe or a database.
 */

export const PLANNER_PRICE = "price_TESTONLYplannerMonthly";
export const COUPLE_PRICE = "price_TESTONLYcoupleOneTime";
export const APP_ORIGIN = "https://app.example.test";
export const USER_ID = "7f1d2c3b-4a5e-4f60-8a9b-0c1d2e3f4a5b";
export const OTHER_USER_ID = "11111111-2222-4333-8444-555555555555";

export type FakeGateway = BillingGateway & {
  customers: CreateCustomerInput[];
  sessions: CreateCheckoutInput[];
  portals: { customerId: string; returnUrl: string }[];
  subscriptions: Map<string, RetrieveResult<SubscriptionSnapshot>>;
  checkoutSessions: Map<string, RetrieveResult<CheckoutSessionSnapshot>>;
};

export function fakeGateway(overrides: Partial<BillingGateway> = {}): FakeGateway {
  const customersByKey = new Map<string, string>();
  const gateway: FakeGateway = {
    customers: [],
    sessions: [],
    portals: [],
    subscriptions: new Map(),
    checkoutSessions: new Map(),
    async createCustomer(input) {
      gateway.customers.push(input);
      // Like Stripe: the same idempotency key returns the same customer.
      const id = customersByKey.get(input.idempotencyKey) ?? `cus_TESTONLY${customersByKey.size + 1}`;
      customersByKey.set(input.idempotencyKey, id);
      return { id };
    },
    async createCheckoutSession(input) {
      gateway.sessions.push(input);
      return { id: `cs_test_TESTONLY${gateway.sessions.length}`, url: `https://checkout.stripe.com/c/pay/cs_test_${gateway.sessions.length}` };
    },
    async createPortalSession(input) {
      gateway.portals.push(input);
      return { url: "https://billing.stripe.com/p/session/test_TESTONLY" };
    },
    async retrieveSubscription(id) {
      return gateway.subscriptions.has(id) ? (gateway.subscriptions.get(id) ?? null) : "not_found";
    },
    async retrieveCheckoutSession(id) {
      return gateway.checkoutSessions.has(id) ? (gateway.checkoutSessions.get(id) ?? null) : "not_found";
    },
    ...overrides,
  };
  return gateway;
}

export function subscriptionSnapshot(overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return {
    id: "sub_TESTONLY1",
    customerId: "cus_TESTONLY1",
    status: "active",
    priceId: PLANNER_PRICE,
    currentPeriodEnd: 1_900_000_000,
    cancelAtPeriodEnd: false,
    cancelAt: null,
    metadata: { userId: USER_ID, entitlementKey: "planner_pro" },
    ...overrides,
  };
}

export function checkoutSessionSnapshot(overrides: Partial<CheckoutSessionSnapshot> = {}): CheckoutSessionSnapshot {
  return {
    id: "cs_test_TESTONLY1",
    mode: "payment",
    status: "complete",
    paymentStatus: "paid",
    customerId: "cus_TESTONLY1",
    subscriptionId: null,
    paymentIntentId: "pi_TESTONLY1",
    priceId: COUPLE_PRICE,
    amountTotal: 14_900,
    metadata: { userId: USER_ID, entitlementKey: "couple_access" },
    ...overrides,
  };
}

type Row = Record<string, unknown>;

/** A fake RLS client: `tables[name]` are the rows the caller can see (or an error). */
export function fakeSupabase(tables: Record<string, Row[] | "error">) {
  const reads: { table: string; filters: [string, unknown][] }[] = [];
  const from = vi.fn((table: string) => {
    const filters: [string, unknown][] = [];
    reads.push({ table, filters });
    const result = () => {
      const rows = tables[table] ?? [];
      if (rows === "error") return { data: null, error: { message: "boom" } };
      return { data: rows.filter((row) => filters.every(([column, value]) => row[column] === value)), error: null };
    };
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => {
        const { data, error } = result();
        return { data: data ? (data[0] ?? null) : null, error };
      },
      then: (resolve: (value: ReturnType<typeof result>) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject),
    };
    return builder;
  });
  return { client: { from }, reads };
}
