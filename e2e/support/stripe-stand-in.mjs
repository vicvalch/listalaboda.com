// A LOCAL, test-only stand-in for the few Stripe API calls BILLING-01 makes
// (ADR-021 §13). The app under test reaches it only through the real Stripe
// SDK with STRIPE_API_BASE (accepted only with a localhost APP_ORIGIN), so
// production code paths are unchanged and no test ever calls Stripe.
//
// Models only what BILLING-01/02 need, in memory:
//   POST /v1/customers                       (Idempotency-Key → same customer)
//   POST /v1/checkout/sessions               (hosted URL served below)
//   GET  /v1/checkout/sessions/:id           (expand[]=line_items)
//   GET  /v1/subscriptions/:id
//   POST /v1/billing_portal/sessions
// plus browser pages for the hosted Checkout / Portal and /__e2e/* controls
// the journeys use to "pay" and to inspect what the app asked for.
// Never started outside the Playwright run; binds to 127.0.0.1 only.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.STRIPE_STAND_IN_PORT ?? 12117);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const customers = new Map();
const idempotency = new Map();
const sessions = new Map();
const subscriptions = new Map();
const portalSessions = [];

const id = (prefix) => `${prefix}_e2e${randomBytes(9).toString("hex")}`;
const now = () => Math.floor(Date.now() / 1000);

/** Stripe's form encoding (`a[b][0][c]=v`) → nested objects/arrays. */
function parseForm(body) {
  const out = {};
  for (const [key, value] of new URLSearchParams(body)) {
    const path = key.replace(/\]/g, "").split("[");
    let node = out;
    path.forEach((part, index) => {
      const last = index === path.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(path[index + 1]);
      if (last) node[part] = value;
      else node = node[part] ??= nextIsIndex ? [] : {};
    });
  }
  return out;
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function missing(res, what) {
  json(res, 404, { error: { type: "invalid_request_error", code: "resource_missing", message: `No such ${what}` } });
}

function html(res, title) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
}

function sessionObject(session, expandLineItems) {
  const { lineItems, ...rest } = session;
  return expandLineItems ? { ...rest, line_items: { object: "list", data: lineItems } } : rest;
}

function subscriptionObject(sub) {
  return {
    id: sub.id,
    object: "subscription",
    customer: sub.customer,
    status: sub.status,
    cancel_at_period_end: sub.cancel_at_period_end,
    // QA-03a: Stripe's scheduled cancellation timestamp (Unix seconds) or null.
    cancel_at: sub.cancel_at ?? null,
    metadata: sub.metadata,
    items: { object: "list", data: [{ id: `si_${sub.id}`, price: { id: sub.price }, current_period_end: sub.current_period_end }] },
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", ORIGIN);
  const body = await readBody(req);
  const path = url.pathname;
  const auth = req.headers.authorization ?? "";

  // ---- browser pages (the "hosted" Checkout and Portal)
  if (req.method === "GET" && path.startsWith("/checkout/")) return html(res, "Stand-in Checkout");
  if (req.method === "GET" && path.startsWith("/portal/")) return html(res, "Stand-in Portal");
  if (req.method === "GET" && path === "/") return json(res, 200, { ok: true });

  // ---- test controls
  if (path.startsWith("/__e2e/")) {
    if (req.method === "GET" && path === "/__e2e/sessions") return json(res, 200, [...sessions.values()]);
    if (req.method === "GET" && path === "/__e2e/portal-sessions") return json(res, 200, portalSessions);
    const complete = /^\/__e2e\/sessions\/([^/]+)\/complete$/.exec(path);
    if (req.method === "POST" && complete) {
      const session = sessions.get(complete[1]);
      if (!session) return missing(res, "checkout session");
      // BILLING-02: `amountTotal` (after a promotion code) and `no_payment_required` model a
      // 100%-off Checkout, which completes WITHOUT a PaymentIntent, like Stripe.
      const { paymentStatus = "paid", amountTotal = null } = body ? JSON.parse(body) : {};
      session.status = "complete";
      session.payment_status = paymentStatus;
      session.amount_total = amountTotal;
      if (session.mode === "subscription" && !session.subscription) {
        const sub = {
          id: id("sub"),
          customer: session.customer,
          // A trial Checkout starts the subscription in trialing, like Stripe.
          status: session.trial_period_days ? "trialing" : "active",
          cancel_at_period_end: false,
          cancel_at: null,
          metadata: session.subscriptionMetadata ?? {},
          price: session.lineItems[0]?.price.id ?? null,
          current_period_end: now() + 30 * 24 * 3600,
        };
        subscriptions.set(sub.id, sub);
        session.subscription = sub.id;
      }
      if (session.mode === "payment" && paymentStatus !== "no_payment_required") {
        session.payment_intent = session.payment_intent ?? id("pi");
      }
      return json(res, 200, sessionObject(session, true));
    }
    const setSub = /^\/__e2e\/subscriptions\/([^/]+)$/.exec(path);
    if (req.method === "POST" && setSub) {
      const sub = subscriptions.get(setSub[1]);
      if (!sub) return missing(res, "subscription");
      Object.assign(sub, JSON.parse(body));
      return json(res, 200, subscriptionObject(sub));
    }
    return missing(res, "control");
  }

  // ---- the Stripe API (secret key required, like Stripe)
  if (!/^Bearer sk_test_/.test(auth)) {
    return json(res, 401, { error: { type: "invalid_request_error", message: "Invalid API Key provided" } });
  }

  if (req.method === "POST" && path === "/v1/customers") {
    const key = req.headers["idempotency-key"];
    if (key && idempotency.has(key)) return json(res, 200, customers.get(idempotency.get(key)));
    const params = parseForm(body);
    const customer = { id: id("cus"), object: "customer", metadata: params.metadata ?? {} };
    customers.set(customer.id, customer);
    if (key) idempotency.set(key, customer.id);
    return json(res, 200, customer);
  }

  if (req.method === "POST" && path === "/v1/checkout/sessions") {
    const params = parseForm(body);
    if (!customers.has(params.customer)) return missing(res, "customer");
    const sessionId = id("cs_test");
    const session = {
      id: sessionId,
      object: "checkout.session",
      mode: params.mode,
      status: "open",
      payment_status: "unpaid",
      customer: params.customer,
      client_reference_id: params.client_reference_id ?? null,
      success_url: params.success_url,
      cancel_url: params.cancel_url,
      locale: params.locale ?? null,
      metadata: params.metadata ?? {},
      // BILLING-02: what the app asked for, as Stripe would receive it.
      allow_promotion_codes: params.allow_promotion_codes ?? null,
      payment_method_collection: params.payment_method_collection ?? null,
      trial_period_days: params.subscription_data?.trial_period_days ? Number(params.subscription_data.trial_period_days) : null,
      discounts: params.discounts ?? null,
      // Batch 1: the fixed message shown above Checkout's pay button.
      custom_text: params.custom_text ?? null,
      amount_total: null,
      subscriptionMetadata: params.subscription_data?.metadata ?? null,
      paymentIntentMetadata: params.payment_intent_data?.metadata ?? null,
      subscription: null,
      payment_intent: null,
      url: `${ORIGIN}/checkout/${sessionId}`,
      lineItems: (params.line_items ?? []).map((item, index) => ({
        id: `li_${sessionId}_${index}`,
        price: { id: item.price },
        quantity: Number(item.quantity),
      })),
    };
    sessions.set(sessionId, session);
    return json(res, 200, sessionObject(session, false));
  }

  const getSession = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(path);
  if (req.method === "GET" && getSession) {
    const session = sessions.get(getSession[1]);
    if (!session) return missing(res, "checkout session");
    return json(res, 200, sessionObject(session, url.searchParams.getAll("expand[]").includes("line_items")));
  }

  const getSub = /^\/v1\/subscriptions\/([^/]+)$/.exec(path);
  if (req.method === "GET" && getSub) {
    const sub = subscriptions.get(getSub[1]);
    return sub ? json(res, 200, subscriptionObject(sub)) : missing(res, "subscription");
  }

  if (req.method === "POST" && path === "/v1/billing_portal/sessions") {
    const params = parseForm(body);
    if (!customers.has(params.customer)) return missing(res, "customer");
    const portal = { id: id("bps"), object: "billing_portal.session", customer: params.customer, return_url: params.return_url };
    portalSessions.push(portal);
    return json(res, 200, { ...portal, url: `${ORIGIN}/portal/${portal.id}` });
  }

  return missing(res, `route ${req.method} ${path}`);
});

server.listen(PORT, "127.0.0.1");
