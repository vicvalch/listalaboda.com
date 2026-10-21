import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";
import type { BillingGateway } from "@/lib/billing/gateway";
import { BILLING_SUBSCRIPTION_STATUSES, SUBSCRIPTION_GRANTING_STATUSES } from "@/lib/billing/plans";
import { checkoutSessionSnapshot, fakeGateway, subscriptionSnapshot } from "@/test/fixtures/billing";
import { TEST_STRIPE_WEBHOOK_SECRET, signStripeEvent, stripeEventBody } from "@/test/fixtures/stripe-webhook";

import { TEST_EMAIL_DOMAIN, type TestUser } from "./context";
import { PERMISSION_DENIED, as, clientAs, createWedding, ctx, serviceRole, sql, type DbClient } from "./support";

vi.mock("server-only", () => ({}));
// The webhook route test below swaps only the Stripe side; the database store is REAL.
const gatewayRef = vi.hoisted(() => ({ current: null as BillingGateway | null }));
vi.mock("@/lib/billing/stripe-gateway", () => ({ getStripeGateway: () => gatewayRef.current }));

const { createBillingCustomerRecorder } = await import("@/lib/billing/customer-recorder");
const { createBillingWebhookStore } = await import("@/lib/billing/webhook-store");
const route = await import("@/app/api/stripe/webhook/route");

// BILLING-01 (ADR-021): customer mapping, subscriptions, purchases,
// entitlements and the Stripe event ledger, exercised as real anon,
// authenticated and service_role callers through the Data API. Each test
// signs up throwaway local accounts (typed through the real RPC). The
// superuser connection only reads ground truth and proves that guards hold
// even for it; it never performs the action under test.

type SubStatus = Database["public"]["Enums"]["billing_subscription_status"];
type PurchaseStatus = Database["public"]["Enums"]["billing_purchase_status"];
type AccountType = "planner" | "couple";

const GUARD = "55000";
const UNIQUE_VIOLATION = "23505";
const LOCAL_PASSWORD = "local-only-fixture-password";
const BILLING_TABLES = [
  "billing_customers",
  "billing_subscriptions",
  "billing_purchases",
  "billing_entitlements",
  "stripe_webhook_events",
] as const;

const createdUserIds: string[] = [];
const createdWeddingIds: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddingIds]);
  // Deleting the account cascades its billing rows (the only allowed deletion).
  await sql("delete from auth.users where id = any($1::uuid[])", [createdUserIds]);
});

const rand = () => randomUUID().replace(/-/g, "").slice(0, 20);
const eventId = () => `evt_dbt${rand()}`;
const customerId = () => `cus_dbt${rand()}`;
const subscriptionId = () => `sub_dbt${rand()}`;
const sessionId = () => `cs_test_dbt${rand()}`;

async function freshUser(type: AccountType | null): Promise<{ user: TestUser; client: DbClient }> {
  const email = `billing-${rand().slice(0, 10)}@${TEST_EMAIL_DOMAIN}`;
  const { data, error } = await createClient(ctx.apiUrl, ctx.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.signUp({ email, password: LOCAL_PASSWORD });
  if (error || !data.session) throw new Error(`Could not create a local account: ${error?.message}`);
  createdUserIds.push(data.session.user.id);
  const user: TestUser = {
    id: data.session.user.id,
    email,
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
  };
  const client = clientAs(user);
  if (type) {
    const typed = await client.rpc("select_account_type", { requested: type });
    if (typed.error) throw new Error(`select_account_type failed: ${typed.error.message}`);
  }
  return { user, client };
}

async function mapCustomer(userId: string, id = customerId()): Promise<string> {
  const { data, error } = await serviceRole.rpc("record_billing_customer", { target_user_id: userId, stripe_customer_id: id });
  if (error || !data) throw new Error(`record_billing_customer failed: ${error?.message}`);
  return data;
}

type SubArgs = Database["public"]["Functions"]["apply_stripe_subscription_event"]["Args"];
type PayArgs = Database["public"]["Functions"]["apply_stripe_checkout_payment_event"]["Args"];

let clock = Date.parse("2026-10-16T12:00:00Z");
/** Strictly increasing observation times (the order the app would have seen Stripe). */
const nextObservation = () => new Date((clock += 1000)).toISOString();

function subArgs(userId: string, customer: string, sub: string, overrides: Partial<SubArgs> = {}): SubArgs {
  return {
    stripe_event_id: eventId(),
    event_type: "customer.subscription.updated",
    event_livemode: false,
    event_created_at: new Date().toISOString(),
    stripe_customer_id: customer,
    stripe_subscription_id: sub,
    metadata_user_id: userId,
    entitlement_key: "planner_pro",
    subscription_status: "active",
    cancel_at_period_end: false,
    observed_at: nextObservation(),
    stripe_price_id: "price_TESTONLYplanner",
    current_period_end: "2026-11-16T12:00:00Z",
    ...overrides,
  };
}

function payArgs(userId: string, customer: string, session: string, overrides: Partial<PayArgs> = {}): PayArgs {
  return {
    stripe_event_id: eventId(),
    event_type: "checkout.session.completed",
    event_livemode: false,
    event_created_at: new Date().toISOString(),
    stripe_customer_id: customer,
    stripe_checkout_session_id: session,
    metadata_user_id: userId,
    entitlement_key: "couple_access",
    payment_status: "paid",
    stripe_payment_intent_id: `pi_dbt${rand()}`,
    stripe_price_id: "price_TESTONLYcouple",
    ...overrides,
  };
}

async function applySub(args: SubArgs) {
  const { data, error } = await serviceRole.rpc("apply_stripe_subscription_event", args);
  if (error) throw new Error(`apply_stripe_subscription_event failed: ${error.message}`);
  return data;
}

async function applyPay(args: PayArgs) {
  const { data, error } = await serviceRole.rpc("apply_stripe_checkout_payment_event", args);
  if (error) throw new Error(`apply_stripe_checkout_payment_event failed: ${error.message}`);
  return data;
}

async function entitlement(userId: string, key: "planner_pro" | "couple_access"): Promise<string | null> {
  const rows = await sql<{ status: string }>(
    "select status::text as status from public.billing_entitlements where user_id = $1 and entitlement_key = $2",
    [userId, key],
  );
  return rows[0]?.status ?? null;
}

async function storedSubscription(sub: string) {
  const rows = await sql<{ status: SubStatus; cancel_at_period_end: boolean }>(
    "select status::text as status, cancel_at_period_end from public.billing_subscriptions where stripe_subscription_id = $1",
    [sub],
  );
  return rows[0] ?? null;
}

async function purchasesOf(userId: string) {
  return sql<{ status: PurchaseStatus; purchased_at: Date | null; stripe_payment_intent_id: string | null }>(
    "select status::text as status, purchased_at, stripe_payment_intent_id from public.billing_purchases where user_id = $1 order by created_at",
    [userId],
  );
}

async function eventRow(id: string) {
  const rows = await sql<{ outcome: string; event_type: string }>(
    "select outcome::text as outcome, event_type from public.stripe_webhook_events where stripe_event_id = $1",
    [id],
  );
  return rows[0] ?? null;
}

async function sqlError(text: string, params: unknown[] = []): Promise<string | undefined> {
  try {
    await sql(text, params);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

// ------------------------------------------------------------------ schema

describe("schema", () => {
  it("the billing tables exist with RLS enabled", async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = any($1::text[])`,
      [[...BILLING_TABLES]],
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...BILLING_TABLES].sort());
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  it("existing wedding tables keep RLS on (billing changes nothing there)", async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = any($1::text[])`,
      [["weddings", "wedding_memberships", "checklist_items", "guest_invitations", "user_accounts"]],
    );
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  it("no client role and not even service_role holds a write privilege on any billing table", async () => {
    const rows = await sql<{ grantee: string; table_name: string; privilege_type: string }>(
      `select grantee, table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = any($1::text[])
         and grantee in ('anon', 'authenticated', 'service_role')
         and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')`,
      [[...BILLING_TABLES]],
    );
    expect(rows).toEqual([]);
  });

  it("the DB planner policy matches the application's (every Stripe status)", async () => {
    const rows = await sql<{ status: string; grants: boolean }>(
      "select s::text as status, private.billing_subscription_grants(s) as grants from unnest(enum_range(null::public.billing_subscription_status)) s",
    );
    expect(rows.map((r) => r.status).sort()).toEqual([...BILLING_SUBSCRIPTION_STATUSES].sort());
    const granting = rows.filter((r) => r.grants).map((r) => r.status).sort();
    expect(granting).toEqual([...SUBSCRIPTION_GRANTING_STATUSES].sort());
    expect(granting).toEqual(["active", "trialing"]);
  });
});

// ------------------------------------------------------- client denial

describe("ordinary clients can't write billing state", () => {
  let planner: { user: TestUser; client: DbClient };
  let customer: string;

  beforeAll(async () => {
    planner = await freshUser("planner");
    customer = await mapCustomer(planner.user.id);
    await applySub(subArgs(planner.user.id, customer, subscriptionId(), { subscription_status: "past_due" }));
  });

  it("can't insert a customer mapping, or change their stripe_customer_id", async () => {
    const insert = await planner.client
      .from("billing_customers")
      .insert({ user_id: planner.user.id, stripe_customer_id: customerId() });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);
    const update = await planner.client
      .from("billing_customers")
      .update({ stripe_customer_id: customerId() })
      .eq("user_id", planner.user.id);
    expect(update.error?.code).toBe(PERMISSION_DENIED);
    const del = await planner.client.from("billing_customers").delete().eq("user_id", planner.user.id);
    expect(del.error?.code).toBe(PERMISSION_DENIED);
  });

  it("can't create or update subscription state", async () => {
    const insert = await planner.client.from("billing_subscriptions").insert({
      user_id: planner.user.id,
      stripe_customer_id: customer,
      stripe_subscription_id: subscriptionId(),
      entitlement_key: "planner_pro",
      status: "active",
      stripe_observed_at: new Date().toISOString(),
    });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);
    const update = await planner.client.from("billing_subscriptions").update({ status: "active" }).eq("user_id", planner.user.id);
    expect(update.error?.code).toBe(PERMISSION_DENIED);
  });

  it("can't create a paid purchase or mark one paid", async () => {
    const insert = await planner.client.from("billing_purchases").insert({
      user_id: planner.user.id,
      stripe_customer_id: customer,
      stripe_checkout_session_id: sessionId(),
      entitlement_key: "couple_access",
      status: "paid",
      purchased_at: new Date().toISOString(),
    });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);
    const update = await planner.client.from("billing_purchases").update({ status: "paid" }).eq("user_id", planner.user.id);
    expect(update.error?.code).toBe(PERMISSION_DENIED);
  });

  it("can't create or activate an entitlement (self-grant)", async () => {
    const insert = await planner.client.from("billing_entitlements").insert({
      user_id: planner.user.id,
      entitlement_key: "planner_pro",
      status: "active",
      source: "subscription",
      granted_at: new Date().toISOString(),
    });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);
    const update = await planner.client
      .from("billing_entitlements")
      .update({ status: "active" })
      .eq("user_id", planner.user.id);
    expect(update.error?.code).toBe(PERMISSION_DENIED);
    expect(await entitlement(planner.user.id, "planner_pro")).toBe("inactive");
  });

  it("can't read or write the webhook event ledger", async () => {
    const read = await planner.client.from("stripe_webhook_events").select("stripe_event_id");
    expect(read.error?.code).toBe(PERMISSION_DENIED);
    const insert = await planner.client.from("stripe_webhook_events").insert({
      stripe_event_id: eventId(),
      event_type: "customer.subscription.updated",
      livemode: false,
      stripe_created_at: new Date().toISOString(),
      outcome: "applied",
    });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);
  });

  it("can't execute any billing write function (authenticated or anon)", async () => {
    for (const client of [planner.client, as.anon]) {
      const rec = await client.rpc("record_billing_customer", { target_user_id: planner.user.id, stripe_customer_id: customerId() });
      expect(rec.error?.code).toBe(PERMISSION_DENIED);
      const sub = await client.rpc("apply_stripe_subscription_event", subArgs(planner.user.id, customer, subscriptionId()));
      expect(sub.error?.code).toBe(PERMISSION_DENIED);
      const pay = await client.rpc("apply_stripe_checkout_payment_event", payArgs(planner.user.id, customer, sessionId()));
      expect(pay.error?.code).toBe(PERMISSION_DENIED);
    }
    expect(await entitlement(planner.user.id, "planner_pro")).toBe("inactive");
  });

  it("service_role can't write the tables directly either: only through the functions", async () => {
    const insert = await serviceRole.from("billing_entitlements").insert({
      user_id: planner.user.id,
      entitlement_key: "planner_pro",
      status: "active",
      source: "subscription",
      granted_at: new Date().toISOString(),
    });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);
  });

  it("reads only their own rows; anon reads nothing", async () => {
    const other = await freshUser("planner");
    await mapCustomer(other.user.id);
    const own = await planner.client.from("billing_customers").select("user_id, stripe_customer_id");
    expect(own.error).toBeNull();
    expect(own.data).toEqual([{ user_id: planner.user.id, stripe_customer_id: customer }]);
    const subs = await other.client.from("billing_subscriptions").select("status");
    expect(subs.data).toEqual([]);
    for (const table of BILLING_TABLES) {
      const anon = await as.anon.from(table).select("*");
      expect(anon.error?.code, table).toBe(PERMISSION_DENIED);
    }
  });

  it("never sees Stripe subscription/price ids or observation stamps through the Data API", async () => {
    const { error } = await planner.client.from("billing_subscriptions").select("stripe_subscription_id");
    expect(error?.code).toBe(PERMISSION_DENIED);
    const price = await planner.client.from("billing_subscriptions").select("stripe_price_id, stripe_observed_at");
    expect(price.error?.code).toBe(PERMISSION_DENIED);
  });
});

// ------------------------------------------------------ customer mapping

describe("record_billing_customer", () => {
  it("an untyped account can't get billing state (account_type_required)", async () => {
    const untyped = await freshUser(null);
    const { error } = await serviceRole.rpc("record_billing_customer", {
      target_user_id: untyped.user.id,
      stripe_customer_id: customerId(),
    });
    expect(error?.code).toBe(GUARD);
    expect(error?.message).toBe("account_type_required");
    expect(await sql("select 1 from public.billing_customers where user_id = $1", [untyped.user.id])).toEqual([]);
  });

  it("one mapping per user: a later customer id gets the FIRST one back", async () => {
    const { user } = await freshUser("couple");
    const first = customerId();
    expect(await mapCustomer(user.id, first)).toBe(first);
    expect(await mapCustomer(user.id, customerId())).toBe(first);
    expect(await mapCustomer(user.id, first)).toBe(first);
    const rows = await sql("select 1 from public.billing_customers where user_id = $1", [user.id]);
    expect(rows).toHaveLength(1);
  });

  it("concurrent first mappings converge on one customer", async () => {
    const { user } = await freshUser("planner");
    const results = await Promise.all([customerId(), customerId(), customerId()].map((id) => mapCustomer(user.id, id)));
    expect(new Set(results).size).toBe(1);
  });

  it("one user per customer: another user's customer id is refused", async () => {
    const a = await freshUser("planner");
    const b = await freshUser("planner");
    const shared = await mapCustomer(a.user.id);
    const { error } = await serviceRole.rpc("record_billing_customer", { target_user_id: b.user.id, stripe_customer_id: shared });
    expect(error?.message).toBe("billing_customer_conflict");
  });

  it("malformed customer ids are refused", async () => {
    const { user } = await freshUser("planner");
    const { error } = await serviceRole.rpc("record_billing_customer", { target_user_id: user.id, stripe_customer_id: "acct_123" });
    expect(error?.message).toBe("billing_customer_invalid");
  });

  it("the mapping is immutable for every role (even the superuser)", async () => {
    const { user } = await freshUser("planner");
    await mapCustomer(user.id);
    expect(await sqlError("update public.billing_customers set stripe_customer_id = $2 where user_id = $1", [user.id, customerId()])).toBe(GUARD);
    expect(await sqlError("delete from public.billing_customers where user_id = $1", [user.id])).toBe(GUARD);
  });

  it("works through the server-only recorder module (the intended path)", async () => {
    const { user } = await freshUser("couple");
    const recorder = createBillingCustomerRecorder({ supabaseUrl: ctx.apiUrl, serviceRoleKey: ctx.secretKey });
    const id = customerId();
    expect(await recorder.record({ userId: user.id, stripeCustomerId: id })).toBe(id);
    expect(await recorder.record({ userId: user.id, stripeCustomerId: customerId() })).toBe(id);
  });
});

// ---------------------------------------------------- planner subscriptions

describe("planner subscriptions → planner_pro", () => {
  async function plannerWithCustomer() {
    const { user, client } = await freshUser("planner");
    return { user, client, customer: await mapCustomer(user.id) };
  }

  it.each<[SubStatus, "active" | "inactive"]>([
    ["active", "active"],
    ["trialing", "active"],
    ["past_due", "inactive"],
    ["unpaid", "inactive"],
    ["canceled", "inactive"],
    ["incomplete", "inactive"],
    ["incomplete_expired", "inactive"],
    ["paused", "inactive"],
  ])("a %s subscription → entitlement %s", async (status, expected) => {
    const { user, customer } = await plannerWithCustomer();
    expect(await applySub(subArgs(user.id, customer, subscriptionId(), { subscription_status: status }))).toBe("applied");
    expect(await entitlement(user.id, "planner_pro")).toBe(expected);
  });

  it("active → past_due revokes (no grace period); → active again restores", async () => {
    const { user, customer } = await plannerWithCustomer();
    const sub = subscriptionId();
    await applySub(subArgs(user.id, customer, sub, { subscription_status: "active" }));
    expect(await entitlement(user.id, "planner_pro")).toBe("active");
    await applySub(subArgs(user.id, customer, sub, { subscription_status: "past_due" }));
    expect(await entitlement(user.id, "planner_pro")).toBe("inactive");
    await applySub(subArgs(user.id, customer, sub, { subscription_status: "active" }));
    expect(await entitlement(user.id, "planner_pro")).toBe("active");
  });

  it("canceled removes the entitlement; the user can read the result, not change it", async () => {
    const { user, client, customer } = await plannerWithCustomer();
    const sub = subscriptionId();
    await applySub(subArgs(user.id, customer, sub, { subscription_status: "active" }));
    await applySub(subArgs(user.id, customer, sub, { subscription_status: "canceled", event_type: "customer.subscription.deleted" }));
    expect(await entitlement(user.id, "planner_pro")).toBe("inactive");
    const { data } = await client.from("billing_entitlements").select("entitlement_key, status, source");
    expect(data).toEqual([{ entitlement_key: "planner_pro", status: "inactive", source: "subscription" }]);
  });

  it("a replayed event id is a duplicate: no second effect, one ledger row", async () => {
    const { user, customer } = await plannerWithCustomer();
    const sub = subscriptionId();
    const args = subArgs(user.id, customer, sub, { subscription_status: "active" });
    expect(await applySub(args)).toBe("applied");
    // Same event id, even with a different (forged/stale) state: ignored as duplicate.
    expect(await applySub({ ...args, subscription_status: "canceled", observed_at: nextObservation() })).toBe("duplicate");
    expect((await storedSubscription(sub))?.status).toBe("active");
    expect(await entitlement(user.id, "planner_pro")).toBe("active");
    expect(await sql("select 1 from public.stripe_webhook_events where stripe_event_id = $1", [args.stripe_event_id])).toHaveLength(1);
    expect(await sql("select 1 from public.billing_subscriptions where stripe_subscription_id = $1", [sub])).toHaveLength(1);
  });

  it("concurrent deliveries of one event are processed once", async () => {
    const { user, customer } = await plannerWithCustomer();
    const args = subArgs(user.id, customer, subscriptionId());
    const outcomes = await Promise.all([applySub(args), applySub(args), applySub(args)]);
    expect(outcomes.filter((o) => o === "applied")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(2);
  });

  it("an OLDER observation arriving late is stale and can't revive access", async () => {
    const { user, customer } = await plannerWithCustomer();
    const sub = subscriptionId();
    const olderActive = subArgs(user.id, customer, sub, { subscription_status: "active" });
    const newerUnpaid = subArgs(user.id, customer, sub, { subscription_status: "unpaid" });
    // The newer state lands first; the older "active" observation arrives after.
    expect(await applySub(newerUnpaid)).toBe("applied");
    expect(await applySub(olderActive)).toBe("stale");
    expect((await storedSubscription(sub))?.status).toBe("unpaid");
    expect(await entitlement(user.id, "planner_pro")).toBe("inactive");
    expect((await eventRow(olderActive.stripe_event_id))?.outcome).toBe("stale");
  });

  it("canceled is terminal: even a NEWER 'active' observation never revives it", async () => {
    const { user, customer } = await plannerWithCustomer();
    const sub = subscriptionId();
    await applySub(subArgs(user.id, customer, sub, { subscription_status: "canceled" }));
    expect(await applySub(subArgs(user.id, customer, sub, { subscription_status: "active" }))).toBe("stale");
    expect(await entitlement(user.id, "planner_pro")).toBe("inactive");
  });

  it("a canceled old subscription doesn't hide a new active one (any granting subscription grants)", async () => {
    const { user, customer } = await plannerWithCustomer();
    await applySub(subArgs(user.id, customer, subscriptionId(), { subscription_status: "canceled" }));
    await applySub(subArgs(user.id, customer, subscriptionId(), { subscription_status: "active" }));
    expect(await entitlement(user.id, "planner_pro")).toBe("active");
  });

  it("unknown customer or mismatched metadata user → ignored (recorded, nothing granted)", async () => {
    const { user, customer } = await plannerWithCustomer();
    const stranger = subArgs(user.id, customerId(), subscriptionId());
    expect(await applySub(stranger)).toBe("ignored");
    expect((await eventRow(stranger.stripe_event_id))?.outcome).toBe("ignored");
    const other = await freshUser("planner");
    expect(await applySub(subArgs(other.user.id, customer, subscriptionId()))).toBe("ignored");
    expect(await entitlement(user.id, "planner_pro")).toBeNull();
  });

  it("account type mapping: a planner subscription never grants a COUPLE account", async () => {
    const { user } = await freshUser("couple");
    const customer = await mapCustomer(user.id);
    expect(await applySub(subArgs(user.id, customer, subscriptionId(), { subscription_status: "active" }))).toBe("applied");
    expect(await entitlement(user.id, "planner_pro")).toBe("inactive");
  });

  it("subscriptions are planner_pro only and Stripe ids are unique", async () => {
    const { user, customer } = await plannerWithCustomer();
    const { error } = await serviceRole.rpc(
      "apply_stripe_subscription_event",
      subArgs(user.id, customer, subscriptionId(), { entitlement_key: "couple_access" }),
    );
    expect(error?.message).toBe("stripe_event_invalid");
    const sub = subscriptionId();
    await applySub(subArgs(user.id, customer, sub));
    const dup = await sqlError(
      `insert into public.billing_subscriptions (user_id, stripe_customer_id, stripe_subscription_id, entitlement_key, status, stripe_observed_at)
       values ($1, $2, $3, 'planner_pro', 'active', now())`,
      [user.id, customer, sub],
    );
    expect(dup).toBe(UNIQUE_VIOLATION);
  });

  it("identity columns are immutable and the event ledger is append-only (every role)", async () => {
    const { user, customer } = await plannerWithCustomer();
    const sub = subscriptionId();
    const args = subArgs(user.id, customer, sub);
    await applySub(args);
    expect(await sqlError("update public.billing_subscriptions set stripe_subscription_id = $2 where stripe_subscription_id = $1", [sub, subscriptionId()])).toBe(GUARD);
    expect(await sqlError("update public.stripe_webhook_events set outcome = 'ignored' where stripe_event_id = $1", [args.stripe_event_id])).toBe(GUARD);
    expect(await sqlError("delete from public.stripe_webhook_events where stripe_event_id = $1", [args.stripe_event_id])).toBe(GUARD);
  });
});

// ------------------------------------------------------- couple purchases

describe("couple one-time purchase → couple_access", () => {
  async function coupleWithCustomer() {
    const { user, client } = await freshUser("couple");
    return { user, client, customer: await mapCustomer(user.id) };
  }

  it("a confirmed (paid) purchase grants durable couple_access", async () => {
    const { user, customer } = await coupleWithCustomer();
    expect(await applyPay(payArgs(user.id, customer, sessionId()))).toBe("applied");
    expect(await entitlement(user.id, "couple_access")).toBe("active");
    const [purchase] = await purchasesOf(user.id);
    expect(purchase.status).toBe("paid");
    expect(purchase.purchased_at).toBeInstanceOf(Date);
  });

  it("BILLING-02: a 100%-off purchase (paid, NO payment intent) grants durable couple_access", async () => {
    const { user, customer } = await coupleWithCustomer();
    expect(await applyPay(payArgs(user.id, customer, sessionId(), { stripe_payment_intent_id: undefined }))).toBe("applied");
    expect(await entitlement(user.id, "couple_access")).toBe("active");
    const [purchase] = await purchasesOf(user.id);
    expect(purchase.status).toBe("paid");
    expect(purchase.stripe_payment_intent_id).toBeNull();
    expect(purchase.purchased_at).toBeInstanceOf(Date);
  });

  it("pending (delayed method) and failed purchases never grant", async () => {
    const { user, customer } = await coupleWithCustomer();
    await applyPay(payArgs(user.id, customer, sessionId(), { payment_status: "pending" }));
    expect(await entitlement(user.id, "couple_access")).toBe("inactive");
    await applyPay(payArgs(user.id, customer, sessionId(), { payment_status: "failed", event_type: "checkout.session.async_payment_failed" }));
    expect(await entitlement(user.id, "couple_access")).toBe("inactive");
  });

  it("pending → paid (async_payment_succeeded) grants; one purchase row per session", async () => {
    const { user, customer } = await coupleWithCustomer();
    const session = sessionId();
    await applyPay(payArgs(user.id, customer, session, { payment_status: "pending" }));
    expect(
      await applyPay(payArgs(user.id, customer, session, { payment_status: "paid", event_type: "checkout.session.async_payment_succeeded" })),
    ).toBe("applied");
    expect(await purchasesOf(user.id)).toHaveLength(1);
    expect(await entitlement(user.id, "couple_access")).toBe("active");
  });

  it("paid is final: a later failed/pending observation changes nothing (durable)", async () => {
    const { user, customer } = await coupleWithCustomer();
    const session = sessionId();
    await applyPay(payArgs(user.id, customer, session));
    expect(await applyPay(payArgs(user.id, customer, session, { payment_status: "failed", event_type: "checkout.session.async_payment_failed" }))).toBe("no_change");
    expect(await applyPay(payArgs(user.id, customer, session, { payment_status: "pending" }))).toBe("no_change");
    expect((await purchasesOf(user.id))[0].status).toBe("paid");
    expect(await entitlement(user.id, "couple_access")).toBe("active");
    // Even the superuser can't move a paid purchase back.
    expect(await sqlError("update public.billing_purchases set status = 'failed', purchased_at = null where user_id = $1", [user.id])).toBe(GUARD);
  });

  it("a replayed event can't duplicate the purchase or the entitlement", async () => {
    const { user, customer } = await coupleWithCustomer();
    const args = payArgs(user.id, customer, sessionId());
    const outcomes = await Promise.all([applyPay(args), applyPay(args)]);
    expect(outcomes.sort()).toEqual(["applied", "duplicate"]);
    expect(await applyPay(args)).toBe("duplicate");
    expect(await purchasesOf(user.id)).toHaveLength(1);
    expect(await sql("select 1 from public.billing_entitlements where user_id = $1", [user.id])).toHaveLength(1);
  });

  it("account type mapping: a couple purchase never grants a PLANNER account", async () => {
    const { user } = await freshUser("planner");
    const customer = await mapCustomer(user.id);
    expect(await applyPay(payArgs(user.id, customer, sessionId()))).toBe("applied");
    expect(await entitlement(user.id, "couple_access")).toBe("inactive");
  });

  it("checkout session and payment intent ids are unique", async () => {
    const { user, customer } = await coupleWithCustomer();
    const args = payArgs(user.id, customer, sessionId());
    await applyPay(args);
    const reusedIntent = await serviceRole.rpc(
      "apply_stripe_checkout_payment_event",
      payArgs(user.id, customer, sessionId(), { stripe_payment_intent_id: args.stripe_payment_intent_id }),
    );
    expect(reusedIntent.error?.code).toBe(UNIQUE_VIOLATION);
  });

  it("works through the server-only webhook store module", async () => {
    const { user, customer } = await coupleWithCustomer();
    const store = createBillingWebhookStore({ supabaseUrl: ctx.apiUrl, serviceRoleKey: ctx.secretKey });
    const result = await store.applyCheckoutPayment({
      eventId: eventId(),
      eventType: "checkout.session.completed",
      livemode: false,
      createdAt: new Date().toISOString(),
      customerId: customer,
      checkoutSessionId: sessionId(),
      paymentIntentId: null,
      priceId: null,
      metadataUserId: user.id,
      paymentStatus: "paid",
    });
    expect(result).toBe("applied");
    expect(await entitlement(user.id, "couple_access")).toBe("active");
  });
});

// ---------------------------------------------- the route, end to end

describe("POST /api/stripe/webhook against the local database", () => {
  beforeAll(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ctx.apiUrl);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", ctx.publishableKey);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", ctx.secretKey);
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", TEST_STRIPE_WEBHOOK_SECRET);
  });
  afterAll(() => vi.unstubAllEnvs());
  afterEach(() => {
    gatewayRef.current = null;
  });

  function post(type: string, objectId: string, id = eventId()) {
    const signed = signStripeEvent(stripeEventBody({ id, type, object: { id: objectId } }));
    return route.POST(new NextRequest("http://localhost:3100/api/stripe/webhook", { method: "POST", headers: signed.headers, body: signed.body }));
  }

  it("a signed subscription event activates planner_pro from the RETRIEVED state; replay is harmless", async () => {
    const { user } = await freshUser("planner");
    const customer = await mapCustomer(user.id);
    const sub = subscriptionId();
    const gateway = fakeGateway();
    gateway.subscriptions.set(sub, subscriptionSnapshot({ id: sub, customerId: customer, metadata: { userId: user.id, entitlementKey: "planner_pro" } }));
    gatewayRef.current = gateway;

    const id = eventId();
    expect((await post("customer.subscription.created", sub, id)).status).toBe(200);
    expect(await entitlement(user.id, "planner_pro")).toBe("active");
    expect((await post("customer.subscription.created", sub, id)).status).toBe(200);
    expect((await eventRow(id))?.outcome).toBe("applied");
  });

  it("a signed paid checkout grants couple_access; a forged signature changes nothing", async () => {
    const { user } = await freshUser("couple");
    const customer = await mapCustomer(user.id);
    const session = sessionId();
    const gateway = fakeGateway();
    gateway.checkoutSessions.set(
      session,
      checkoutSessionSnapshot({ id: session, customerId: customer, paymentIntentId: null, metadata: { userId: user.id, entitlementKey: "couple_access" } }),
    );
    gatewayRef.current = gateway;

    const forged = signStripeEvent(stripeEventBody({ id: eventId(), type: "checkout.session.completed", object: { id: session } }), {
      secret: "whsec_TEST_ONLY_forger_webhook_secret_0002",
    });
    const refused = await route.POST(
      new NextRequest("http://localhost:3100/api/stripe/webhook", { method: "POST", headers: forged.headers, body: forged.body }),
    );
    expect(refused.status).toBe(401);
    expect(await entitlement(user.id, "couple_access")).toBeNull();

    expect((await post("checkout.session.completed", session)).status).toBe(200);
    expect(await entitlement(user.id, "couple_access")).toBe("active");
  });
});

// ------------------------------------------ non-billing RLS unaffected

describe("existing application access is unaffected", () => {
  it("a paid planner gets no access to a wedding they're not a member of", async () => {
    const owner = await freshUser("planner");
    const paid = await freshUser("planner");
    const customer = await mapCustomer(paid.user.id);
    await applySub(subArgs(paid.user.id, customer, subscriptionId(), { subscription_status: "active" }));
    expect(await entitlement(paid.user.id, "planner_pro")).toBe("active");

    const { data, error } = await owner.client.rpc("create_wedding", { wedding_name: "Boda de prueba Billing" });
    if (error || !data) throw new Error(`create_wedding failed: ${error?.message}`);
    createdWeddingIds.push(data.id);
    const read = await paid.client.from("weddings").select("id").eq("id", data.id);
    expect(read.error).toBeNull();
    expect(read.data).toEqual([]);
  });

  it("an unpaid account still creates its wedding (no gating in BILLING-01)", async () => {
    const id = await createWedding("ownerA", "Boda sin pago");
    createdWeddingIds.push(id);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ------------------------------------- QA-03a: scheduled cancellation (cancel_at)

describe("billing_subscriptions.cancel_at (QA-03a)", () => {
  async function plannerWithCustomer() {
    const { user, client } = await freshUser("planner");
    return { user, client, customer: await mapCustomer(user.id) };
  }

  async function stored(sub: string) {
    const rows = await sql<{ status: SubStatus; cancel_at: Date | null; cancel_at_period_end: boolean }>(
      `select status::text as status, cancel_at, cancel_at_period_end
       from public.billing_subscriptions where stripe_subscription_id = $1`,
      [sub],
    );
    return rows[0] ?? null;
  }

  /** EXACTLY the arguments the webhook deployed before this migration sends (no cancel_at key). */
  function deployedWebhookArgs(userId: string, customer: string, sub: string, overrides: Partial<SubArgs> = {}): SubArgs {
    const args = subArgs(userId, customer, sub, overrides);
    expect(Object.keys(args)).not.toContain("cancel_at");
    return args;
  }

  const CANCEL_AT = "2026-12-01T12:00:00.000Z";

  it("one apply_stripe_subscription_event only (no overload), SECURITY DEFINER, executable by service_role alone", async () => {
    const rows = await sql<{ sig: string; definer: boolean; anon: boolean; authed: boolean; service: boolean }>(
      `select p.oid::regprocedure::text as sig, p.prosecdef as definer,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authed,
              has_function_privilege('service_role', p.oid, 'execute') as service
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'apply_stripe_subscription_event'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ definer: true, anon: false, authed: false, service: true });
    expect(rows[0].sig).toMatch(/,timestamp with time zone,timestamp with time zone\)$/);
    const column = await sql<{ data_type: string; is_nullable: string }>(
      `select data_type, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'billing_subscriptions' and column_name = 'cancel_at'`,
    );
    expect(column).toEqual([{ data_type: "timestamp with time zone", is_nullable: "YES" }]);
  });

  it("the DEPLOYED webhook's call shape still works after the migration and stores no cancel_at", async () => {
    const { user, customer } = await plannerWithCustomer();
    const sub = subscriptionId();
    expect(await applySub(deployedWebhookArgs(user.id, customer, sub))).toBe("applied");
    expect(await stored(sub)).toEqual({ status: "active", cancel_at: null, cancel_at_period_end: false });
    expect(await entitlement(user.id, "planner_pro")).toBe("active");
    // …and its later events keep working (status changes, deletion) exactly as before.
    expect(await applySub(deployedWebhookArgs(user.id, customer, sub, { cancel_at_period_end: true }))).toBe("applied");
    expect(await applySub(deployedWebhookArgs(user.id, customer, sub, { subscription_status: "canceled" }))).toBe("applied");
    expect(await entitlement(user.id, "planner_pro")).toBe("inactive");
  });

  it("the deployed webhook (no cancel_at) never clears one the new webhook stored", async () => {
    const { user, customer } = await plannerWithCustomer();
    const sub = subscriptionId();
    await applySub(subArgs(user.id, customer, sub, { cancel_at: CANCEL_AT }));
    expect(await applySub(deployedWebhookArgs(user.id, customer, sub))).toBe("no_change");
    expect((await stored(sub))?.cancel_at?.toISOString()).toBe(CANCEL_AT);
  });

  it("the new webhook stores, changes and clears it ('infinity' or null = none scheduled)", async () => {
    const { user, customer } = await plannerWithCustomer();
    const sub = subscriptionId();
    expect(await applySub(subArgs(user.id, customer, sub, { cancel_at: CANCEL_AT }))).toBe("applied");
    expect((await stored(sub))?.cancel_at?.toISOString()).toBe(CANCEL_AT);
    // Same value: nothing changed. Only cancel_at changing: applied.
    expect(await applySub(subArgs(user.id, customer, sub, { cancel_at: CANCEL_AT }))).toBe("no_change");
    expect(await applySub(subArgs(user.id, customer, sub, { cancel_at: "2027-02-01T12:00:00.000Z" }))).toBe("applied");
    expect(await applySub(subArgs(user.id, customer, sub, { cancel_at: "infinity" }))).toBe("applied");
    expect((await stored(sub))?.cancel_at).toBeNull();
    await applySub(subArgs(user.id, customer, sub, { cancel_at: CANCEL_AT }));
    // A JSON null (which the generated Args type doesn't allow) is read as "none scheduled" too.
    const viaNull = await serviceRole.rpc("apply_stripe_subscription_event", {
      ...subArgs(user.id, customer, sub),
      cancel_at: null as unknown as string,
    });
    expect(viaNull.data).toBe("applied");
    expect((await stored(sub))?.cancel_at).toBeNull();
  });

  it("a scheduled cancellation never changes access: still active until Stripe says canceled", async () => {
    const { user, customer } = await plannerWithCustomer();
    const sub = subscriptionId();
    await applySub(subArgs(user.id, customer, sub, { cancel_at: CANCEL_AT, cancel_at_period_end: false }));
    expect(await entitlement(user.id, "planner_pro")).toBe("active");
    await applySub(subArgs(user.id, customer, sub, { subscription_status: "canceled", cancel_at: CANCEL_AT }));
    expect(await entitlement(user.id, "planner_pro")).toBe("inactive");
    // Terminal: a newer "active" observation (with or without a schedule) never revives it.
    expect(await applySub(subArgs(user.id, customer, sub, { subscription_status: "active", cancel_at: "infinity" }))).toBe("stale");
    expect(await stored(sub)).toMatchObject({ status: "canceled" });
    expect(await entitlement(user.id, "planner_pro")).toBe("inactive");
  });

  it("an OLDER observation can't overwrite a newer cancel_at (stale), and replays are duplicates", async () => {
    const { user, customer } = await plannerWithCustomer();
    const sub = subscriptionId();
    const older = nextObservation();
    const newer = subArgs(user.id, customer, sub, { cancel_at: CANCEL_AT });
    await applySub(newer);
    expect(await applySub(subArgs(user.id, customer, sub, { cancel_at: "infinity", observed_at: older }))).toBe("stale");
    expect(await applySub({ ...newer, cancel_at: "infinity" })).toBe("duplicate");
    expect((await stored(sub))?.cancel_at?.toISOString()).toBe(CANCEL_AT);
  });

  it("the owner reads their own cancel_at through the Data API; nobody can write it", async () => {
    const { user, client, customer } = await plannerWithCustomer();
    const sub = subscriptionId();
    await applySub(subArgs(user.id, customer, sub, { cancel_at: CANCEL_AT }));
    const read = await client.from("billing_subscriptions").select("cancel_at");
    expect(read.error).toBeNull();
    expect(read.data?.map((r) => (r.cancel_at ? new Date(r.cancel_at).toISOString() : null))).toEqual([CANCEL_AT]);
    const write = await client.from("billing_subscriptions").update({ cancel_at: null }).eq("user_id", user.id);
    expect(write.error?.code).toBe(PERMISSION_DENIED);
    expect((await stored(sub))?.cancel_at?.toISOString()).toBe(CANCEL_AT);
    const other = await freshUser("planner");
    expect((await other.client.from("billing_subscriptions").select("cancel_at")).data).toEqual([]);
  });

  it("works through the server-only webhook store module (the new caller)", async () => {
    const { user, customer } = await plannerWithCustomer();
    const sub = subscriptionId();
    const store = createBillingWebhookStore({ supabaseUrl: ctx.apiUrl, serviceRoleKey: ctx.secretKey });
    const base = {
      eventType: "customer.subscription.updated",
      livemode: false,
      createdAt: new Date().toISOString(),
      customerId: customer,
      subscriptionId: sub,
      priceId: "price_TESTONLYplanner",
      metadataUserId: user.id,
      status: "active" as const,
      currentPeriodEnd: "2026-11-16T12:00:00.000Z",
      cancelAtPeriodEnd: false,
    };
    expect(await store.applySubscription({ ...base, eventId: eventId(), cancelAt: CANCEL_AT, observedAt: nextObservation() })).toBe("applied");
    expect((await stored(sub))?.cancel_at?.toISOString()).toBe(CANCEL_AT);
    expect(await store.applySubscription({ ...base, eventId: eventId(), cancelAt: null, observedAt: nextObservation() })).toBe("applied");
    expect((await stored(sub))?.cancel_at).toBeNull();
    expect(await entitlement(user.id, "planner_pro")).toBe("active");
  });
});
