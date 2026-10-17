import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const navigation = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  }),
}));
vi.mock("next/navigation", () => navigation);
const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/lib/auth/session", () => auth);
const accountService = vi.hoisted(() => ({ getAccountType: vi.fn() }));
vi.mock("@/lib/accounts/service", () => accountService);
const server = vi.hoisted(() => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => server);
const runtime = vi.hoisted(() => ({ getBillingRuntime: vi.fn(), isBillingAvailable: vi.fn() }));
vi.mock("@/lib/billing/runtime", () => runtime);

import type { BillingCustomerRecorder } from "@/lib/billing/customer-recorder";
import type { Database } from "@/lib/supabase/database.types";

import {
  APP_ORIGIN,
  COUPLE_PRICE,
  OTHER_USER_ID,
  PLANNER_PRICE,
  USER_ID,
  fakeGateway,
  fakeSupabase,
  type FakeGateway,
} from "./fixtures/billing";

const { customerIdempotencyKey, ensureBillingCustomer, openBillingPortal, startBillingCheckout } = await import(
  "@/lib/billing/service"
);
const { openPortalAction, startCheckoutAction } = await import("@/app/app/billing/actions");

// BILLING-01 (ADR-021): starting Checkout and opening the Customer Portal.
// The service is exercised with a fake Stripe gateway, a fake privileged
// recorder and a fake RLS client; the actions with the REAL account-type
// guard (`requireAccountType`) over mocked session reads.

type Client = SupabaseClient<Database>;

function recorder(store = new Map<string, string>()): BillingCustomerRecorder & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async record({ userId, stripeCustomerId }) {
      calls.push({ userId, stripeCustomerId });
      // Like record_billing_customer: the first mapping wins and is returned.
      if (!store.has(userId)) store.set(userId, stripeCustomerId);
      return store.get(userId) ?? null;
    },
  };
}

function runtimeWith(gateway: FakeGateway, rec = recorder()) {
  return {
    config: { appOrigin: APP_ORIGIN, prices: { planner: PLANNER_PRICE, couple: COUPLE_PRICE } },
    gateway,
    recorder: rec,
  };
}

function caller(accountType: "planner" | "couple", tables: Parameters<typeof fakeSupabase>[0] = {}) {
  const { client, reads } = fakeSupabase(tables);
  return { caller: { supabase: client as unknown as Client, userId: USER_ID, accountType }, reads };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("planner checkout", () => {
  it("creates a SUBSCRIPTION session with the configured planner price and canonical URLs", async () => {
    const gateway = fakeGateway();
    const { caller: planner } = caller("planner");
    const result = await startBillingCheckout(planner, runtimeWith(gateway));
    expect(result).toEqual({ ok: true, url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//) });
    expect(gateway.sessions).toEqual([
      {
        mode: "subscription",
        customerId: "cus_TESTONLY1",
        priceId: PLANNER_PRICE,
        userId: USER_ID,
        accountType: "planner",
        entitlementKey: "planner_pro",
        successUrl: `${APP_ORIGIN}/app/billing/success`,
        cancelUrl: `${APP_ORIGIN}/app/billing/cancel`,
      },
    ]);
  });

  it("refuses when the entitlement is already active (no Stripe call)", async () => {
    const gateway = fakeGateway();
    const { caller: planner } = caller("planner", {
      billing_entitlements: [{ user_id: USER_ID, entitlement_key: "planner_pro", status: "active" }],
    });
    expect(await startBillingCheckout(planner, runtimeWith(gateway))).toEqual({ ok: false, reason: "already_active" });
    expect(gateway.customers).toEqual([]);
    expect(gateway.sessions).toEqual([]);
  });

  it.each(["past_due", "unpaid", "paused", "incomplete"])(
    "a live %s subscription sends the planner to the portal instead of a second subscription",
    async (status) => {
      const gateway = fakeGateway();
      const { caller: planner } = caller("planner", { billing_subscriptions: [{ user_id: USER_ID, status }] });
      expect(await startBillingCheckout(planner, runtimeWith(gateway))).toEqual({ ok: false, reason: "manage_existing" });
      expect(gateway.sessions).toEqual([]);
    },
  );

  it.each(["canceled", "incomplete_expired"])("only %s (terminal) subscriptions allow subscribing again", async (status) => {
    const gateway = fakeGateway();
    const { caller: planner } = caller("planner", { billing_subscriptions: [{ user_id: USER_ID, status }] });
    expect((await startBillingCheckout(planner, runtimeWith(gateway))).ok).toBe(true);
  });
});

describe("couple checkout", () => {
  it("creates a one-time PAYMENT session with the configured couple price", async () => {
    const gateway = fakeGateway();
    const { caller: couple } = caller("couple");
    expect((await startBillingCheckout(couple, runtimeWith(gateway))).ok).toBe(true);
    expect(gateway.sessions).toHaveLength(1);
    expect(gateway.sessions[0]).toMatchObject({
      mode: "payment",
      priceId: COUPLE_PRICE,
      accountType: "couple",
      entitlementKey: "couple_access",
    });
  });

  it("an already active couple is not asked to pay again", async () => {
    const gateway = fakeGateway();
    const { caller: couple } = caller("couple", {
      billing_entitlements: [{ user_id: USER_ID, entitlement_key: "couple_access", status: "active" }],
    });
    expect(await startBillingCheckout(couple, runtimeWith(gateway))).toEqual({ ok: false, reason: "already_active" });
    expect(gateway.sessions).toEqual([]);
  });
});

describe("configuration and failures", () => {
  it("not configured → not_available, nothing called", async () => {
    const { caller: planner, reads } = caller("planner");
    expect(await startBillingCheckout(planner, null)).toEqual({ ok: false, reason: "not_available" });
    expect(reads).toEqual([]);
  });

  it("a failed entitlement read is never read as 'not paid'", async () => {
    const gateway = fakeGateway();
    const { caller: planner } = caller("planner", { billing_entitlements: "error" });
    expect(await startBillingCheckout(planner, runtimeWith(gateway))).toEqual({ ok: false, reason: "failed" });
    expect(gateway.sessions).toEqual([]);
  });

  it("a Stripe failure creating the session is a uniform failure", async () => {
    const gateway = fakeGateway({ createCheckoutSession: async () => null });
    const { caller: planner } = caller("planner");
    expect(await startBillingCheckout(planner, runtimeWith(gateway))).toEqual({ ok: false, reason: "failed" });
  });
});

describe("Stripe customer mapping", () => {
  it("reuses the user's existing customer (no new customer, no mapping write)", async () => {
    const gateway = fakeGateway();
    const rec = recorder();
    const { caller: planner, reads } = caller("planner", {
      billing_customers: [{ user_id: USER_ID, stripe_customer_id: "cus_EXISTING1" }],
    });
    expect(await ensureBillingCustomer(planner, runtimeWith(gateway, rec))).toBe("cus_EXISTING1");
    expect(gateway.customers).toEqual([]);
    expect(rec.calls).toEqual([]);
    // The read is scoped to the caller's own row.
    expect(reads.find((r) => r.table === "billing_customers")?.filters).toContainEqual(["user_id", USER_ID]);
  });

  it("creates at most one customer: concurrent starts share the idempotency key and the stored mapping", async () => {
    const gateway = fakeGateway();
    const store = new Map<string, string>();
    const runtimeA = runtimeWith(gateway, recorder(store));
    const runtimeB = runtimeWith(gateway, recorder(store));
    // Both find no mapping (they read before either writes).
    const [a, b] = await Promise.all([
      ensureBillingCustomer(caller("planner").caller, runtimeA),
      ensureBillingCustomer(caller("planner").caller, runtimeB),
    ]);
    expect(gateway.customers.map((c) => c.idempotencyKey)).toEqual([
      customerIdempotencyKey(USER_ID),
      customerIdempotencyKey(USER_ID),
    ]);
    expect(a).toBe("cus_TESTONLY1");
    expect(b).toBe("cus_TESTONLY1");
  });

  it("uses the customer the database KEPT when Stripe returned a different one", async () => {
    const gateway = fakeGateway({ createCustomer: async () => ({ id: "cus_LATECOMER" }) });
    const store = new Map([[USER_ID, "cus_FIRSTWINS"]]);
    expect(await ensureBillingCustomer(caller("planner").caller, runtimeWith(gateway, recorder(store)))).toBe(
      "cus_FIRSTWINS",
    );
  });

  it("customer metadata carries ids and closed values only", async () => {
    const gateway = fakeGateway();
    await ensureBillingCustomer(caller("couple").caller, runtimeWith(gateway));
    expect(gateway.customers).toEqual([
      { userId: USER_ID, accountType: "couple", idempotencyKey: `lb-billing-customer:${USER_ID}` },
    ]);
  });

  it("a failed mapping write fails the start before any Checkout Session", async () => {
    const gateway = fakeGateway();
    const failing: BillingCustomerRecorder = { record: async () => null };
    expect(await startBillingCheckout(caller("planner").caller, runtimeWith(gateway, failing as never))).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(gateway.sessions).toEqual([]);
  });
});

describe("Customer Portal", () => {
  it("opens the portal for the caller's OWN customer with the canonical return URL", async () => {
    const gateway = fakeGateway();
    const { caller: planner } = caller("planner", {
      billing_customers: [
        { user_id: OTHER_USER_ID, stripe_customer_id: "cus_SOMEONEELSE" },
        { user_id: USER_ID, stripe_customer_id: "cus_MINE" },
      ],
    });
    expect(await openBillingPortal(planner, runtimeWith(gateway))).toEqual({ ok: true, url: expect.any(String) });
    expect(gateway.portals).toEqual([{ customerId: "cus_MINE", returnUrl: `${APP_ORIGIN}/app/billing` }]);
  });

  it("no customer yet → no_customer; couples are never offered the portal", async () => {
    const gateway = fakeGateway();
    expect(await openBillingPortal(caller("planner").caller, runtimeWith(gateway))).toEqual({
      ok: false,
      reason: "no_customer",
    });
    const { caller: couple } = caller("couple", { billing_customers: [{ user_id: USER_ID, stripe_customer_id: "cus_MINE" }] });
    expect(await openBillingPortal(couple, runtimeWith(gateway))).toEqual({ ok: false, reason: "failed" });
    expect(gateway.portals).toEqual([]);
  });
});

describe("billing actions (real account-type guard)", () => {
  function signedIn(accountType: "planner" | "couple" | null, tables: Parameters<typeof fakeSupabase>[0] = {}) {
    auth.requireUser.mockResolvedValue({ id: USER_ID, email: "persona@example.test" });
    accountService.getAccountType.mockResolvedValue(accountType);
    server.createSupabaseServerClient.mockResolvedValue(fakeSupabase(tables).client);
    const gateway = fakeGateway();
    runtime.getBillingRuntime.mockReturnValue(runtimeWith(gateway));
    return gateway;
  }

  it("an untyped account can't start Checkout: it is sent to the account-type choice", async () => {
    const gateway = signedIn(null);
    await expect(startCheckoutAction()).rejects.toThrow(
      "NEXT_REDIRECT /onboarding/account-type?next=%2Fapp%2Fbilling",
    );
    expect(gateway.customers).toEqual([]);
    expect(gateway.sessions).toEqual([]);
  });

  it("an untyped account can't open the portal either", async () => {
    const gateway = signedIn(null);
    await expect(openPortalAction()).rejects.toThrow("NEXT_REDIRECT /onboarding/account-type");
    expect(gateway.portals).toEqual([]);
  });

  it("ignores everything the browser sends: price, amount, mode, customer, user, entitlement", async () => {
    const gateway = signedIn("couple");
    const forged = new FormData();
    for (const [name, value] of Object.entries({
      price: "price_FORGEDcheap",
      priceId: "price_FORGEDcheap",
      amount: "1",
      currency: "usd",
      mode: "subscription",
      customer: "cus_SOMEONEELSE",
      userId: OTHER_USER_ID,
      entitlement: "planner_pro",
    })) {
      forged.set(name, value);
    }
    // The action takes no input at all; a forged form changes nothing.
    await expect((startCheckoutAction as (form: FormData) => Promise<void>)(forged)).rejects.toThrow(
      /^NEXT_REDIRECT https:\/\/checkout\.stripe\.com\//,
    );
    expect(gateway.sessions).toEqual([
      expect.objectContaining({
        mode: "payment",
        priceId: COUPLE_PRICE,
        userId: USER_ID,
        customerId: "cus_TESTONLY1",
        entitlementKey: "couple_access",
      }),
    ]);
  });

  it("a refused start returns to the billing page with a closed error", async () => {
    signedIn("planner", { billing_entitlements: [{ user_id: USER_ID, entitlement_key: "planner_pro", status: "active" }] });
    await expect(startCheckoutAction()).rejects.toThrow("NEXT_REDIRECT /app/billing?error=already_active");
  });

  it("not configured → back to billing with not_available", async () => {
    signedIn("planner");
    runtime.getBillingRuntime.mockReturnValue(null);
    await expect(startCheckoutAction()).rejects.toThrow("NEXT_REDIRECT /app/billing?error=not_available");
  });
});
