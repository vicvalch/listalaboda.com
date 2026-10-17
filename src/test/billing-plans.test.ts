import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  BILLING_PLANS,
  BILLING_SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_GRANTING_STATUSES,
  canStartSubscription,
  parseBillingError,
  subscriptionGrantsAccess,
  type BillingSubscriptionStatus,
} from "@/lib/billing/plans";
import { coupleBillingView, plannerBillingView } from "@/lib/billing/presentation";

const { parseBillingConfig } = await import("@/lib/billing/config");
const { parseStripeGatewaySettings, toCheckoutSessionSnapshot, toSubscriptionSnapshot } = await import(
  "@/lib/billing/stripe-gateway"
);
const { parseStripeWebhookSecret } = await import("@/lib/billing/webhook-auth");

// BILLING-01 (ADR-021): the plan mapping, the subscription policy, the
// billing page's derived view and the configuration parsers.

describe("plans", () => {
  it("planner → monthly subscription for planner_pro; couple → one-time payment for couple_access", () => {
    expect(BILLING_PLANS).toEqual({
      planner: { entitlementKey: "planner_pro", mode: "subscription" },
      couple: { entitlementKey: "couple_access", mode: "payment" },
    });
  });
});

describe("planner subscription policy", () => {
  const expected: Record<BillingSubscriptionStatus, boolean> = {
    active: true,
    trialing: true,
    past_due: false,
    unpaid: false,
    paused: false,
    incomplete: false,
    incomplete_expired: false,
    canceled: false,
  };

  it.each(Object.entries(expected))("%s grants: %s", (status, grants) => {
    expect(subscriptionGrantsAccess(status as BillingSubscriptionStatus)).toBe(grants);
  });

  it("covers every Stripe status and grants only active and trialing", () => {
    expect([...BILLING_SUBSCRIPTION_STATUSES].sort()).toEqual(Object.keys(expected).sort());
    expect([...SUBSCRIPTION_GRANTING_STATUSES].sort()).toEqual(["active", "trialing"]);
  });

  it("a new subscription may start only when every existing one is terminal", () => {
    expect(canStartSubscription([])).toBe(true);
    expect(canStartSubscription(["canceled", "incomplete_expired"])).toBe(true);
    for (const status of ["active", "trialing", "past_due", "unpaid", "paused", "incomplete"] as const) {
      expect(canStartSubscription(["canceled", status])).toBe(false);
    }
  });
});

describe("billing page view", () => {
  const sub = (status: BillingSubscriptionStatus, extra: Partial<{ currentPeriodEnd: string; cancelAtPeriodEnd: boolean }> = {}) => ({
    status,
    currentPeriodEnd: extra.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: extra.cancelAtPeriodEnd ?? false,
  });

  it("planner: the ENTITLEMENT decides active, never the subscription row alone", () => {
    expect(
      plannerBillingView({ kind: "planner", entitlement: "inactive", subscriptions: [sub("active")] }, true).state,
    ).not.toBe("active");
    expect(
      plannerBillingView(
        { kind: "planner", entitlement: "active", subscriptions: [sub("active", { currentPeriodEnd: "2027-01-01T00:00:00Z", cancelAtPeriodEnd: true })] },
        true,
      ),
    ).toEqual({ kind: "planner", state: "active", periodEnd: "2027-01-01T00:00:00Z", cancelAtPeriodEnd: true, action: "manage" });
    expect(
      plannerBillingView({ kind: "planner", entitlement: "active", subscriptions: [sub("trialing")] }, true).state,
    ).toBe("trialing");
  });

  it("planner: a past_due subscription is a problem fixed in the portal; none/canceled offers subscribing", () => {
    expect(plannerBillingView({ kind: "planner", entitlement: "inactive", subscriptions: [sub("past_due")] }, true)).toMatchObject({
      state: "problem",
      action: "manage",
    });
    expect(plannerBillingView({ kind: "planner", entitlement: "inactive", subscriptions: [sub("canceled")] }, true)).toMatchObject({
      state: "none",
      action: "subscribe",
    });
    expect(plannerBillingView({ kind: "planner", entitlement: "inactive", subscriptions: [] }, false).action).toBeNull();
  });

  it("couple: paid → active (no second payment); pending → no action; none → buy", () => {
    expect(
      coupleBillingView({ kind: "couple", entitlement: "active", purchases: [{ status: "paid", purchasedAt: "2026-10-16T00:00:00Z" }] }, true),
    ).toEqual({ kind: "couple", state: "active", paidAt: "2026-10-16T00:00:00Z", action: null });
    expect(coupleBillingView({ kind: "couple", entitlement: "inactive", purchases: [{ status: "pending", purchasedAt: null }] }, true)).toMatchObject({
      state: "pending",
      action: null,
    });
    expect(coupleBillingView({ kind: "couple", entitlement: "inactive", purchases: [{ status: "failed", purchasedAt: null }] }, true)).toMatchObject({
      state: "none",
      action: "buy",
    });
  });

  it("error query values are a closed set", () => {
    expect(parseBillingError("failed")).toBe("failed");
    expect(parseBillingError("<script>")).toBeNull();
    expect(parseBillingError(["failed"])).toBeNull();
  });
});

describe("billing configuration", () => {
  const valid = {
    APP_ORIGIN: "https://listalaboda.example",
    STRIPE_PLANNER_MONTHLY_PRICE_ID: "price_TESTONLYplanner",
    STRIPE_COUPLE_ONE_TIME_PRICE_ID: "price_TESTONLYcouple",
  };

  it("reads the two configured price ids and the canonical origin", () => {
    expect(parseBillingConfig(valid)).toEqual({
      appOrigin: "https://listalaboda.example",
      prices: { planner: "price_TESTONLYplanner", couple: "price_TESTONLYcouple" },
    });
  });

  it.each([
    ["no origin", { ...valid, APP_ORIGIN: "" }],
    ["http origin", { ...valid, APP_ORIGIN: "http://listalaboda.example" }],
    ["no planner price", { ...valid, STRIPE_PLANNER_MONTHLY_PRICE_ID: undefined }],
    ["a product id instead of a price", { ...valid, STRIPE_COUPLE_ONE_TIME_PRICE_ID: "prod_TESTONLY" }],
    ["an amount instead of a price", { ...valid, STRIPE_PLANNER_MONTHLY_PRICE_ID: "99" }],
    ["one price for both plans", { ...valid, STRIPE_COUPLE_ONE_TIME_PRICE_ID: "price_TESTONLYplanner" }],
  ])("%s → not available", (_label, source) => {
    expect(parseBillingConfig(source)).toBeNull();
  });

  it("the Stripe key must look like a secret/restricted key; a publishable key is refused", () => {
    expect(parseStripeGatewaySettings({ STRIPE_SECRET_KEY: "sk_test_TESTONLY0123456789" }, null)).toEqual({
      secretKey: "sk_test_TESTONLY0123456789",
    });
    expect(parseStripeGatewaySettings({ STRIPE_SECRET_KEY: "pk_test_TESTONLY0123456789" }, null)).toBeNull();
    expect(parseStripeGatewaySettings({}, null)).toBeNull();
  });

  it("a local Stripe stand-in is accepted only with a localhost APP_ORIGIN and a localhost base", () => {
    const key = { STRIPE_SECRET_KEY: "sk_test_TESTONLY0123456789" };
    expect(parseStripeGatewaySettings({ ...key, STRIPE_API_BASE: "http://127.0.0.1:12111" }, "http://localhost:3100")).toEqual({
      secretKey: key.STRIPE_SECRET_KEY,
      apiBase: { protocol: "http", host: "127.0.0.1", port: 12111 },
    });
    expect(parseStripeGatewaySettings({ ...key, STRIPE_API_BASE: "http://127.0.0.1:12111" }, "https://listalaboda.com")).toBeNull();
    expect(parseStripeGatewaySettings({ ...key, STRIPE_API_BASE: "https://evil.example" }, "http://localhost:3100")).toBeNull();
  });

  it("the webhook secret must be a whsec_ secret", () => {
    expect(parseStripeWebhookSecret("whsec_TEST_ONLY_billing_webhook_secret_0001")).not.toBeNull();
    expect(parseStripeWebhookSecret("sk_test_TESTONLY0123456789")).toBeNull();
    expect(parseStripeWebhookSecret(undefined)).toBeNull();
  });
});

describe("Stripe object normalization", () => {
  it("a subscription: item-level period end and price, our metadata only", () => {
    expect(
      toSubscriptionSnapshot({
        id: "sub_TESTONLY1",
        customer: "cus_TESTONLY1",
        status: "past_due",
        cancel_at_period_end: true,
        items: { data: [{ current_period_end: 1_900_000_000, price: { id: "price_TESTONLYplanner" } }] },
        metadata: { lb_user_id: "7F1D2C3B-4A5E-4F60-8A9B-0C1D2E3F4A5B", lb_entitlement: "planner_pro", email: "x@example.test" },
      }),
    ).toEqual({
      id: "sub_TESTONLY1",
      customerId: "cus_TESTONLY1",
      status: "past_due",
      priceId: "price_TESTONLYplanner",
      currentPeriodEnd: 1_900_000_000,
      cancelAtPeriodEnd: true,
      metadata: { userId: "7f1d2c3b-4a5e-4f60-8a9b-0c1d2e3f4a5b", entitlementKey: "planner_pro" },
    });
  });

  it("unknown status and malformed metadata never become grants", () => {
    const snapshot = toSubscriptionSnapshot({
      id: "sub_TESTONLY1",
      customer: { id: "cus_TESTONLY1" },
      status: "super_active",
      items: { data: [] },
      metadata: { lb_user_id: "not-a-uuid", lb_entitlement: "admin" },
    });
    expect(snapshot).toMatchObject({ status: null, metadata: { userId: null, entitlementKey: null } });
  });

  it("a checkout session: price from the expanded line item", () => {
    expect(
      toCheckoutSessionSnapshot({
        id: "cs_test_TESTONLY1",
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        customer: "cus_TESTONLY1",
        payment_intent: { id: "pi_TESTONLY1" },
        line_items: { data: [{ price: { id: "price_TESTONLYcouple" } }] },
        metadata: { lb_user_id: "7f1d2c3b-4a5e-4f60-8a9b-0c1d2e3f4a5b", lb_entitlement: "couple_access" },
      }),
    ).toMatchObject({ paymentIntentId: "pi_TESTONLY1", priceId: "price_TESTONLYcouple", paymentStatus: "paid" });
  });
});
