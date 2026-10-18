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
const runtime = vi.hoisted(() => ({
  getBillingRuntime: vi.fn(),
  isBillingAvailable: vi.fn(() => true),
  getEnabledTrialCampaigns: vi.fn((): readonly string[] => []),
}));
vi.mock("@/lib/billing/runtime", () => runtime);

import { getMessages } from "@/lib/i18n";
import { LEGAL_LINKS } from "@/lib/legal/links";

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
  runtime.getEnabledTrialCampaigns.mockReturnValue([]);
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

  it("BILLING-02: a planner trial or a $0 purchase opening the success URL still only sees 'confirming'", async () => {
    signedIn("planner", {
      billing_subscriptions: [{ user_id: USER_ID, status: "trialing", current_period_end: null, cancel_at_period_end: false }],
    });
    // A trialing row without the webhook-computed entitlement grants nothing.
    const html = renderToStaticMarkup(await BillingSuccessPage());
    expect(html).toContain(billing.success.pendingBody);
    expect(html).not.toContain(billing.success.plannerConfirmed);
  });

  it("an untyped account is sent to the account-type choice", async () => {
    signedIn(null);
    await expect(BillingSuccessPage()).rejects.toThrow("NEXT_REDIRECT /onboarding/account-type?next=%2Fapp%2Fbilling%2Fsuccess");
  });
});

describe("billing page", () => {
  it("planner without a subscription: the subscribe action, the frozen display price and the promo-code note", async () => {
    signedIn("planner");
    const html = renderToStaticMarkup(await BillingPage(params() as never));
    expect(html).toContain(billing.planner.subscribe);
    expect(html).toContain(billing.priceNote);
    expect(html).toContain(billing.promoNote);
    expect(html).toContain(">$99 USD / mes<");
    expect(html).not.toContain(billing.planner.trialOffer.replace("{days}", ""));
    expect(html).not.toContain('name="campaign"');
  });

  it("couple without access: $149 USD, one-time, and the promo-code note", async () => {
    signedIn("couple");
    const html = renderToStaticMarkup(await BillingPage(params() as never));
    expect(html).toContain(">$149 USD<");
    expect(html).toContain(billing.couple.cadence);
    expect(html).toContain(billing.promoNote);
    expect(html).toContain(billing.couple.buy);
  });

  describe("BILLING-02 trial campaigns", () => {
    const trialText = (days: number) => billing.planner.trialOffer.replace("{days}", String(days));

    it.each([7, 14, 30])("a valid, enabled planner_trial_%i shows the trial, then $99 USD/mes, and carries only the key", async (days) => {
      runtime.getEnabledTrialCampaigns.mockReturnValue(["planner_trial_7", "planner_trial_14", "planner_trial_30"]);
      signedIn("planner");
      const html = renderToStaticMarkup(await BillingPage(params({ campaign: `planner_trial_${days}` }) as never));
      expect(html).toContain(trialText(days));
      expect(html).toContain("Después, $99 USD/mes.");
      expect(html).toContain(billing.planner.startTrial);
      expect(html).toContain(`<input type="hidden" name="campaign" value="planner_trial_${days}"/>`);
      expect(html).not.toMatch(/name="(trial|trial_days|trial_period_days|coupon|promotion_code)"/);
    });

    it.each([["unknown", "planner_trial_60"], ["numeric", "14"], ["not enabled", "planner_trial_30"]])(
      "%s campaign → the normal $99/mes flow, silently",
      async (_label, campaign) => {
        runtime.getEnabledTrialCampaigns.mockReturnValue(["planner_trial_14"]);
        signedIn("planner");
        const html = renderToStaticMarkup(await BillingPage(params({ campaign }) as never));
        expect(html).toContain(">$99 USD / mes<");
        expect(html).toContain(billing.planner.subscribe);
        expect(html).not.toContain('name="campaign"');
        expect(html).not.toContain(campaign === "14" ? "Prueba gratuita" : campaign);
      },
    );

    it("a planner who already had a subscription is not offered a trial", async () => {
      runtime.getEnabledTrialCampaigns.mockReturnValue(["planner_trial_14"]);
      signedIn("planner", {
        billing_subscriptions: [{ user_id: USER_ID, status: "canceled", current_period_end: null, cancel_at_period_end: false }],
      });
      const html = renderToStaticMarkup(await BillingPage(params({ campaign: "planner_trial_14" }) as never));
      expect(html).not.toContain(trialText(14));
      expect(html).toContain(billing.planner.subscribe);
    });

    it("a couple never sees a planner trial", async () => {
      runtime.getEnabledTrialCampaigns.mockReturnValue(["planner_trial_14"]);
      signedIn("couple");
      const html = renderToStaticMarkup(await BillingPage(params({ campaign: "planner_trial_14" }) as never));
      expect(html).not.toContain("Prueba gratuita");
      expect(html).not.toContain('name="campaign"');
      expect(html).toContain(">$149 USD<");
    });

    it("an untyped account keeps a VALID key through the account-type choice, never an unknown one", async () => {
      signedIn(null);
      await expect(BillingPage(params({ campaign: "planner_trial_14" }) as never)).rejects.toThrow(
        "NEXT_REDIRECT /onboarding/account-type?next=%2Fapp%2Fbilling%3Fcampaign%3Dplanner_trial_14",
      );
      await expect(BillingPage(params({ campaign: "<x>" }) as never)).rejects.toThrow(
        /NEXT_REDIRECT \/onboarding\/account-type\?next=%2Fapp%2Fbilling$/,
      );
    });
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

  describe("Batch 1: unpaid state and legal links", () => {
    const legalHrefs = [LEGAL_LINKS.TERMS, LEGAL_LINKS.REFUNDS, LEGAL_LINKS.PRIVACY];

    it("planner never subscribed: nothing was charged, payment only through Facturación, data isn't lost, consent next to the button", async () => {
      signedIn("planner");
      const html = renderToStaticMarkup(await BillingPage(params() as never));
      expect(html).toContain(billing.planner.noneBody);
      expect(billing.planner.noneBody).toContain("no se te ha cobrado nada");
      expect(billing.planner.noneBody).toContain("«Suscribirme»");
      expect(html).toContain(billing.unpaidDataNote);
      expect(html).toContain('data-testid="billing-legal-consent"');
      for (const href of legalHrefs) expect(html).toContain(`href="${href}"`);
    });

    it("planner whose subscription ended: never claims 'nothing was charged'", async () => {
      signedIn("planner", {
        billing_subscriptions: [{ user_id: USER_ID, status: "canceled", current_period_end: null, cancel_at_period_end: false }],
      });
      const html = renderToStaticMarkup(await BillingPage(params() as never));
      expect(html).toContain(billing.planner.noneBodyPrevious);
      expect(html).not.toContain("no se te ha cobrado nada");
      expect(html).not.toContain(billing.unpaidDataNote);
    });

    it("couple never paid: different wording from the planner, no automatic charges, consent next to the button", async () => {
      signedIn("couple");
      const html = renderToStaticMarkup(await BillingPage(params() as never));
      expect(html).toContain(billing.couple.noneBody);
      expect(billing.couple.noneBody).not.toBe(billing.planner.noneBody);
      expect(billing.couple.noneBody).toContain("No hay cobros automáticos.");
      expect(html).toContain(billing.unpaidDataNote);
      expect(html).toContain('data-testid="billing-legal-consent"');
    });

    it("paid or pending accounts never see the unpaid copy, but still find the legal links", async () => {
      signedIn("couple", { billing_purchases: [{ user_id: USER_ID, status: "pending", purchased_at: null }] });
      const pending = renderToStaticMarkup(await BillingPage(params() as never));
      signedIn("planner", {
        billing_entitlements: [{ user_id: USER_ID, entitlement_key: "planner_pro", status: "active" }],
        billing_subscriptions: [{ user_id: USER_ID, status: "active", current_period_end: null, cancel_at_period_end: true }],
      });
      const active = renderToStaticMarkup(await BillingPage(params() as never));
      for (const html of [pending, active]) {
        expect(html).not.toContain("no se te ha cobrado nada");
        expect(html).not.toContain(billing.unpaidDataNote);
        expect(html).not.toContain('data-testid="billing-legal-consent"');
        for (const href of legalHrefs) expect(html).toContain(`href="${href}"`);
      }
    });
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
