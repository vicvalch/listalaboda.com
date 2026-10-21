import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  }),
  useRouter: () => ({ refresh: () => undefined }),
}));
const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/lib/auth/session", () => auth);
const accountService = vi.hoisted(() => ({ getAccountType: vi.fn() }));
vi.mock("@/lib/accounts/service", () => accountService);
const server = vi.hoisted(() => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => server);
vi.mock("@/lib/billing/runtime", () => ({
  getBillingRuntime: vi.fn(),
  isBillingAvailable: vi.fn(() => true),
  getEnabledTrialCampaigns: vi.fn((): readonly string[] => []),
}));
// The webhook store's one RPC, captured (the database rules have their own DB tests).
const rpc = vi.hoisted(() => vi.fn(async () => ({ data: "applied", error: null })));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({ rpc })) }));

import type { BillingSubscriptionStatus } from "@/lib/billing/plans";
import { getMessages } from "@/lib/i18n";

import { USER_ID, fakeGateway, fakeSupabase, subscriptionSnapshot } from "./fixtures/billing";

const { plannerBillingView, plannerRenewal } = await import("@/lib/billing/presentation");
const { toSubscriptionSnapshot } = await import("@/lib/billing/stripe-gateway");
const { processStripeEvent } = await import("@/lib/billing/webhook");
const { createBillingWebhookStore } = await import("@/lib/billing/webhook-store");
const { default: BillingPage } = await import("@/app/app/billing/page");

// QA-03a: Stripe schedules a cancellation with cancel_at_period_end OR with
// cancel_at (a timestamp before, at or after the current period's end; after
// it, the subscription renews first). The page must never say "Se renueva"
// alone when a cancellation is scheduled, and never "no se renovará" when one
// more renewal comes first. Access is unchanged: the entitlement decides.

const { billing } = getMessages();
const PERIOD_END = "2027-01-15T12:00:00.000Z";
const BEFORE = "2027-01-05T12:00:00.000Z";
const AFTER = "2027-03-15T12:00:00.000Z";
const unix = (iso: string) => Date.parse(iso) / 1000;

const sub = (
  status: BillingSubscriptionStatus,
  extra: Partial<{ currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; cancelAt: string | null }> = {},
) => ({
  status,
  currentPeriodEnd: extra.currentPeriodEnd === undefined ? PERIOD_END : extra.currentPeriodEnd,
  cancelAtPeriodEnd: extra.cancelAtPeriodEnd ?? false,
  cancelAt: extra.cancelAt ?? null,
});

describe("plannerRenewal", () => {
  it("nothing scheduled: renews at the period's end", () => {
    expect(plannerRenewal(sub("active"))).toEqual({ kind: "renews", on: PERIOD_END });
  });

  it("cancel_at_period_end: ends at the period's end (also when Stripe mirrors it in cancel_at)", () => {
    expect(plannerRenewal(sub("active", { cancelAtPeriodEnd: true }))).toEqual({ kind: "ends", on: PERIOD_END });
    expect(plannerRenewal(sub("active", { cancelAtPeriodEnd: true, cancelAt: PERIOD_END }))).toEqual({
      kind: "ends",
      on: PERIOD_END,
    });
  });

  it("cancel_at before or exactly at the period's end: ends then, no renewal", () => {
    expect(plannerRenewal(sub("active", { cancelAt: BEFORE }))).toEqual({ kind: "ends", on: BEFORE });
    expect(plannerRenewal(sub("active", { cancelAt: PERIOD_END }))).toEqual({ kind: "ends", on: PERIOD_END });
  });

  it("cancel_at after the period's end: one more renewal first, then it ends (never 'no se renovará')", () => {
    expect(plannerRenewal(sub("active", { cancelAt: AFTER }))).toEqual({
      kind: "renews_then_ends",
      renewsOn: PERIOD_END,
      endsOn: AFTER,
    });
  });

  it("missing dates: cancel_at alone still ends; nothing known says nothing", () => {
    expect(plannerRenewal(sub("active", { currentPeriodEnd: null, cancelAt: AFTER }))).toEqual({ kind: "ends", on: AFTER });
    expect(plannerRenewal(sub("active", { currentPeriodEnd: null }))).toBeNull();
    expect(plannerRenewal(sub("active", { currentPeriodEnd: null, cancelAtPeriodEnd: true }))).toBeNull();
  });
});

describe("plannerBillingView with a scheduled cancellation", () => {
  const view = (entitlement: "active" | "inactive", subscriptions: ReturnType<typeof sub>[]) =>
    plannerBillingView({ kind: "planner", entitlement, subscriptions }, true);

  it("access stays active until Stripe ends it: a scheduled cancellation changes only the words", () => {
    expect(view("active", [sub("active", { cancelAt: BEFORE })])).toEqual({
      kind: "planner",
      state: "active",
      renewal: { kind: "ends", on: BEFORE },
      action: "manage",
      everSubscribed: true,
    });
    expect(view("active", [sub("trialing", { cancelAt: BEFORE })])).toMatchObject({
      state: "trialing",
      renewal: { kind: "ends", on: BEFORE },
    });
  });

  it("a row alone never grants: inactive entitlement with a scheduled active row is not active", () => {
    expect(view("inactive", [sub("active", { cancelAt: AFTER })]).state).not.toBe("active");
  });

  it("terminal or problem states never show a scheduled date", () => {
    expect(view("inactive", [sub("canceled", { cancelAt: BEFORE, cancelAtPeriodEnd: true })])).toMatchObject({
      state: "none",
      renewal: null,
    });
    expect(view("inactive", [sub("incomplete_expired", { cancelAt: BEFORE })])).toMatchObject({ renewal: null });
    expect(view("inactive", [sub("past_due", { cancelAt: AFTER })])).toMatchObject({ state: "problem", renewal: null });
  });

  it("the granting subscription is the one described, not an older canceled one", () => {
    expect(
      view("active", [sub("canceled", { cancelAt: BEFORE }), sub("active", { cancelAt: AFTER })]).renewal,
    ).toEqual({ kind: "renews_then_ends", renewsOn: PERIOD_END, endsOn: AFTER });
  });
});

describe("Stripe → snapshot → store", () => {
  it("reads cancel_at as Unix seconds; absent, null or junk is null", () => {
    const base = { id: "sub_TESTONLY1", customer: "cus_TESTONLY1", status: "active", items: { data: [] }, metadata: {} };
    expect(toSubscriptionSnapshot({ ...base, cancel_at: 1_900_000_000 })?.cancelAt).toBe(1_900_000_000);
    expect(toSubscriptionSnapshot(base)?.cancelAt).toBeNull();
    expect(toSubscriptionSnapshot({ ...base, cancel_at: null })?.cancelAt).toBeNull();
    expect(toSubscriptionSnapshot({ ...base, cancel_at: "2027-01-01" })?.cancelAt).toBeNull();
    expect(toSubscriptionSnapshot({ ...base, cancel_at: Number.NaN })?.cancelAt).toBeNull();
  });

  it("the webhook passes the RETRIEVED cancel_at to the store as ISO, or null", async () => {
    const store = { applySubscription: vi.fn(async () => "applied" as const), applyCheckoutPayment: vi.fn() };
    const event = { id: "evt_TESTONLYcancel", type: "customer.subscription.updated", livemode: false, created: 1, objectId: "sub_TESTONLY1" };
    for (const [cancelAt, expected] of [
      [unix(AFTER), AFTER],
      [null, null],
    ] as const) {
      const gateway = fakeGateway();
      gateway.subscriptions.set("sub_TESTONLY1", subscriptionSnapshot({ cancelAt }));
      await processStripeEvent(event, { gateway, store, now: () => new Date() });
      expect(store.applySubscription).toHaveBeenLastCalledWith(expect.objectContaining({ cancelAt: expected }));
    }
  });

  it("the store always sends cancel_at: the date, or 'infinity' for none (never omitted, so a removed schedule clears)", async () => {
    const store = createBillingWebhookStore({ supabaseUrl: "http://127.0.0.1:54321", serviceRoleKey: "test-only" });
    const input = {
      eventId: "evt_TESTONLYcancel",
      eventType: "customer.subscription.updated",
      livemode: false,
      createdAt: "2026-10-21T00:00:00.000Z",
      customerId: "cus_TESTONLY1",
      subscriptionId: "sub_TESTONLY1",
      priceId: null,
      metadataUserId: USER_ID,
      status: "active" as const,
      currentPeriodEnd: PERIOD_END,
      cancelAtPeriodEnd: false,
      observedAt: "2026-10-21T00:00:01.000Z",
    };
    await store.applySubscription({ ...input, cancelAt: AFTER });
    expect(rpc).toHaveBeenLastCalledWith("apply_stripe_subscription_event", expect.objectContaining({ cancel_at: AFTER }));
    await store.applySubscription({ ...input, cancelAt: null });
    expect(rpc).toHaveBeenLastCalledWith("apply_stripe_subscription_event", expect.objectContaining({ cancel_at: "infinity" }));
  });
});

describe("billing page wording", () => {
  beforeEach(() => vi.clearAllMocks());

  async function page(row: Record<string, unknown>) {
    auth.requireUser.mockResolvedValue({ id: USER_ID, email: "persona@example.test" });
    accountService.getAccountType.mockResolvedValue("planner");
    server.createSupabaseServerClient.mockResolvedValue(
      fakeSupabase({
        billing_entitlements: [{ user_id: USER_ID, entitlement_key: "planner_pro", status: "active" }],
        billing_subscriptions: [{ user_id: USER_ID, status: "active", current_period_end: PERIOD_END, cancel_at_period_end: false, cancel_at: null, ...row }],
      }).client,
    );
    return renderToStaticMarkup(await BillingPage({ params: Promise.resolve({}), searchParams: Promise.resolve({}) } as never));
  }
  const renews = (date: string) => billing.planner.renewsOn.replace("{date}", date);
  const ends = (date: string) => billing.planner.endsOn.replace("{date}", date);

  it("nothing scheduled: 'Se renueva el …'", async () => {
    expect(await page({})).toContain(renews("15 de enero de 2027"));
  });

  it("cancel_at_period_end: 'Termina el … y no se renovará', never 'Se renueva'", async () => {
    const html = await page({ cancel_at_period_end: true });
    expect(html).toContain(ends("15 de enero de 2027"));
    expect(html).not.toContain("Se renueva");
  });

  it("cancel_at before the period's end: ends on cancel_at, never 'Se renueva'", async () => {
    const html = await page({ cancel_at: BEFORE });
    expect(html).toContain(ends("5 de enero de 2027"));
    expect(html).not.toContain("Se renueva");
    expect(html).toContain(billing.planner.manage);
  });

  it("cancel_at after the period's end: the approved two-date sentence, never 'no se renovará'", async () => {
    const html = await page({ cancel_at: AFTER });
    expect(html).toContain("Se renueva el 15 de enero de 2027. Tu suscripción termina el 15 de marzo de 2027.");
    expect(html).not.toContain("no se renovará");
  });
});
