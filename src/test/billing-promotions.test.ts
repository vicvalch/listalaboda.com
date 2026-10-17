import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The Stripe SDK is replaced by a recorder of the exact request parameters
// (no network): what the REAL gateway asks Stripe Checkout for.
const stripeSdk = vi.hoisted(() => {
  const created: Record<string, unknown>[] = [];
  class StripeError extends Error {
    code?: string;
    statusCode?: number;
  }
  class FakeStripe {
    static errors = { StripeError };
    checkout = {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          created.push(params);
          return { id: "cs_test_TESTONLYpromo", url: "https://checkout.stripe.com/c/pay/cs_test_TESTONLYpromo" };
        },
      },
    };
  }
  return { created, FakeStripe };
});
vi.mock("stripe", () => ({ default: stripeSdk.FakeStripe }));

import {
  PLANNER_TRIAL_CAMPAIGNS,
  billingPathWithCampaign,
  parsePlannerTrialCampaign,
  resolvePlannerTrial,
} from "@/lib/billing/campaigns";
import { PLAN_DISPLAY_PRICES, displayPrice } from "@/lib/billing/display-prices";
import type { CreateCheckoutInput } from "@/lib/billing/gateway";
import { BILLING_PLANS, SUBSCRIPTION_GRANTING_STATUSES, subscriptionGrantsAccess } from "@/lib/billing/plans";

import { APP_ORIGIN, COUPLE_PRICE, PLANNER_PRICE, USER_ID } from "./fixtures/billing";

const { createStripeGateway } = await import("@/lib/billing/stripe-gateway");

// BILLING-02 (ADR-021 §15): promotion codes, planner trial campaigns and the
// display prices.

const gateway = createStripeGateway({ secretKey: "sk_test_TESTONLY0123456789" });

const base = {
  customerId: "cus_TESTONLY1",
  userId: USER_ID,
  successUrl: `${APP_ORIGIN}/app/billing/success`,
  cancelUrl: `${APP_ORIGIN}/app/billing/cancel`,
} as const;

const plannerInput = (trial: CreateCheckoutInput["trial"] = null): CreateCheckoutInput => ({
  ...base,
  mode: "subscription",
  priceId: PLANNER_PRICE,
  accountType: "planner",
  entitlementKey: "planner_pro",
  trial,
});

const coupleInput = (trial: CreateCheckoutInput["trial"] = null): CreateCheckoutInput => ({
  ...base,
  mode: "payment",
  priceId: COUPLE_PRICE,
  accountType: "couple",
  entitlementKey: "couple_access",
  trial,
});

/** No discount is ever chosen by the application: no coupon, promotion code or discounts parameter. */
function expectNoAppliedDiscount(params: Record<string, unknown>) {
  expect(params).not.toHaveProperty("discounts");
  expect(params).not.toHaveProperty("coupon");
  expect(params).not.toHaveProperty("promotion_code");
}

beforeEach(() => {
  stripeSdk.created.length = 0;
});

describe("Checkout Session parameters (the real gateway)", () => {
  it("planner, normal: subscription, configured price, promotion codes allowed, card collected, NO trial", async () => {
    expect(await gateway.createCheckoutSession(plannerInput())).toEqual({
      id: "cs_test_TESTONLYpromo",
      url: "https://checkout.stripe.com/c/pay/cs_test_TESTONLYpromo",
    });
    const [params] = stripeSdk.created;
    expect(params).toMatchObject({
      mode: "subscription",
      customer: "cus_TESTONLY1",
      line_items: [{ price: PLANNER_PRICE, quantity: 1 }],
      allow_promotion_codes: true,
      payment_method_collection: "always",
    });
    expect(params.subscription_data).toEqual({
      metadata: { lb_user_id: USER_ID, lb_account_type: "planner", lb_entitlement: "planner_pro" },
    });
    expect(params).not.toHaveProperty("payment_intent_data");
    expectNoAppliedDiscount(params);
  });

  it.each([
    ["planner_trial_7", 7],
    ["planner_trial_14", 14],
    ["planner_trial_30", 30],
  ] as const)("planner, %s: trial_period_days = %i, still collecting a card, promotion codes allowed", async (campaign, days) => {
    await gateway.createCheckoutSession(plannerInput({ campaign, days }));
    const [params] = stripeSdk.created;
    expect(params).toMatchObject({ mode: "subscription", allow_promotion_codes: true, payment_method_collection: "always" });
    expect(params.subscription_data).toEqual({
      metadata: { lb_user_id: USER_ID, lb_account_type: "planner", lb_entitlement: "planner_pro", lb_campaign: campaign },
      trial_period_days: days,
    });
    expect(params.metadata).toMatchObject({ lb_campaign: campaign });
    expectNoAppliedDiscount(params);
  });

  it("couple: one-time payment, configured price, promotion codes allowed, never a trial or subscription data", async () => {
    // Even a (never produced) trial on a payment input is dropped.
    await gateway.createCheckoutSession(coupleInput({ campaign: "planner_trial_30", days: 30 }));
    const [params] = stripeSdk.created;
    expect(params).toMatchObject({
      mode: "payment",
      line_items: [{ price: COUPLE_PRICE, quantity: 1 }],
      allow_promotion_codes: true,
      payment_intent_data: { metadata: { lb_user_id: USER_ID, lb_account_type: "couple", lb_entitlement: "couple_access" } },
    });
    expect(params).not.toHaveProperty("subscription_data");
    expect(params).not.toHaveProperty("payment_method_collection");
    expect(JSON.stringify(params)).not.toMatch(/trial|lb_campaign/);
    expectNoAppliedDiscount(params);
  });
});

describe("trial campaign rules", () => {
  const ALL = ["planner_trial_7", "planner_trial_14", "planner_trial_30"] as const;

  it("the allowlist is exactly 7, 14 and 30 days", () => {
    expect(PLANNER_TRIAL_CAMPAIGNS).toEqual({ planner_trial_7: 7, planner_trial_14: 14, planner_trial_30: 30 });
  });

  it.each([7, 14, 30, "7", "14", "30", "planner_trial_", "planner_trial_14 ", "toString", "__proto__", null, undefined, {}, []])(
    "%j is not a campaign",
    (value) => {
      expect(parsePlannerTrialCampaign(value)).toBeNull();
    },
  );

  it("only a planner, with an enabled key and no subscription history, gets a trial", () => {
    const ok = { accountType: "planner" as const, requested: "planner_trial_14", enabled: ALL, hasSubscriptionHistory: false };
    expect(resolvePlannerTrial(ok)).toEqual({ campaign: "planner_trial_14", days: 14 });
    expect(resolvePlannerTrial({ ...ok, accountType: "couple" })).toBeNull();
    expect(resolvePlannerTrial({ ...ok, enabled: [] })).toBeNull();
    expect(resolvePlannerTrial({ ...ok, hasSubscriptionHistory: true })).toBeNull();
    expect(resolvePlannerTrial({ ...ok, requested: 14 })).toBeNull();
  });

  it("the billing path echoes only a valid key", () => {
    expect(billingPathWithCampaign("planner_trial_30")).toBe("/app/billing?campaign=planner_trial_30");
    expect(billingPathWithCampaign("30")).toBe("/app/billing");
    expect(billingPathWithCampaign("planner_trial_30&x=1")).toBe("/app/billing");
  });
});

describe("trial entitlement policy (unchanged from BILLING-01)", () => {
  it("trialing grants planner_pro; active after the trial keeps it; past_due, unpaid and canceled deny", () => {
    expect(SUBSCRIPTION_GRANTING_STATUSES).toEqual(["active", "trialing"]);
    expect(subscriptionGrantsAccess("trialing")).toBe(true);
    expect(subscriptionGrantsAccess("active")).toBe(true);
    for (const status of ["past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused"] as const) {
      expect(subscriptionGrantsAccess(status), status).toBe(false);
    }
  });
});

describe("display prices (the frozen commercial model)", () => {
  it("planner $99 USD monthly, couple $149 USD once", () => {
    expect(PLAN_DISPLAY_PRICES).toEqual({ planner: { amount: "$99", currency: "USD" }, couple: { amount: "$149", currency: "USD" } });
    expect(displayPrice("planner")).toBe("$99 USD");
    expect(displayPrice("couple")).toBe("$149 USD");
    // The cadence shown matches the Checkout mode of each plan.
    expect(BILLING_PLANS.planner.mode).toBe("subscription");
    expect(BILLING_PLANS.couple.mode).toBe("payment");
  });
});
