import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";

import { WRONG_TEST_STRIPE_WEBHOOK_SECRET, signStripeEvent, stripeEventBody } from "../src/test/fixtures/stripe-webhook";

import { chooseAccountTypeInBrowser, createAccount, es, logIn } from "./support/flows";
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
async function checkout(page: Page, button: string) {
  await page.goto("/app/billing");
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
    await expect(page.getByText(/\$\s?\d|₡\s?\d/)).toHaveCount(0);

    const session = await checkout(page, billing.planner.subscribe);
    expect(session).toMatchObject({
      mode: "subscription",
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

    const session = await checkout(page, billing.couple.buy);
    expect(session).toMatchObject({
      mode: "payment",
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
});
