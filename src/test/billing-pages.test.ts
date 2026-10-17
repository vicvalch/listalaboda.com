import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const navigation = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  }),
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock("next/navigation", () => navigation);
const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/lib/auth/session", () => auth);
const accountService = vi.hoisted(() => ({ getAccountType: vi.fn() }));
vi.mock("@/lib/accounts/service", () => accountService);
const server = vi.hoisted(() => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => server);
const runtime = vi.hoisted(() => ({ getBillingRuntime: vi.fn(), isBillingAvailable: vi.fn(() => true) }));
vi.mock("@/lib/billing/runtime", () => runtime);

import { getMessages } from "@/lib/i18n";

import { USER_ID, fakeSupabase } from "./fixtures/billing";

const { default: BillingPage } = await import("@/app/app/billing/page");
const { default: BillingSuccessPage } = await import("@/app/app/billing/success/page");
const { default: BillingCancelPage } = await import("@/app/app/billing/cancel/page");

// BILLING-01 (ADR-021 §10): the billing pages render the DATABASE state only.

const { billing } = getMessages();

function signedIn(accountType: "planner" | "couple" | null, tables: Parameters<typeof fakeSupabase>[0] = {}) {
  auth.requireUser.mockResolvedValue({ id: USER_ID, email: "persona@example.test" });
  accountService.getAccountType.mockResolvedValue(accountType);
  const fake = fakeSupabase(tables);
  server.createSupabaseServerClient.mockResolvedValue(fake.client);
  return fake;
}

const params = (query: Record<string, string> = {}) => ({
  params: Promise.resolve({}),
  searchParams: Promise.resolve(query),
});

beforeEach(() => {
  vi.clearAllMocks();
  runtime.isBillingAvailable.mockReturnValue(true);
});

describe("success page", () => {
  it("reaching the success URL grants nothing: without a webhook-activated entitlement it only says 'confirming'", async () => {
    const fake = signedIn("couple");
    const html = renderToStaticMarkup(await BillingSuccessPage());
    expect(html).toContain(billing.success.pendingBody);
    expect(html).not.toContain(billing.success.coupleConfirmed);
    // Read-only: only selects on the user's own rows; no RPC, no write path exists on this client.
    expect(fake.reads.map((r) => r.table).sort()).toEqual(["billing_entitlements", "billing_purchases"]);
    expect(fake.reads.every((r) => r.filters.some(([c, v]) => c === "user_id" && v === USER_ID))).toBe(true);
  });

  it("shows confirmed access once the database says so", async () => {
    signedIn("planner", {
      billing_entitlements: [{ user_id: USER_ID, entitlement_key: "planner_pro", status: "active" }],
      billing_subscriptions: [{ user_id: USER_ID, status: "active", current_period_end: null, cancel_at_period_end: false }],
    });
    const html = renderToStaticMarkup(await BillingSuccessPage());
    expect(html).toContain(billing.success.plannerConfirmed);
    expect(html).not.toContain(billing.success.pendingBody);
  });

  it("an untyped account is sent to the account-type choice", async () => {
    signedIn(null);
    await expect(BillingSuccessPage()).rejects.toThrow("NEXT_REDIRECT /onboarding/account-type?next=%2Fapp%2Fbilling%2Fsuccess");
  });
});

describe("billing page", () => {
  it("planner without a subscription: the subscribe action and no price", async () => {
    signedIn("planner");
    const html = renderToStaticMarkup(await BillingPage(params() as never));
    expect(html).toContain(billing.planner.subscribe);
    expect(html).toContain(billing.priceNote);
    expect(html).not.toMatch(/\$\s?\d|₡\s?\d|USD|CRC/);
  });

  it("planner with an active entitlement: manage, never subscribe again", async () => {
    signedIn("planner", {
      billing_entitlements: [{ user_id: USER_ID, entitlement_key: "planner_pro", status: "active" }],
      billing_subscriptions: [{ user_id: USER_ID, status: "active", current_period_end: "2027-01-15T12:00:00Z", cancel_at_period_end: false }],
    });
    const html = renderToStaticMarkup(await BillingPage(params() as never));
    expect(html).toContain(billing.planner.manage);
    expect(html).not.toContain(billing.planner.subscribe);
    expect(html).toContain(billing.planner.renewsOn.replace("{date}", "15 de enero de 2027"));
  });

  it("couple paid: activated, no purchase action", async () => {
    signedIn("couple", {
      billing_entitlements: [{ user_id: USER_ID, entitlement_key: "couple_access", status: "active" }],
      billing_purchases: [{ user_id: USER_ID, status: "paid", purchased_at: "2026-10-16T15:00:00Z" }],
    });
    const html = renderToStaticMarkup(await BillingPage(params() as never));
    expect(html).toContain(billing.couple.activeBody);
    expect(html).not.toContain(billing.couple.buy);
  });

  it("not configured: says so and offers no action", async () => {
    runtime.isBillingAvailable.mockReturnValue(false);
    signedIn("couple");
    const html = renderToStaticMarkup(await BillingPage(params() as never));
    expect(html).toContain(billing.notAvailable);
    expect(html).not.toContain(billing.couple.buy);
  });

  it("a failed read is never shown as 'not paid'", async () => {
    signedIn("couple", { billing_entitlements: "error" });
    const html = renderToStaticMarkup(await BillingPage(params() as never));
    expect(html).toContain(billing.statusUnavailable);
    expect(html).not.toContain(billing.couple.buy);
  });

  it("only closed error values are shown", async () => {
    signedIn("planner");
    const html = renderToStaticMarkup(await BillingPage(params({ error: "<b>pwned</b>" }) as never));
    expect(html).not.toContain("pwned");
    const known = renderToStaticMarkup(await BillingPage(params({ error: "failed" }) as never));
    expect(known).toContain(billing.errors.failed);
  });
});

describe("cancel page", () => {
  it("changes nothing and says nothing was charged", async () => {
    const fake = signedIn("planner");
    const html = renderToStaticMarkup(await BillingCancelPage());
    expect(html).toContain(billing.cancel.body);
    expect(fake.reads).toEqual([]);
  });
});
