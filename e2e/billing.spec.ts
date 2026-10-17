import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";

import { WRONG_TEST_STRIPE_WEBHOOK_SECRET, signStripeEvent, stripeEventBody } from "../src/test/fixtures/stripe-webhook";

import { chooseAccountTypeInBrowser, createAccount, es, fillCredentials, logIn } from "./support/flows";
import { uniqueEmail } from "./support/identities";
import { readLocalSupabase } from "./support/local-supabase";
import { E2E_COUPLE_PRICE_ID, E2E_PLANNER_PRICE_ID, STRIPE_STAND_IN_ORIGIN, standIn } from "./support/stripe";

// BILLING-01 (ADR-021) against the production build. The real Stripe SDK in
// the app talks to the LOCAL stand-in (never Stripe); the journeys "pay" in
// the stand-in and then deliver the Stripe event themselves, signed with a
// FAKE test-only secret, like Stripe would. Ground truth (entitlements, the
// event ledger) is read from local Postgres: test tooling only, never the
// action under test.

const billing = es.billing;
const WEBHOOK = "/api/stripe/webhook";
const RUN = randomUUID().replace(/-/g, "").slice(0, 10);
let eventCounter = 0;
const eventId = () => `evt_e2e${RUN}${++eventCounter}`;

async function withDb<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: readLocalSupabase().dbUrl });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

async function userIdOf(email: string): Promise<string> {
  return withDb(async (db) => (await db.query<{ id: string }>("select id from auth.users where email = $1", [email])).rows[0].id);
}

async function entitlementOf(userId: string, key: "planner_pro" | "couple_access"): Promise<string | null> {
  return withDb(
    async (db) =>
      (
        await db.query<{ status: string }>(
          "select status::text as status from public.billing_entitlements where user_id = $1 and entitlement_key = $2",
          [userId, key],
        )
      ).rows[0]?.status ?? null,
  );
}

async function ledgerRows(id: string): Promise<number> {
  return withDb(async (db) => (await db.query("select 1 from public.stripe_webhook_events where stripe_event_id = $1", [id])).rowCount ?? 0);
}

async function deliver(request: APIRequestContext, type: string, objectId: string, id = eventId(), secret?: string) {
  const signed = signStripeEvent(stripeEventBody({ id, type, object: { id: objectId } }), secret ? { secret } : {});
  return request.post(WEBHOOK, { data: signed.body, headers: signed.headers });
}

/** Signs up with no type, logs in and makes the one-time choice in the browser. */
async function signUpAs(page: Page, label: string, type: "planner" | "couple"): Promise<string> {
  const email = await createAccount(label, null);
  await logIn(page, email);
  await chooseAccountTypeInBrowser(page, type);
  return email;
}

/** Clicks the plan's button and lands on the stand-in's hosted Checkout; returns that session. */
async function checkout(page: Page, button: string, path = "/app/billing") {
  await page.goto(path);
  await page.getByRole("button", { name: button }).click();
  await page.waitForURL(new RegExp(`^${STRIPE_STAND_IN_ORIGIN.replace(/[.:/]/g, "\\$&")}/checkout/`));
  const id = new URL(page.url()).pathname.split("/").pop() ?? "";
  const session = await standIn.session(id);
  if (!session) throw new Error("the stand-in has no such session");
  return session;
}

test.describe("billing", () => {
  test("planner: subscription Checkout → signed webhook → active → portal for their own customer", async ({ page, request, baseURL }) => {
    const email = await signUpAs(page, "billing-planner", "planner");
    const userId = await userIdOf(email);

    await page.goto("/app/billing");
    await expect(page.getByTestId("billing-status")).toHaveText(billing.planner.status.none);
    // BILLING-02: the frozen display price; no trial without a campaign.
    await expect(page.getByTestId("billing-price")).toHaveText("$99 USD / mes");
    await expect(page.getByTestId("billing-trial")).toHaveCount(0);
    await expect(page.getByText(billing.promoNote)).toBeVisible();

    const session = await checkout(page, billing.planner.subscribe);
    expect(session).toMatchObject({
      mode: "subscription",
      allow_promotion_codes: "true",
      payment_method_collection: "always",
      trial_period_days: null,
      discounts: null,
      client_reference_id: userId,
      success_url: `${baseURL}/app/billing/success`,
      cancel_url: `${baseURL}/app/billing/cancel`,
      metadata: { lb_user_id: userId, lb_account_type: "planner", lb_entitlement: "planner_pro" },
      subscriptionMetadata: { lb_user_id: userId, lb_account_type: "planner", lb_entitlement: "planner_pro" },
    });
    expect(session.lineItems).toEqual([expect.objectContaining({ price: { id: E2E_PLANNER_PRICE_ID }, quantity: 1 })]);
    expect(session.customer).toMatch(/^cus_/);

    // Forged success: the URL alone grants nothing.
    await page.goto("/app/billing/success");
    await expect(page.getByTestId("billing-success")).toContainText(billing.success.pendingBody);
    await expect(page.getByText(billing.success.plannerConfirmed)).toHaveCount(0);
    expect(await entitlementOf(userId, "planner_pro")).toBeNull();

    // "Pay" in the stand-in, then Stripe's events arrive.
    const paid = await standIn.complete(session.id);
    const subscriptionId = paid.subscription ?? "";
    expect(subscriptionId).toMatch(/^sub_/);

    // An unsigned or forged event is refused.
    const unsigned = await request.post(WEBHOOK, {
      data: stripeEventBody({ id: eventId(), type: "customer.subscription.created", object: { id: subscriptionId } }),
      headers: { "content-type": "application/json" },
    });
    expect(unsigned.status()).toBe(401);
    expect((await deliver(request, "customer.subscription.created", subscriptionId, eventId(), WRONG_TEST_STRIPE_WEBHOOK_SECRET)).status()).toBe(401);
    expect(await entitlementOf(userId, "planner_pro")).toBeNull();

    // The real one is accepted; a duplicate delivery is harmless.
    const created = eventId();
    expect((await deliver(request, "customer.subscription.created", subscriptionId, created)).status()).toBe(200);
    expect((await deliver(request, "customer.subscription.created", subscriptionId, created)).status()).toBe(200);
    expect(await ledgerRows(created)).toBe(1);
    expect((await deliver(request, "checkout.session.completed", session.id)).status()).toBe(200);
    expect(await entitlementOf(userId, "planner_pro")).toBe("active");

    // The pending success page now confirms, from the database.
    await page.goto("/app/billing/success");
    await expect(page.getByText(billing.success.plannerConfirmed)).toBeVisible();

    await page.goto("/app/billing");
    await expect(page.getByTestId("billing-status")).toHaveText(billing.planner.status.active);
    await expect(page.getByRole("button", { name: billing.planner.subscribe })).toHaveCount(0);

    // The portal opens for THIS user's customer only.
    const before = (await standIn.portalSessions()).length;
    await page.getByRole("button", { name: billing.planner.manage }).click();
    await page.waitForURL(new RegExp(`${STRIPE_STAND_IN_ORIGIN.replace(/[.:/]/g, "\\$&")}/portal/`));
    const portals = await standIn.portalSessions();
    expect(portals).toHaveLength(before + 1);
    expect(portals.at(-1)).toEqual(expect.objectContaining({ customer: session.customer, return_url: `${baseURL}/app/billing` }));

    // Out of order: the subscription is canceled; a late, stale "active" can't revive it.
    await standIn.setSubscription(subscriptionId, { status: "canceled" });
    expect((await deliver(request, "customer.subscription.deleted", subscriptionId)).status()).toBe(200);
    expect(await entitlementOf(userId, "planner_pro")).toBe("inactive");
    await standIn.setSubscription(subscriptionId, { status: "active" });
    expect((await deliver(request, "customer.subscription.updated", subscriptionId)).status()).toBe(200);
    expect(await entitlementOf(userId, "planner_pro")).toBe("inactive");
    await page.goto("/app/billing");
    await expect(page.getByTestId("billing-status")).toHaveText(billing.planner.status.none);
  });

  test("couple: one-time payment Checkout → signed webhook → access activated", async ({ page, request }) => {
    const email = await signUpAs(page, "billing-couple", "couple");
    const userId = await userIdOf(email);

    await page.goto("/app/billing");
    await expect(page.getByTestId("billing-price")).toHaveText("$149 USD");
    await expect(page.getByText(billing.couple.cadence, { exact: true })).toBeVisible();
    await expect(page.getByText(billing.promoNote)).toBeVisible();

    const session = await checkout(page, billing.couple.buy);
    expect(session).toMatchObject({
      mode: "payment",
      allow_promotion_codes: "true",
      payment_method_collection: null,
      trial_period_days: null,
      discounts: null,
      metadata: { lb_user_id: userId, lb_account_type: "couple", lb_entitlement: "couple_access" },
      paymentIntentMetadata: { lb_user_id: userId, lb_account_type: "couple", lb_entitlement: "couple_access" },
      subscriptionMetadata: null,
    });
    expect(session.lineItems).toEqual([expect.objectContaining({ price: { id: E2E_COUPLE_PRICE_ID }, quantity: 1 })]);

    // A completed but unpaid (delayed) payment grants nothing.
    await standIn.complete(session.id, "unpaid");
    expect((await deliver(request, "checkout.session.completed", session.id)).status()).toBe(200);
    expect(await entitlementOf(userId, "couple_access")).toBe("inactive");
    await page.goto("/app/billing");
    await expect(page.getByTestId("billing-status")).toHaveText(billing.couple.status.pending);
    await expect(page.getByRole("button", { name: billing.couple.buy })).toHaveCount(0);

    // The delayed payment settles.
    await standIn.complete(session.id, "paid");
    const settled = eventId();
    expect((await deliver(request, "checkout.session.async_payment_succeeded", session.id, settled)).status()).toBe(200);
    expect((await deliver(request, "checkout.session.async_payment_succeeded", session.id, settled)).status()).toBe(200);
    expect(await ledgerRows(settled)).toBe(1);
    expect(await entitlementOf(userId, "couple_access")).toBe("active");

    await page.goto("/app/billing");
    await expect(page.getByTestId("billing-status")).toHaveText(billing.couple.status.active);
    await expect(page.getByText(billing.couple.activeBody)).toBeVisible();
    await expect(page.getByRole("button", { name: billing.couple.buy })).toHaveCount(0);
    await page.goto("/app/billing/success");
    await expect(page.getByText(billing.success.coupleConfirmed)).toBeVisible();
  });

  test("untyped: billing sends the account to the account-type choice; no Checkout is created", async ({ page }) => {
    const sessionsBefore = (await standIn.sessions()).length;
    await logIn(page, await createAccount("billing-untyped", null));
    await page.goto("/app/billing");
    await expect(page).toHaveURL(/\/onboarding\/account-type\?next=%2Fapp%2Fbilling$/);
    await page.goto("/app/billing/success");
    await expect(page).toHaveURL(/\/onboarding\/account-type/);
    expect((await standIn.sessions()).length).toBe(sessionsBefore);
  });

  // ---------------------------------------------------------------- BILLING-02 / MKT-7

  test("planner from /planners: pricing → CTA → login → account type → billing → promo codes allowed, no trial", async ({ page }) => {
    await page.goto("/planners");
    const pricing = page.locator("#precio");
    await expect(pricing.getByTestId("pricing-price")).toHaveText(/\$99\s*USD\s*\/ mes/);
    await pricing.getByRole("link", { name: es.marketing.pricing.planner.cta }).click();
    await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fbilling$/);

    // An existing account with no type yet: login → the one-time choice → billing.
    const email = await createAccount("billing-mkt-planner", null);
    await fillCredentials(page, email);
    await page.getByRole("button", { name: es.auth.login.submit }).click();
    await expect(page).toHaveURL(/\/onboarding\/account-type\?next=%2Fapp%2Fbilling$/);
    await chooseAccountTypeInBrowser(page, "planner");
    await expect(page).toHaveURL(/\/app\/billing$/);
    await expect(page.getByTestId("billing-price")).toHaveText("$99 USD / mes");

    const session = await checkout(page, billing.planner.subscribe);
    expect(session).toMatchObject({
      mode: "subscription",
      allow_promotion_codes: "true",
      payment_method_collection: "always",
      trial_period_days: null,
      discounts: null,
    });
    expect(session.lineItems).toEqual([expect.objectContaining({ price: { id: E2E_PLANNER_PRICE_ID }, quantity: 1 })]);

    // Signed in already: the same CTA goes straight to billing.
    await page.goto("/planners");
    await page.locator("#precio").getByRole("link", { name: es.marketing.pricing.planner.cta }).click();
    await expect(page).toHaveURL(/\/app\/billing$/);
  });

  test("planner trial campaign: trial copy → subscription with server-derived trial days → trialing webhook → planner_pro", async ({ page, request }) => {
    const email = await signUpAs(page, "billing-trial", "planner");
    const userId = await userIdOf(email);
    const path = "/app/billing?campaign=planner_trial_14";

    await page.goto(path);
    await expect(page.getByTestId("billing-trial")).toContainText(billing.planner.trialOffer.replace("{days}", "14"));
    await expect(page.getByTestId("billing-price")).toHaveText("Después, $99 USD/mes.");

    // The browser can't stretch it: a forged hidden field is re-resolved on the server.
    await page.locator('input[name="campaign"]').evaluate((input) => {
      const form = input.closest("form");
      for (const [name, value] of [["trial_period_days", "365"], ["trial_days", "365"], ["coupon", "coupon_FORGED"], ["promotion_code", "promo_FORGED"]]) {
        const extra = document.createElement("input");
        extra.type = "hidden";
        extra.name = name;
        extra.value = value;
        form?.appendChild(extra);
      }
    });
    const session = await checkout(page, billing.planner.startTrial, path);
    expect(session).toMatchObject({
      mode: "subscription",
      allow_promotion_codes: "true",
      payment_method_collection: "always",
      trial_period_days: 14,
      discounts: null,
      metadata: { lb_user_id: userId, lb_entitlement: "planner_pro", lb_campaign: "planner_trial_14" },
      subscriptionMetadata: { lb_user_id: userId, lb_entitlement: "planner_pro", lb_campaign: "planner_trial_14" },
    });
    expect(session.lineItems).toEqual([expect.objectContaining({ price: { id: E2E_PLANNER_PRICE_ID }, quantity: 1 })]);

    // Forged success first: nothing yet.
    await page.goto("/app/billing/success");
    await expect(page.getByText(billing.success.plannerConfirmed)).toHaveCount(0);
    expect(await entitlementOf(userId, "planner_pro")).toBeNull();

    // Trial Checkout: nothing charged now, the subscription starts trialing.
    const done = await standIn.complete(session.id, "no_payment_required", 0);
    expect((await deliver(request, "checkout.session.completed", session.id)).status()).toBe(200);
    expect(await entitlementOf(userId, "planner_pro")).toBe("active");
    await page.goto("/app/billing");
    await expect(page.getByTestId("billing-status")).toHaveText(billing.planner.status.trialing);

    // After the trial: active keeps access; past_due denies.
    const subscriptionId = done.subscription ?? "";
    await standIn.setSubscription(subscriptionId, { status: "active" });
    expect((await deliver(request, "customer.subscription.updated", subscriptionId)).status()).toBe(200);
    expect(await entitlementOf(userId, "planner_pro")).toBe("active");
    await standIn.setSubscription(subscriptionId, { status: "past_due" });
    expect((await deliver(request, "customer.subscription.updated", subscriptionId)).status()).toBe(200);
    expect(await entitlementOf(userId, "planner_pro")).toBe("inactive");
  });

  test("planner with an unknown, numeric or disabled campaign: no trial is applied", async ({ page }) => {
    await signUpAs(page, "billing-bad-campaign", "planner");
    // planner_trial_30 is a known key, but OFF in this deployment.
    for (const campaign of ["planner_trial_365", "14", "planner_trial_30"]) {
      const path = `/app/billing?campaign=${campaign}`;
      await page.goto(path);
      await expect(page.getByTestId("billing-trial")).toHaveCount(0);
      await expect(page.getByTestId("billing-price")).toHaveText("$99 USD / mes");
      await expect(page.locator('input[name="campaign"]')).toHaveCount(0);
    }
    const session = await checkout(page, billing.planner.subscribe, "/app/billing?trial=14&trial_period_days=14");
    expect(session).toMatchObject({ mode: "subscription", allow_promotion_codes: "true", trial_period_days: null });
  });

  test("couple from /parejas: pricing → CTA → signup → account type → payment Checkout with promo codes, no trial", async ({ page }) => {
    await page.goto("/parejas");
    const pricing = page.locator("#precio");
    await expect(pricing.getByTestId("pricing-price")).toHaveText(/\$149\s*USD/);
    await expect(pricing.getByText(es.marketing.pricing.couple.cadenceLabel)).toBeVisible();
    await pricing.getByRole("link", { name: es.marketing.pricing.couple.cta }).click();
    await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fbilling$/);

    // New here: the login page's own signup link keeps `next`.
    await page.getByRole("link", { name: es.auth.login.createAccount }).click();
    await expect(page).toHaveURL(/\/signup\?next=%2Fapp%2Fbilling$/);
    await fillCredentials(page, uniqueEmail("billing-mkt-couple"));
    await page.getByRole("button", { name: es.auth.signup.submit }).click();
    await expect(page).toHaveURL(/\/onboarding\/account-type\?next=%2Fapp%2Fbilling$/);
    await chooseAccountTypeInBrowser(page, "couple");
    await expect(page).toHaveURL(/\/app\/billing$/);

    // A planner campaign means nothing to a couple.
    const session = await checkout(page, billing.couple.buy, "/app/billing?campaign=planner_trial_14");
    expect(session).toMatchObject({
      mode: "payment",
      allow_promotion_codes: "true",
      trial_period_days: null,
      payment_method_collection: null,
      discounts: null,
      subscriptionMetadata: null,
    });
    expect(session.lineItems).toEqual([expect.objectContaining({ price: { id: E2E_COUPLE_PRICE_ID }, quantity: 1 })]);
  });

  test("couple 100% off: a $0 Checkout with no PaymentIntent → verified webhook → couple_access; forged success grants nothing", async ({ page, request }) => {
    const email = await signUpAs(page, "billing-free-couple", "couple");
    const userId = await userIdOf(email);
    const session = await checkout(page, billing.couple.buy);

    // Forged success before anything happened.
    await page.goto("/app/billing/success");
    await expect(page.getByTestId("billing-success")).toContainText(billing.success.pendingBody);
    await expect(page.getByText(billing.success.coupleConfirmed)).toHaveCount(0);
    expect(await entitlementOf(userId, "couple_access")).toBeNull();

    // A promotion code covered everything: complete, nothing to pay, $0, no PaymentIntent.
    const free = await standIn.complete(session.id, "no_payment_required", 0);
    expect(free).toMatchObject({ status: "complete", payment_status: "no_payment_required", amount_total: 0, payment_intent: null });

    // A forged (wrong-secret) event still can't grant it.
    expect((await deliver(request, "checkout.session.completed", session.id, eventId(), WRONG_TEST_STRIPE_WEBHOOK_SECRET)).status()).toBe(401);
    expect(await entitlementOf(userId, "couple_access")).toBeNull();

    expect((await deliver(request, "checkout.session.completed", session.id)).status()).toBe(200);
    expect(await entitlementOf(userId, "couple_access")).toBe("active");
    const purchase = await withDb(
      async (db) =>
        (
          await db.query<{ status: string; stripe_payment_intent_id: string | null }>(
            "select status::text as status, stripe_payment_intent_id from public.billing_purchases where stripe_checkout_session_id = $1",
            [session.id],
          )
        ).rows,
    );
    expect(purchase).toEqual([{ status: "paid", stripe_payment_intent_id: null }]);

    await page.goto("/app/billing/success");
    await expect(page.getByText(billing.success.coupleConfirmed)).toBeVisible();
    await page.goto("/app/billing");
    await expect(page.getByTestId("billing-status")).toHaveText(billing.couple.status.active);
  });
});
