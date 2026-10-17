import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The route's boundary with REAL Stripe signature verification
// (`Stripe.webhooks.constructEvent`, a fake test-only secret); the gateway
// and the store are replaced (the database rules have their own DB tests).
const gatewayFactory = vi.hoisted(() => ({ getStripeGateway: vi.fn() }));
vi.mock("@/lib/billing/stripe-gateway", () => gatewayFactory);
const storeFactory = vi.hoisted(() => ({ getBillingWebhookStore: vi.fn() }));
vi.mock("@/lib/billing/webhook-store", () => storeFactory);

import type { BillingWebhookStore } from "@/lib/billing/webhook-store";

import {
  USER_ID,
  checkoutSessionSnapshot,
  fakeGateway,
  subscriptionSnapshot,
  type FakeGateway,
} from "./fixtures/billing";
import {
  TEST_STRIPE_WEBHOOK_SECRET,
  WRONG_TEST_STRIPE_WEBHOOK_SECRET,
  signStripeEvent,
  stripeEventBody,
  type SignedStripeEvent,
} from "./fixtures/stripe-webhook";

const route = await import("@/app/api/stripe/webhook/route");
const { processStripeEvent } = await import("@/lib/billing/webhook");

// BILLING-01 (ADR-021 §6): POST /api/stripe/webhook and event processing.

const URL_BASE = "http://localhost:3100/api/stripe/webhook";

function post(signed: SignedStripeEvent | { body: string; headers: Record<string, string> }) {
  return route.POST(
    new NextRequest(URL_BASE, { method: "POST", headers: signed.headers, body: signed.body }),
  );
}

async function expectSafeEmpty(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(await response.text()).toBe("");
}

function store(result: Awaited<ReturnType<BillingWebhookStore["applySubscription"]>> = "applied") {
  return {
    applySubscription: vi.fn(async () => result),
    applyCheckoutPayment: vi.fn(async () => result),
  } satisfies BillingWebhookStore;
}

function subscriptionEvent(type = "customer.subscription.updated", id = "evt_TESTONLYsub1") {
  return signStripeEvent(
    stripeEventBody({ id, type, object: { id: "sub_TESTONLY1", object: "subscription", status: "active" } }),
  );
}

let gateway: FakeGateway;
let db: ReturnType<typeof store>;

beforeEach(() => {
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", TEST_STRIPE_WEBHOOK_SECRET);
  gateway = fakeGateway();
  gateway.subscriptions.set("sub_TESTONLY1", subscriptionSnapshot());
  gatewayFactory.getStripeGateway.mockReturnValue(gateway);
  db = store();
  storeFactory.getBillingWebhookStore.mockReturnValue(db);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("signature verification", () => {
  it("a valid signature is accepted and processed (200)", async () => {
    await expectSafeEmpty(await post(subscriptionEvent()), 200);
    expect(db.applySubscription).toHaveBeenCalledTimes(1);
  });

  it("an invalid signature is rejected (401) and nothing is read or written", async () => {
    const body = stripeEventBody({ id: "evt_TESTONLYforged", type: "customer.subscription.updated", object: { id: "sub_TESTONLY1" } });
    await expectSafeEmpty(await post(signStripeEvent(body, { secret: WRONG_TEST_STRIPE_WEBHOOK_SECRET })), 401);
    expect(gatewayFactory.getStripeGateway).not.toHaveBeenCalled();
    expect(db.applySubscription).not.toHaveBeenCalled();
  });

  it("an unsigned request is rejected (401)", async () => {
    const body = stripeEventBody({ id: "evt_TESTONLYunsigned", type: "checkout.session.completed", object: { id: "cs_test_1" } });
    await expectSafeEmpty(await post({ body, headers: { "content-type": "application/json" } }), 401);
    expect(db.applyCheckoutPayment).not.toHaveBeenCalled();
  });

  it("a body changed after signing is rejected (401): the RAW body is what's verified", async () => {
    const signed = subscriptionEvent();
    const tampered = signed.body.replace('"livemode":false', '"livemode":true');
    await expectSafeEmpty(await post({ body: tampered, headers: signed.headers }), 401);
  });

  it("an old signature (outside Stripe's 5-minute tolerance) is rejected", async () => {
    const body = stripeEventBody({ id: "evt_TESTONLYold", type: "customer.subscription.updated", object: { id: "sub_TESTONLY1" } });
    const old = signStripeEvent(body, { timestamp: Math.floor(Date.now() / 1000) - 10 * 60 });
    await expectSafeEmpty(await post(old), 401);
  });

  it("no configured secret → 503, before reading anything", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    await expectSafeEmpty(await post(subscriptionEvent()), 503);
    expect(db.applySubscription).not.toHaveBeenCalled();
  });

  it("an oversized body → 413", async () => {
    const body = stripeEventBody({
      id: "evt_TESTONLYbig",
      type: "customer.subscription.updated",
      object: { id: "sub_TESTONLY1", padding: "x".repeat(300 * 1024) },
    });
    await expectSafeEmpty(await post(signStripeEvent(body)), 413);
  });

  it("only POST exists", () => {
    expect(Object.keys(route).filter((name) => /^[A-Z]+$/.test(name))).toEqual(["POST"]);
  });
});

describe("processing", () => {
  it("an unsupported event type is acknowledged and ignored", async () => {
    const body = stripeEventBody({ id: "evt_TESTONLYinvoice", type: "invoice.paid", object: { id: "in_TESTONLY1" } });
    await expectSafeEmpty(await post(signStripeEvent(body)), 200);
    expect(db.applySubscription).not.toHaveBeenCalled();
    expect(db.applyCheckoutPayment).not.toHaveBeenCalled();
  });

  it("applies the subscription state RETRIEVED from Stripe, not the event payload", async () => {
    gateway.subscriptions.set("sub_TESTONLY1", subscriptionSnapshot({ status: "canceled", cancelAtPeriodEnd: false }));
    // The (stale) payload still says active.
    await expectSafeEmpty(await post(subscriptionEvent()), 200);
    expect(db.applySubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "evt_TESTONLYsub1",
        eventType: "customer.subscription.updated",
        subscriptionId: "sub_TESTONLY1",
        customerId: "cus_TESTONLY1",
        metadataUserId: USER_ID,
        status: "canceled",
        currentPeriodEnd: new Date(1_900_000_000 * 1000).toISOString(),
        observedAt: expect.any(String),
      }),
    );
  });

  it("a subscription without our metadata is never applied (not created by our Checkout)", async () => {
    gateway.subscriptions.set(
      "sub_TESTONLY1",
      subscriptionSnapshot({ metadata: { userId: null, entitlementKey: null } }),
    );
    await expectSafeEmpty(await post(subscriptionEvent()), 200);
    expect(db.applySubscription).not.toHaveBeenCalled();
  });

  it("an unknown Stripe status is never applied (never granted)", async () => {
    gateway.subscriptions.set("sub_TESTONLY1", subscriptionSnapshot({ status: null }));
    await expectSafeEmpty(await post(subscriptionEvent()), 200);
    expect(db.applySubscription).not.toHaveBeenCalled();
  });

  it("Stripe unreachable → 500 so Stripe retries; nothing written", async () => {
    gateway.subscriptions.set("sub_TESTONLY1", null);
    await expectSafeEmpty(await post(subscriptionEvent()), 500);
    expect(db.applySubscription).not.toHaveBeenCalled();
  });

  it("a database failure → 500 (Stripe redelivers; the replay is deduped by event id)", async () => {
    db = store("error");
    storeFactory.getBillingWebhookStore.mockReturnValue(db);
    await expectSafeEmpty(await post(subscriptionEvent()), 500);
  });

  it.each(["duplicate", "stale", "no_change", "ignored"] as const)("a %s outcome is acknowledged (200)", async (outcome) => {
    db = store(outcome);
    storeFactory.getBillingWebhookStore.mockReturnValue(db);
    await expectSafeEmpty(await post(subscriptionEvent()), 200);
  });

  it("BILLING-02: a trial Checkout (nothing paid yet) applies the TRIALING subscription Stripe returns", async () => {
    gateway.subscriptions.set("sub_TESTONLY1", subscriptionSnapshot({ status: "trialing" }));
    gateway.checkoutSessions.set(
      "cs_test_TESTONLYtrial",
      checkoutSessionSnapshot({
        id: "cs_test_TESTONLYtrial",
        mode: "subscription",
        paymentStatus: "no_payment_required",
        amountTotal: 0,
        subscriptionId: "sub_TESTONLY1",
        paymentIntentId: null,
        metadata: { userId: USER_ID, entitlementKey: "planner_pro" },
      }),
    );
    const body = stripeEventBody({ id: "evt_TESTONLYtrial", type: "checkout.session.completed", object: { id: "cs_test_TESTONLYtrial" } });
    await expectSafeEmpty(await post(signStripeEvent(body)), 200);
    expect(db.applySubscription).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: "sub_TESTONLY1", status: "trialing" }));
    expect(db.applyCheckoutPayment).not.toHaveBeenCalled();
  });

  it("checkout.session.completed in subscription mode applies that subscription", async () => {
    gateway.checkoutSessions.set(
      "cs_test_TESTONLYsub",
      checkoutSessionSnapshot({
        id: "cs_test_TESTONLYsub",
        mode: "subscription",
        subscriptionId: "sub_TESTONLY1",
        paymentIntentId: null,
        metadata: { userId: USER_ID, entitlementKey: "planner_pro" },
      }),
    );
    const body = stripeEventBody({ id: "evt_TESTONLYcs1", type: "checkout.session.completed", object: { id: "cs_test_TESTONLYsub" } });
    await expectSafeEmpty(await post(signStripeEvent(body)), 200);
    expect(db.applySubscription).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "checkout.session.completed", subscriptionId: "sub_TESTONLY1", status: "active" }),
    );
    expect(db.applyCheckoutPayment).not.toHaveBeenCalled();
  });
});

describe("one-time payment (couple)", () => {
  function sessionEvent(type: string, id = "evt_TESTONLYpay1") {
    return signStripeEvent(stripeEventBody({ id, type, object: { id: "cs_test_TESTONLY1", object: "checkout.session" } }));
  }

  it("completed + paid → applied as paid", async () => {
    gateway.checkoutSessions.set("cs_test_TESTONLY1", checkoutSessionSnapshot());
    await expectSafeEmpty(await post(sessionEvent("checkout.session.completed")), 200);
    expect(db.applyCheckoutPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutSessionId: "cs_test_TESTONLY1",
        customerId: "cus_TESTONLY1",
        paymentIntentId: "pi_TESTONLY1",
        metadataUserId: USER_ID,
        paymentStatus: "paid",
      }),
    );
  });

  it("completed but unpaid (delayed method) → pending, never paid", async () => {
    gateway.checkoutSessions.set("cs_test_TESTONLY1", checkoutSessionSnapshot({ paymentStatus: "unpaid" }));
    await post(sessionEvent("checkout.session.completed"));
    expect(db.applyCheckoutPayment).toHaveBeenCalledWith(expect.objectContaining({ paymentStatus: "pending" }));
  });

  it("async_payment_succeeded → paid; async_payment_failed → failed", async () => {
    gateway.checkoutSessions.set("cs_test_TESTONLY1", checkoutSessionSnapshot());
    await post(sessionEvent("checkout.session.async_payment_succeeded", "evt_TESTONLYasync1"));
    expect(db.applyCheckoutPayment).toHaveBeenLastCalledWith(expect.objectContaining({ paymentStatus: "paid" }));

    gateway.checkoutSessions.set("cs_test_TESTONLY1", checkoutSessionSnapshot({ paymentStatus: "unpaid" }));
    await post(sessionEvent("checkout.session.async_payment_failed", "evt_TESTONLYasync2"));
    expect(db.applyCheckoutPayment).toHaveBeenLastCalledWith(expect.objectContaining({ paymentStatus: "failed" }));
  });

  it("BILLING-02: a 100%-off Checkout (complete, nothing to pay, $0, NO PaymentIntent) → applied as paid", async () => {
    gateway.checkoutSessions.set(
      "cs_test_TESTONLY1",
      checkoutSessionSnapshot({ paymentStatus: "no_payment_required", amountTotal: 0, paymentIntentId: null }),
    );
    await expectSafeEmpty(await post(sessionEvent("checkout.session.completed")), 200);
    expect(db.applyCheckoutPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutSessionId: "cs_test_TESTONLY1",
        customerId: "cus_TESTONLY1",
        metadataUserId: USER_ID,
        paymentIntentId: null,
        paymentStatus: "paid",
      }),
    );
  });

  it.each([
    ["a non-zero total", 14_900],
    ["an unknown total", null],
  ])("no_payment_required with %s is not a confirmed payment", async (_label, amountTotal) => {
    gateway.checkoutSessions.set(
      "cs_test_TESTONLY1",
      checkoutSessionSnapshot({ paymentStatus: "no_payment_required", amountTotal, paymentIntentId: null }),
    );
    await post(sessionEvent("checkout.session.completed"));
    expect(db.applyCheckoutPayment).toHaveBeenCalledWith(expect.objectContaining({ paymentStatus: "pending" }));
  });

  it("BILLING-02: a $0 session that isn't complete is still ignored", async () => {
    gateway.checkoutSessions.set(
      "cs_test_TESTONLY1",
      checkoutSessionSnapshot({ status: "open", paymentStatus: "no_payment_required", amountTotal: 0, paymentIntentId: null }),
    );
    await expectSafeEmpty(await post(sessionEvent("checkout.session.completed")), 200);
    expect(db.applyCheckoutPayment).not.toHaveBeenCalled();
  });

  it("an open/expired session or one without our metadata is ignored", async () => {
    gateway.checkoutSessions.set("cs_test_TESTONLY1", checkoutSessionSnapshot({ status: "expired" }));
    await expectSafeEmpty(await post(sessionEvent("checkout.session.completed", "evt_TESTONLYx1")), 200);
    gateway.checkoutSessions.set(
      "cs_test_TESTONLY1",
      checkoutSessionSnapshot({ metadata: { userId: USER_ID, entitlementKey: "planner_pro" } }),
    );
    await expectSafeEmpty(await post(sessionEvent("checkout.session.completed", "evt_TESTONLYx2")), 200);
    expect(db.applyCheckoutPayment).not.toHaveBeenCalled();
  });
});

describe("processStripeEvent observation time", () => {
  it("stamps the observation AFTER Stripe answered (the database orders by it)", async () => {
    const order: string[] = [];
    const clockGateway = fakeGateway({
      retrieveSubscription: async () => {
        order.push("retrieve");
        return subscriptionSnapshot();
      },
    });
    const recording = store();
    await processStripeEvent(
      { id: "evt_TESTONLYclock", type: "customer.subscription.created", livemode: false, created: 1, objectId: "sub_TESTONLY1" },
      {
        gateway: clockGateway,
        store: recording,
        now: () => {
          order.push("now");
          return new Date("2026-10-16T12:00:00.000Z");
        },
      },
    );
    expect(order).toEqual(["retrieve", "now"]);
    expect(recording.applySubscription).toHaveBeenCalledWith(
      expect.objectContaining({ observedAt: "2026-10-16T12:00:00.000Z", createdAt: "1970-01-01T00:00:01.000Z" }),
    );
  });
});
