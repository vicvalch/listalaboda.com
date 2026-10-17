# ADR-021 — Stripe Billing and Persistent Entitlements

Status: Proposed (BILLING-01, awaiting review) · Date: 2026-10-16
Related: [Product Constitution §11](../product/PRODUCT-CONSTITUTION.md), [ADR-002 §6](ADR-002-auth-and-security-boundaries.md),
[ADR-017 §10](ADR-017-dual-couple-planner-use.md), [ADR-020](ADR-020-immutable-account-type.md),
[ADR-011 §7](ADR-011-email-delivery-observability.md) (the webhook pattern this follows)
Amends: Product Constitution §11 ("COMMERCIAL MODEL DEFERRED", dated amendment there); ADR-002 §6 (two more
service-role modules, dated note there). Everything else stands.

## Context

The product owner froze the commercial model for architecture (BILLING-01): a **planner** account pays a recurring
**monthly subscription**; a **couple** account makes a **one-time payment**. Exact amounts and currencies are NOT frozen
and must not appear in code. The product must become *payment-ready* — able to sell, and to know durably who paid —
without locking any existing feature behind payment (no gating policy exists yet).

## Decision

### 1. Responsibilities

| Stripe | ListaLaBoda database |
|---|---|
| Hosted Checkout (the payment page; we never see card data) | One Stripe Customer per user (`billing_customers`) |
| Payment processing, receipts, delayed payment methods | Subscriptions as last reconciled (`billing_subscriptions`) |
| Subscription lifecycle (renewals, retries, cancellation) | One-time purchases (`billing_purchases`) |
| Customer Portal (planners manage their subscription) | Processed webhook events (`stripe_webhook_events`) |
| Signed webhook delivery | Semantic entitlements the app reads (`billing_entitlements`) |
| Prices, amounts, currencies (configuration) | — |

Stripe is the payment processor; **our database is the application's durable access state**. Authorization-sensitive
code reads the database (`@/lib/billing/entitlements`), never Stripe on a request.

### 2. Commercial mapping (server-side only)

| Account type | Entitlement key | Checkout mode | Price (configuration) |
|---|---|---|---|
| `planner` | `planner_pro` | `subscription` | `STRIPE_PLANNER_MONTHLY_PRICE_ID` |
| `couple` | `couple_access` | `payment` | `STRIPE_COUPLE_ONE_TIME_PRICE_ID` |
| untyped | — | none: `requireAccountType` sends the account to `/onboarding/account-type` | — |

`BILLING_PLANS` (`@/lib/billing/plans`) is the only mapping. The account type is loaded on the server from
`user_accounts` (immutable, ADR-020). The browser sends **nothing**: no price id, amount, currency, product, mode,
entitlement, customer or user id (the two Server Actions take no input). An invited untyped collaborator keeps
collaborating under SIT-01, unchanged, but can't buy until they choose a type.

### 3. Checkout

`startCheckoutAction` → `requireAccountType("/app/billing")` → `startBillingCheckout`:
configuration (else `not_available`) → entitlement already active (`already_active`) → planner with a subscription still
alive in Stripe (`manage_existing`: fix it in the portal; never a second subscription) → customer (§5) → ONE hosted
Checkout Session with `customer`, `client_reference_id`, one line item (configured price), `success_url`/`cancel_url`
from `APP_ORIGIN` (`/app/billing/success`, `/app/billing/cancel`), `locale: es`, and metadata `lb_user_id`,
`lb_account_type`, `lb_entitlement` on the session and on the subscription (`subscription_data`) or payment intent
(`payment_intent_data`). Metadata carries ids and closed values only, never personal data. No publishable key exists.

### 4. Entitlement keys, not price ids

Application code reasons about `planner_pro` / `couple_access` (enum `billing_entitlement_key`). Price ids are billing
configuration: stored on rows for audit, never compared for authorization. A Stripe object grants only when it carries
OUR metadata (`lb_entitlement`, `lb_user_id`) and its customer is mapped to that same user — so subscriptions or payment
links created by hand in the Stripe dashboard never grant. A key only counts for its own account type
(`planner_pro` → planner, `couple_access` → couple), checked inside the database.

### 5. Customer mapping (no duplicates)

`ensureBillingCustomer`: read the caller's own `billing_customers` row (RLS) → none → `customers.create` with the
idempotency key `lb-billing-customer:<user id>` (concurrent starts get the SAME customer back from Stripe within its
24 h key window) → `record_billing_customer` (service_role-only; locks the user's `user_accounts` row; refuses untyped
accounts with `account_type_required`; `ON CONFLICT (user_id) DO NOTHING`; returns the STORED id, which the caller
uses). `stripe_customer_id` is UNIQUE (one user per customer; another user's id → `billing_customer_conflict`) and
`user_id` is the primary key (one customer per user). The mapping is immutable for every role; it is deleted only by the
`auth.users` cascade. An extra Stripe customer can only appear if a start fails after Stripe and before the record and
the next start is > 24 h later; it is never used.

### 6. Webhook authority, idempotency, replay, order

`POST /api/stripe/webhook` is the ONLY path that grants or revokes paid access.

- **Signature first.** Configuration (503) → raw body ≤ 256 KiB (413) → `Stripe.webhooks.constructEvent` over the RAW
  body with `STRIPE_WEBHOOK_SECRET` (± 5 min tolerance; 401 on any failure) → only then the envelope is read. No
  cookies or session; excluded from the session proxy; empty `no-store` responses; nothing logged.
- **Events handled** (the endpoint should subscribe to exactly these):

  | Event | Why |
  |---|---|
  | `customer.subscription.created` / `.updated` / `.deleted` | the planner subscription's lifecycle (renewal, `past_due`, cancellation, end) |
  | `checkout.session.completed` | subscription mode: the subscription exists (fast activation); payment mode: the one-time payment, paid or pending |
  | `checkout.session.async_payment_succeeded` / `_failed` | a delayed payment method settled or failed after completion |

  `invoice.paid` / `invoice.payment_failed` are NOT needed: every status change they cause also emits
  `customer.subscription.updated`, which is reconciled. Other types are acknowledged (200) and ignored.
- **Reconcile, don't trust the payload.** Events arrive late, twice and out of order, so the event is only a
  notification: the handler RETRIEVES the current subscription (or the Checkout Session with its line items) and applies
  that state, stamped `observed_at` = the time Stripe answered.
- **Idempotency.** `apply_stripe_subscription_event` / `apply_stripe_checkout_payment_event` (service_role-only)
  take a transaction-scoped advisory lock on the event id, return `duplicate` if `stripe_webhook_events` already has
  it, and write the event row WITH its outcome in the same transaction as the state change. A failure writes nothing
  (Stripe's retry processes it again); a success is never processed twice, even under concurrent deliveries.
- **Out-of-order.** A subscription observation older than or equal to the stored `stripe_observed_at` is `stale`.
  `canceled` and `incomplete_expired` are terminal in Stripe: a different status afterwards is `stale`, never a revival.
  Purchases move only `pending → paid | failed`; `paid` is final (also guarded by a trigger for every role). Every
  Stripe state change emits a later event whose reconciliation reads newer state, so the stored state converges.
- **Correlation is local.** customer id → `billing_customers` → user; the metadata user must equal it, else `ignored`
  (recorded). Unknown customers (other apps, dashboard objects) → `ignored`.
- Results: `processed`/`ignored` → 200; Stripe or the database unreachable → 500 (Stripe redelivers).

### 7. Planner subscription policy (frozen)

| Stripe status | `planner_pro` |
|---|---|
| `active` | **granted** |
| `trialing` | **granted** |
| `past_due` | **not granted** — no grace period in BILLING-01 |
| `unpaid` | not granted |
| `canceled` | not granted (terminal) |
| `incomplete` | not granted |
| `incomplete_expired` | not granted (terminal) |
| `paused` | not granted |

One source in the database, `private.billing_subscription_grants`; mirrored by `SUBSCRIPTION_GRANTING_STATUSES`
(a DB test compares them). Any granting subscription of the user grants. A planner whose subscription is
`past_due`/`unpaid`/`paused`/`incomplete` is sent to the Customer Portal, not to a second Checkout. A grace period would be
a later, explicit business decision.

### 8. Couple purchase policy

`couple_access` becomes active only when the retrieved Checkout Session is `status = complete` AND
`payment_status = paid` (from `checkout.session.completed`, or `checkout.session.async_payment_succeeded` for delayed
methods). `unpaid` after completion is `pending`; `async_payment_failed` is `failed`; `no_payment_required` is not a
confirmed payment (no promotion codes are enabled). Payment methods are whatever the Stripe account enables (dynamic
payment methods); delayed ones are handled. Once paid, the entitlement is durable: never revoked by a webhook in
BILLING-01, never tied to a browser session. The billing page never offers a second payment while a purchase is pending
or paid.

**V1 exception — account-level, not Wedding-level (dated 2026-10-16).** The Constitution (§11) prefers the Wedding as
the B2C billable unit. For BILLING-01 V1, `couple_access` attaches to the ACCOUNT, intentionally: ACCOUNT-01 already
limits a couple account to creating at most one wedding, the commercial model is one purchase per couple account, and it
keeps the initial architecture simple. It is recorded as a V1 exception in the Constitution, not a new permanent policy;
moving the purchase to a Wedding (e.g. a `wedding_id` on purchases) is a future decision and is not modeled now.

### 9. Refunds and disputes (deferred)

BILLING-01 does NOT revoke an entitlement on `charge.refunded`, `charge.dispute.created` or any reversal, and does not
subscribe to those events. V1 handles them manually (Stripe dashboard + an operator decision). A formal reversal policy is
a future billing milestone. (A canceled subscription after a refund still revokes `planner_pro` through the normal
subscription events.)

### 10. Entitlements, success and cancel

`billing_entitlements (user_id, entitlement_key)` = `active | inactive`, `source` (subscription | purchase),
`granted_at` (first activation, kept when it lapses). It is recomputed only by `private.refresh_billing_entitlement`
inside the two apply functions, after locking the user's customer row. No row = not entitled. Reads:
`getBillingEntitlement` (null on a failed read, never "active") and `hasEntitlement` (fail-closed boolean).
**Entitlements never authorize Wedding data** (Constitution §11, ADR-017 §10): memberships and RLS are unchanged.

`/app/billing/success` is NOT payment authority: anyone can open it. It reads no query parameter, writes nothing, and
shows what the database says: "Recibimos tu pago. Estamos confirmando la activación." until the webhook activated the
entitlement, then the confirmed state. A client component re-renders it at most 8 times every 4 s and then stops.
`/app/billing/cancel` changes nothing.

### 11. Gating (proposal only; nothing is gated)

No existing feature requires payment in BILLING-01. There is no pilot, trial, demo or admin bypass in the codebase, and
none is invented (no email-based bypass). Turning gating on is a separate, explicit product decision; the proposed
starting matrix (for review) is in the BILLING-01 report. Gating, when it arrives, goes through `hasEntitlement` in one
server-side place, never UI flags, and never touches wedding membership.

### 12. Service role (two new narrow modules; five in total)

Stripe webhooks carry no Supabase session; users must never be able to write paid state; every billing table denies
client mutation (and service_role table writes). The trusted write path is therefore a few SECURITY DEFINER functions
executable only by service_role, each reached through one `server-only` module with one authority:

| Module | Single authority | Operations |
|---|---|---|
| `src/lib/billing/customer-recorder.ts` | persist/reconcile the Stripe Customer → user mapping, using the application's own Stripe result after the user's session authorized Checkout | `record` → `record_billing_customer` |
| `src/lib/billing/webhook-store.ts` | verified Stripe webhook persistence: reconcile subscription/purchase state, record the event, recompute the entitlement | `applySubscription` → `apply_stripe_subscription_event`; `applyCheckoutPayment` → `apply_stripe_checkout_payment_event` |

Neither exports a client, `from()` or a generic `rpc(name)`; neither authorizes. Together with the delivery recorder
(ADR-004/005/007), the scheduler store (ADR-010) and the delivery event store (ADR-011), the application has **five**
service-role modules. ESLint allows `SUPABASE_SERVICE_ROLE_KEY` only in those five files, `STRIPE_SECRET_KEY` only in
`src/lib/billing/stripe-gateway.ts` and `STRIPE_WEBHOOK_SECRET` only in `src/lib/billing/webhook-auth.ts`. Their
responsibilities must not be broadened.

### 13. Tests and Stripe test mode

Automated tests never call Stripe: unit tests use a fake `BillingGateway`; DB tests exercise the real functions on the
local stack; E2E points the real SDK at a localhost-only stand-in (`STRIPE_API_BASE`, refused unless it and `APP_ORIGIN`
are localhost) and signs events with a test-only secret. Manual qualification uses Stripe TEST mode only
(`stripe listen --forward-to localhost:<port>/api/stripe/webhook`).

### 14. Production rollout order (each step separately approved)

1. Freeze prices (amount + currency per plan); create TEST-mode products/prices; run the manual test-mode smoke.
2. Apply migration `20261026120000_lb_billing.sql` to production (additive; no gating; inert without configuration).
3. Merge/deploy with NO Stripe variables: billing shows "no disponible", the webhook answers 503.
4. Create LIVE products/prices and the live webhook endpoint (exactly the six events of §6); configure the Customer
   Portal (planner subscription management).
5. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, both price ids in Vercel Production; redeploy.
6. Live smoke with an internal account; verify the event ledger and entitlement; refund manually (§9).
7. Gating: only after an explicit product decision on the matrix.

## Consequences

- Paid state can only be written by Stripe-signed events (and the customer mapping by the app's own Stripe result).
- Replays, duplicates, concurrency and reordering are safe by construction (event ledger + monotonic observations).
- The app is payment-ready but nothing is locked; production stays inert until configured.
- Each webhook makes one Stripe API call (retrieve): accepted for correctness over payload trust.

## Rejected alternatives

- **Granting on the success URL / `session_id` query** — not proof of payment; anyone can open it.
- **Trusting the event payload** — events are delivered out of order; stale payloads could revive access.
- **Ordering by `event.created`** — second-level resolution and unrelated to when state was read; observation time of
  the retrieved object is what matters.
- **A client-executable RPC for the customer mapping** — a user could attach another person's customer (and portal).
- **Letting Checkout create the customer** — concurrent starts would create duplicates before the webhook maps one.
- **Stripe state on `user_accounts`** — mixes immutable identity with mutable billing state.
- **Storing only an entitlement flag** — loses lifecycle, audit and replay safety.
- **`invoice.*` events** — redundant with subscription reconciliation.
