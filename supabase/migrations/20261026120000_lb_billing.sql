-- BILLING-01 (ADR-021): Stripe Checkout and persistent entitlements.
--
-- Stripe processes payments; THIS database is the application's durable
-- access state. Nothing here is written by a client:
--   * billing_customers: at most one Stripe Customer per user (and one user per
--     customer). Written only by record_billing_customer, after the
--     application created (or got back, idempotently) the customer with
--     Stripe on behalf of the authenticated, typed user;
--   * billing_subscriptions / billing_purchases: the planner subscription and
--     the couple one-time purchase as last reconciled from Stripe. Written
--     only by the two apply_stripe_*_event functions, called by the webhook
--     route after the Stripe-Signature was verified;
--   * billing_entitlements: what the application reads ("may this account use
--     the paid product?"), recomputed from the rows above inside the same
--     transaction, never written on its own;
--   * stripe_webhook_events: one append-only row per processed Stripe event
--     (the event id is the replay/idempotency key). No payloads, no
--     customer data, no secrets.
--
-- Every write function is SECURITY DEFINER and executable ONLY by
-- service_role (ADR-002 §6, ADR-021 §6): a user JWT can't prove a Stripe
-- result, so no client role may execute them. Clients only SELECT their own
-- rows (column grants + RLS); anon has nothing.
--
-- Entitlements are product access, never wedding authorization (Constitution
-- §11, ADR-017 §10): memberships, RLS and the private wedding helpers are
-- unchanged, and nothing in this migration gates any existing feature.

create type public.billing_entitlement_key as enum ('planner_pro', 'couple_access');

comment on type public.billing_entitlement_key is
  'Semantic paid-product keys (ADR-021 §4). Mirrors BILLING_ENTITLEMENT_KEYS in src/lib/billing/plans.ts. Never a Stripe id.';

-- Every Stripe subscription status (Stripe API 2026-08-26). Only active and
-- trialing grant (private.billing_subscription_grants).
create type public.billing_subscription_status as enum (
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused'
);

create type public.billing_purchase_status as enum ('pending', 'paid', 'failed');
create type public.billing_entitlement_status as enum ('active', 'inactive');
create type public.billing_entitlement_source as enum ('subscription', 'purchase');

-- `duplicate` is only ever returned, never stored (an event id is stored once).
create type public.stripe_webhook_outcome as enum ('applied', 'no_change', 'stale', 'ignored', 'duplicate');

-- ---------------------------------------------------------------- policy

-- THE planner subscription policy (ADR-021 §7): active and trialing grant;
-- past_due, unpaid, paused, incomplete, incomplete_expired and canceled
-- never do. Mirrored by SUBSCRIPTION_GRANTING_STATUSES (a DB test compares).
create function private.billing_subscription_grants(status public.billing_subscription_status)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select billing_subscription_grants.status in ('active', 'trialing');
$$;

revoke all on function private.billing_subscription_grants(public.billing_subscription_status) from public, anon, authenticated;

-- ------------------------------------------------------- billing_customers

create table public.billing_customers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text not null,
  -- Database clock, always (the guard overwrites any supplied value).
  created_at timestamptz not null default now(),
  constraint billing_customers_stripe_customer_id_unique unique (stripe_customer_id),
  -- Composite FK target: a subscription/purchase belongs to the user OF its customer.
  constraint billing_customers_user_customer_unique unique (user_id, stripe_customer_id),
  constraint billing_customers_stripe_customer_id_format check (stripe_customer_id ~ '^cus_[A-Za-z0-9_]{1,250}$')
);

comment on table public.billing_customers is
  'At most one Stripe Customer per user and one user per customer (ADR-021 §5). Written only by record_billing_customer; immutable.';

alter table public.billing_customers enable row level security;
revoke all on table public.billing_customers from public, anon, authenticated, service_role;
grant select (user_id, stripe_customer_id, created_at) on table public.billing_customers to authenticated;

create policy billing_customers_select_own
  on public.billing_customers for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Immutable for every role: no UPDATE that changes anything; DELETE only via
-- the auth.users ON DELETE CASCADE (trigger depth ≥ 2).
create function private.guard_billing_customers()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    return new;
  end if;
  if tg_op = 'DELETE' then
    if pg_catalog.pg_trigger_depth() < 2 then
      raise exception 'billing_customer_immutable' using errcode = '55000';
    end if;
    return old;
  end if;
  if new.user_id is distinct from old.user_id
     or new.stripe_customer_id is distinct from old.stripe_customer_id
     or new.created_at is distinct from old.created_at then
    raise exception 'billing_customer_immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_billing_customers() from public;

create trigger billing_customers_guard
  before insert or update or delete on public.billing_customers
  for each row execute function private.guard_billing_customers();

-- --------------------------------------------------- billing_subscriptions

create table public.billing_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  stripe_customer_id text not null,
  stripe_subscription_id text not null,
  -- Billing configuration at the time (audit/display), never authorization.
  stripe_price_id text,
  entitlement_key public.billing_entitlement_key not null,
  status public.billing_subscription_status not null,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  -- When the application RETRIEVED this state from Stripe: the monotonic
  -- guard against out-of-order and concurrent webhook processing.
  stripe_observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_subscriptions_stripe_subscription_id_unique unique (stripe_subscription_id),
  constraint billing_subscriptions_stripe_subscription_id_format check (stripe_subscription_id ~ '^sub_[A-Za-z0-9_]{1,250}$'),
  constraint billing_subscriptions_stripe_price_id_format check (stripe_price_id is null or stripe_price_id ~ '^price_[A-Za-z0-9_]{1,250}$'),
  constraint billing_subscriptions_planner_only check (entitlement_key = 'planner_pro'),
  constraint billing_subscriptions_customer_fk foreign key (user_id, stripe_customer_id)
    references public.billing_customers (user_id, stripe_customer_id) on delete cascade
);

create index billing_subscriptions_user_id_idx on public.billing_subscriptions (user_id);

comment on table public.billing_subscriptions is
  'Planner subscriptions as last reconciled from Stripe (ADR-021 §7). Written only by apply_stripe_subscription_event.';

alter table public.billing_subscriptions enable row level security;
revoke all on table public.billing_subscriptions from public, anon, authenticated, service_role;
grant select (id, user_id, entitlement_key, status, current_period_end, cancel_at_period_end, created_at, updated_at)
  on table public.billing_subscriptions to authenticated;

create policy billing_subscriptions_select_own
  on public.billing_subscriptions for select
  to authenticated
  using (user_id = (select auth.uid()));

-- ------------------------------------------------------- billing_purchases

create table public.billing_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  stripe_customer_id text not null,
  stripe_checkout_session_id text not null,
  stripe_payment_intent_id text,
  stripe_price_id text,
  entitlement_key public.billing_entitlement_key not null,
  status public.billing_purchase_status not null,
  -- Database clock of the confirmation; set iff paid.
  purchased_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_purchases_stripe_checkout_session_id_unique unique (stripe_checkout_session_id),
  constraint billing_purchases_stripe_payment_intent_id_unique unique (stripe_payment_intent_id),
  constraint billing_purchases_session_format check (stripe_checkout_session_id ~ '^cs_[A-Za-z0-9_]{1,250}$'),
  constraint billing_purchases_payment_intent_format check (stripe_payment_intent_id is null or stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]{1,250}$'),
  constraint billing_purchases_stripe_price_id_format check (stripe_price_id is null or stripe_price_id ~ '^price_[A-Za-z0-9_]{1,250}$'),
  constraint billing_purchases_couple_only check (entitlement_key = 'couple_access'),
  constraint billing_purchases_paid_at check ((status = 'paid') = (purchased_at is not null)),
  constraint billing_purchases_customer_fk foreign key (user_id, stripe_customer_id)
    references public.billing_customers (user_id, stripe_customer_id) on delete cascade
);

create index billing_purchases_user_id_idx on public.billing_purchases (user_id);

comment on table public.billing_purchases is
  'Couple one-time purchases, one per Checkout Session (ADR-021 §8). Written only by apply_stripe_checkout_payment_event. paid is final.';

alter table public.billing_purchases enable row level security;
revoke all on table public.billing_purchases from public, anon, authenticated, service_role;
grant select (id, user_id, entitlement_key, status, purchased_at, created_at, updated_at)
  on table public.billing_purchases to authenticated;

create policy billing_purchases_select_own
  on public.billing_purchases for select
  to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------- billing_entitlements

create table public.billing_entitlements (
  user_id uuid not null references auth.users (id) on delete cascade,
  entitlement_key public.billing_entitlement_key not null,
  status public.billing_entitlement_status not null,
  source public.billing_entitlement_source not null,
  -- The first time it became active (kept when it later lapses).
  granted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, entitlement_key),
  constraint billing_entitlements_source_matches_key
    check ((entitlement_key = 'planner_pro') = (source = 'subscription')),
  constraint billing_entitlements_granted_at check (status = 'inactive' or granted_at is not null)
);

comment on table public.billing_entitlements is
  'Derived paid access per user and key (ADR-021 §9). Recomputed only by private.refresh_billing_entitlement inside the apply functions. No row = not entitled.';

alter table public.billing_entitlements enable row level security;
revoke all on table public.billing_entitlements from public, anon, authenticated, service_role;
grant select (user_id, entitlement_key, status, source, granted_at, updated_at)
  on table public.billing_entitlements to authenticated;

create policy billing_entitlements_select_own
  on public.billing_entitlements for select
  to authenticated
  using (user_id = (select auth.uid()));

-- --------------------------------------------------- stripe_webhook_events

create table public.stripe_webhook_events (
  stripe_event_id text primary key,
  event_type text not null,
  livemode boolean not null,
  stripe_created_at timestamptz not null,
  outcome public.stripe_webhook_outcome not null,
  processed_at timestamptz not null default now(),
  constraint stripe_webhook_events_id_format check (stripe_event_id ~ '^evt_[A-Za-z0-9_]{1,250}$'),
  constraint stripe_webhook_events_type check (event_type in (
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted'
  )),
  constraint stripe_webhook_events_outcome_stored check (outcome <> 'duplicate')
);

comment on table public.stripe_webhook_events is
  'Append-only: one row per processed, signature-verified Stripe event (ADR-021 §6). The event id is the replay key. No payloads.';

alter table public.stripe_webhook_events enable row level security;
revoke all on table public.stripe_webhook_events from public, anon, authenticated, service_role;

create function private.guard_stripe_webhook_events()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.processed_at := now();
    return new;
  end if;
  raise exception 'stripe_webhook_event_immutable' using errcode = '55000';
end;
$$;

revoke all on function private.guard_stripe_webhook_events() from public;

create trigger stripe_webhook_events_guard
  before insert or update or delete on public.stripe_webhook_events
  for each row execute function private.guard_stripe_webhook_events();

-- Identity columns of subscriptions and purchases never change (every role).
create function private.guard_billing_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'billing_subscriptions' then
    if new.user_id is distinct from old.user_id
       or new.stripe_customer_id is distinct from old.stripe_customer_id
       or new.stripe_subscription_id is distinct from old.stripe_subscription_id
       or new.entitlement_key is distinct from old.entitlement_key
       or new.created_at is distinct from old.created_at then
      raise exception 'billing_identity_immutable' using errcode = '55000';
    end if;
  else
    if new.user_id is distinct from old.user_id
       or new.stripe_customer_id is distinct from old.stripe_customer_id
       or new.stripe_checkout_session_id is distinct from old.stripe_checkout_session_id
       or new.entitlement_key is distinct from old.entitlement_key
       or new.created_at is distinct from old.created_at then
      raise exception 'billing_identity_immutable' using errcode = '55000';
    end if;
    -- A confirmed payment is final: paid never goes back.
    if old.status = 'paid' and new.status is distinct from 'paid' then
      raise exception 'billing_purchase_paid_final' using errcode = '55000';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.guard_billing_identity() from public;

create trigger billing_subscriptions_guard
  before update on public.billing_subscriptions
  for each row execute function private.guard_billing_identity();

create trigger billing_purchases_guard
  before update on public.billing_purchases
  for each row execute function private.guard_billing_identity();

-- ------------------------------------------------ entitlement recomputation

-- Recomputes one user's entitlement from the stored subscriptions/purchases.
-- A key only counts for its own account type (planner_pro → planner,
-- couple_access → couple); the account type is immutable (ADR-020).
-- Called only from the apply functions, after locking the user's customer row.
create function private.refresh_billing_entitlement(
  target_user_id uuid,
  target_key public.billing_entitlement_key
)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_type public.account_type;
  v_active boolean;
begin
  select a.account_type into v_type
  from public.user_accounts a
  where a.user_id = refresh_billing_entitlement.target_user_id;

  if refresh_billing_entitlement.target_key = 'planner_pro' then
    v_active := v_type = 'planner' and exists (
      select 1 from public.billing_subscriptions s
      where s.user_id = refresh_billing_entitlement.target_user_id
        and s.entitlement_key = 'planner_pro'
        and private.billing_subscription_grants(s.status)
    );
  else
    v_active := v_type = 'couple' and exists (
      select 1 from public.billing_purchases p
      where p.user_id = refresh_billing_entitlement.target_user_id
        and p.entitlement_key = 'couple_access'
        and p.status = 'paid'
    );
  end if;
  v_active := coalesce(v_active, false);

  insert into public.billing_entitlements as e (user_id, entitlement_key, status, source, granted_at)
  values (
    refresh_billing_entitlement.target_user_id,
    refresh_billing_entitlement.target_key,
    case when v_active then 'active' else 'inactive' end::public.billing_entitlement_status,
    case refresh_billing_entitlement.target_key when 'planner_pro' then 'subscription' else 'purchase' end::public.billing_entitlement_source,
    case when v_active then now() end
  )
  on conflict (user_id, entitlement_key) do update
    set status = excluded.status,
        granted_at = coalesce(e.granted_at, excluded.granted_at),
        updated_at = case when e.status is distinct from excluded.status then now() else e.updated_at end;
end;
$$;

revoke all on function private.refresh_billing_entitlement(uuid, public.billing_entitlement_key) from public, anon, authenticated;

-- ---------------------------------------------------- record_billing_customer

-- The application created (or got back, through Stripe's idempotency key) a
-- Stripe Customer for this typed user, after the user's own session
-- authorized the Checkout start. Records the mapping at most once:
--   * no mapping yet → stores it and returns it;
--   * already mapped → returns the STORED customer id (a concurrent or
--     earlier start wins; the caller must use what this returns);
--   * the customer id is already another user's → billing_customer_conflict.
-- Untyped accounts can't buy (account_type_required).
create function public.record_billing_customer(target_user_id uuid, stripe_customer_id text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_stored text;
begin
  if record_billing_customer.target_user_id is null
     or record_billing_customer.stripe_customer_id is null
     or record_billing_customer.stripe_customer_id !~ '^cus_[A-Za-z0-9_]{1,250}$' then
    raise exception 'billing_customer_invalid' using errcode = '22023';
  end if;

  -- Serializes with the user's other billing writes.
  perform 1 from public.user_accounts a where a.user_id = record_billing_customer.target_user_id for update;
  if not found then
    raise exception 'account_type_required' using errcode = '55000';
  end if;

  select c.user_id into v_owner
  from public.billing_customers c
  where c.stripe_customer_id = record_billing_customer.stripe_customer_id;
  if v_owner is not null and v_owner <> record_billing_customer.target_user_id then
    raise exception 'billing_customer_conflict' using errcode = '55000';
  end if;

  insert into public.billing_customers (user_id, stripe_customer_id)
  values (record_billing_customer.target_user_id, record_billing_customer.stripe_customer_id)
  on conflict (user_id) do nothing;

  select c.stripe_customer_id into v_stored
  from public.billing_customers c
  where c.user_id = record_billing_customer.target_user_id;
  return v_stored;
end;
$$;

comment on function public.record_billing_customer(uuid, text) is
  'service_role only (ADR-002 §6, ADR-021 §5): records a typed user''s Stripe Customer at most once and returns the stored one.';

revoke all on function public.record_billing_customer(uuid, text) from public, anon, authenticated;
grant execute on function public.record_billing_customer(uuid, text) to service_role;

-- ------------------------------------------- apply_stripe_subscription_event

-- One signature-verified Stripe event about a subscription, with the
-- subscription's CURRENT state as the application retrieved it from Stripe
-- at observed_at (never the event's own, possibly stale, payload).
--   * the event id was processed already → duplicate (nothing written);
--   * correlation is local: the customer → our user. Unknown customer, or a
--     metadata user that isn't the customer's user → ignored;
--   * an older observation than the stored one → stale (out-of-order or
--     concurrent processing can never move state backwards);
--   * canceled and incomplete_expired are terminal in Stripe: a different
--     status afterwards is stale, never a revival;
--   * otherwise the row is inserted/updated and the planner entitlement is
--     recomputed in the same transaction.
-- The event row is written with the outcome, in the same transaction: a
-- failure leaves nothing, so Stripe's retry processes it again.
create function public.apply_stripe_subscription_event(
  stripe_event_id text,
  event_type text,
  event_livemode boolean,
  event_created_at timestamptz,
  stripe_customer_id text,
  stripe_subscription_id text,
  metadata_user_id uuid,
  entitlement_key public.billing_entitlement_key,
  subscription_status public.billing_subscription_status,
  cancel_at_period_end boolean,
  observed_at timestamptz,
  stripe_price_id text default null,
  current_period_end timestamptz default null
)
returns public.stripe_webhook_outcome
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_existing public.billing_subscriptions%rowtype;
  v_outcome public.stripe_webhook_outcome;
begin
  if apply_stripe_subscription_event.stripe_event_id is null
     or apply_stripe_subscription_event.stripe_event_id !~ '^evt_[A-Za-z0-9_]{1,250}$'
     or apply_stripe_subscription_event.event_type is null
     or apply_stripe_subscription_event.event_type not in (
       'checkout.session.completed',
       'customer.subscription.created',
       'customer.subscription.updated',
       'customer.subscription.deleted')
     or apply_stripe_subscription_event.event_livemode is null
     or apply_stripe_subscription_event.event_created_at is null
     or apply_stripe_subscription_event.stripe_customer_id is null
     or apply_stripe_subscription_event.stripe_subscription_id is null
     or apply_stripe_subscription_event.entitlement_key is distinct from 'planner_pro'
     or apply_stripe_subscription_event.subscription_status is null
     or apply_stripe_subscription_event.cancel_at_period_end is null
     or apply_stripe_subscription_event.observed_at is null
     or not pg_catalog.isfinite(apply_stripe_subscription_event.observed_at) then
    raise exception 'stripe_event_invalid' using errcode = '22023';
  end if;

  -- Concurrent deliveries of one event serialize here; the loser sees the row.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe_webhook_event:' || apply_stripe_subscription_event.stripe_event_id, 0));
  if exists (
    select 1 from public.stripe_webhook_events e
    where e.stripe_event_id = apply_stripe_subscription_event.stripe_event_id
  ) then
    return 'duplicate'::public.stripe_webhook_outcome;
  end if;

  -- Per-user serialization: the customer row is the user's billing lock.
  select c.user_id into v_user
  from public.billing_customers c
  where c.stripe_customer_id = apply_stripe_subscription_event.stripe_customer_id
  for update;

  if v_user is null
     or apply_stripe_subscription_event.metadata_user_id is null
     or apply_stripe_subscription_event.metadata_user_id <> v_user then
    v_outcome := 'ignored';
  else
    select * into v_existing
    from public.billing_subscriptions s
    where s.stripe_subscription_id = apply_stripe_subscription_event.stripe_subscription_id
    for update;

    if not found then
      insert into public.billing_subscriptions (
        user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, entitlement_key,
        status, current_period_end, cancel_at_period_end, stripe_observed_at
      ) values (
        v_user,
        apply_stripe_subscription_event.stripe_customer_id,
        apply_stripe_subscription_event.stripe_subscription_id,
        apply_stripe_subscription_event.stripe_price_id,
        apply_stripe_subscription_event.entitlement_key,
        apply_stripe_subscription_event.subscription_status,
        apply_stripe_subscription_event.current_period_end,
        apply_stripe_subscription_event.cancel_at_period_end,
        apply_stripe_subscription_event.observed_at
      );
      v_outcome := 'applied';
    elsif v_existing.user_id <> v_user then
      v_outcome := 'ignored';
    elsif v_existing.stripe_observed_at >= apply_stripe_subscription_event.observed_at then
      v_outcome := 'stale';
    elsif v_existing.status in ('canceled', 'incomplete_expired')
          and apply_stripe_subscription_event.subscription_status is distinct from v_existing.status then
      v_outcome := 'stale';
    else
      if v_existing.status is not distinct from apply_stripe_subscription_event.subscription_status
         and v_existing.stripe_price_id is not distinct from apply_stripe_subscription_event.stripe_price_id
         and v_existing.current_period_end is not distinct from apply_stripe_subscription_event.current_period_end
         and v_existing.cancel_at_period_end = apply_stripe_subscription_event.cancel_at_period_end then
        v_outcome := 'no_change';
      else
        v_outcome := 'applied';
      end if;
      update public.billing_subscriptions s
         set stripe_price_id = apply_stripe_subscription_event.stripe_price_id,
             status = apply_stripe_subscription_event.subscription_status,
             current_period_end = apply_stripe_subscription_event.current_period_end,
             cancel_at_period_end = apply_stripe_subscription_event.cancel_at_period_end,
             stripe_observed_at = apply_stripe_subscription_event.observed_at
       where s.id = v_existing.id;
    end if;

    if v_outcome in ('applied', 'no_change') then
      perform private.refresh_billing_entitlement(v_user, 'planner_pro');
    end if;
  end if;

  insert into public.stripe_webhook_events (stripe_event_id, event_type, livemode, stripe_created_at, outcome)
  values (
    apply_stripe_subscription_event.stripe_event_id,
    apply_stripe_subscription_event.event_type,
    apply_stripe_subscription_event.event_livemode,
    apply_stripe_subscription_event.event_created_at,
    v_outcome
  );
  return v_outcome;
end;
$$;

comment on function public.apply_stripe_subscription_event(text, text, boolean, timestamptz, text, text, uuid, public.billing_entitlement_key, public.billing_subscription_status, boolean, timestamptz, text, timestamptz) is
  'service_role only (ADR-002 §6, ADR-021 §6–§7): applies a verified Stripe subscription event using the subscription state retrieved at observed_at. Dedupes by event id; never moves state backwards; recomputes planner_pro.';

revoke all on function public.apply_stripe_subscription_event(text, text, boolean, timestamptz, text, text, uuid, public.billing_entitlement_key, public.billing_subscription_status, boolean, timestamptz, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_stripe_subscription_event(text, text, boolean, timestamptz, text, text, uuid, public.billing_entitlement_key, public.billing_subscription_status, boolean, timestamptz, text, timestamptz)
  to service_role;

-- --------------------------------------- apply_stripe_checkout_payment_event

-- One signature-verified Stripe event about a one-time (mode=payment)
-- Checkout Session, with the session's CURRENT payment state as the
-- application retrieved it: paid (confirmed), pending (completed but an
-- asynchronous method hasn't settled) or failed (async payment failed).
--   * duplicate / ignored exactly as for subscriptions;
--   * transitions: pending → paid | failed; paid and failed are final
--     (an older or repeated observation is no_change);
--   * paid stamps purchased_at (database clock) and recomputes couple_access
--     in the same transaction. A paid purchase is never revoked here.
create function public.apply_stripe_checkout_payment_event(
  stripe_event_id text,
  event_type text,
  event_livemode boolean,
  event_created_at timestamptz,
  stripe_customer_id text,
  stripe_checkout_session_id text,
  metadata_user_id uuid,
  entitlement_key public.billing_entitlement_key,
  payment_status public.billing_purchase_status,
  stripe_payment_intent_id text default null,
  stripe_price_id text default null
)
returns public.stripe_webhook_outcome
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_existing public.billing_purchases%rowtype;
  v_outcome public.stripe_webhook_outcome;
begin
  if apply_stripe_checkout_payment_event.stripe_event_id is null
     or apply_stripe_checkout_payment_event.stripe_event_id !~ '^evt_[A-Za-z0-9_]{1,250}$'
     or apply_stripe_checkout_payment_event.event_type is null
     or apply_stripe_checkout_payment_event.event_type not in (
       'checkout.session.completed',
       'checkout.session.async_payment_succeeded',
       'checkout.session.async_payment_failed')
     or apply_stripe_checkout_payment_event.event_livemode is null
     or apply_stripe_checkout_payment_event.event_created_at is null
     or apply_stripe_checkout_payment_event.stripe_customer_id is null
     or apply_stripe_checkout_payment_event.stripe_checkout_session_id is null
     or apply_stripe_checkout_payment_event.entitlement_key is distinct from 'couple_access'
     or apply_stripe_checkout_payment_event.payment_status is null then
    raise exception 'stripe_event_invalid' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe_webhook_event:' || apply_stripe_checkout_payment_event.stripe_event_id, 0));
  if exists (
    select 1 from public.stripe_webhook_events e
    where e.stripe_event_id = apply_stripe_checkout_payment_event.stripe_event_id
  ) then
    return 'duplicate'::public.stripe_webhook_outcome;
  end if;

  select c.user_id into v_user
  from public.billing_customers c
  where c.stripe_customer_id = apply_stripe_checkout_payment_event.stripe_customer_id
  for update;

  if v_user is null
     or apply_stripe_checkout_payment_event.metadata_user_id is null
     or apply_stripe_checkout_payment_event.metadata_user_id <> v_user then
    v_outcome := 'ignored';
  else
    select * into v_existing
    from public.billing_purchases p
    where p.stripe_checkout_session_id = apply_stripe_checkout_payment_event.stripe_checkout_session_id
    for update;

    if not found then
      insert into public.billing_purchases (
        user_id, stripe_customer_id, stripe_checkout_session_id, stripe_payment_intent_id,
        stripe_price_id, entitlement_key, status, purchased_at
      ) values (
        v_user,
        apply_stripe_checkout_payment_event.stripe_customer_id,
        apply_stripe_checkout_payment_event.stripe_checkout_session_id,
        apply_stripe_checkout_payment_event.stripe_payment_intent_id,
        apply_stripe_checkout_payment_event.stripe_price_id,
        apply_stripe_checkout_payment_event.entitlement_key,
        apply_stripe_checkout_payment_event.payment_status,
        case when apply_stripe_checkout_payment_event.payment_status = 'paid' then now() end
      );
      v_outcome := 'applied';
    elsif v_existing.user_id <> v_user then
      v_outcome := 'ignored';
    elsif v_existing.status = 'pending' and apply_stripe_checkout_payment_event.payment_status <> 'pending' then
      update public.billing_purchases p
         set status = apply_stripe_checkout_payment_event.payment_status,
             stripe_payment_intent_id = coalesce(p.stripe_payment_intent_id, apply_stripe_checkout_payment_event.stripe_payment_intent_id),
             purchased_at = case when apply_stripe_checkout_payment_event.payment_status = 'paid' then now() end
       where p.id = v_existing.id;
      v_outcome := 'applied';
    else
      v_outcome := 'no_change';
    end if;

    if v_outcome in ('applied', 'no_change') then
      perform private.refresh_billing_entitlement(v_user, 'couple_access');
    end if;
  end if;

  insert into public.stripe_webhook_events (stripe_event_id, event_type, livemode, stripe_created_at, outcome)
  values (
    apply_stripe_checkout_payment_event.stripe_event_id,
    apply_stripe_checkout_payment_event.event_type,
    apply_stripe_checkout_payment_event.event_livemode,
    apply_stripe_checkout_payment_event.event_created_at,
    v_outcome
  );
  return v_outcome;
end;
$$;

comment on function public.apply_stripe_checkout_payment_event(text, text, boolean, timestamptz, text, text, uuid, public.billing_entitlement_key, public.billing_purchase_status, text, text) is
  'service_role only (ADR-002 §6, ADR-021 §6, §8): applies a verified Stripe one-time Checkout event using the session state the application retrieved. Dedupes by event id; paid is final; recomputes couple_access.';

revoke all on function public.apply_stripe_checkout_payment_event(text, text, boolean, timestamptz, text, text, uuid, public.billing_entitlement_key, public.billing_purchase_status, text, text)
  from public, anon, authenticated;
grant execute on function public.apply_stripe_checkout_payment_event(text, text, boolean, timestamptz, text, text, uuid, public.billing_entitlement_key, public.billing_purchase_status, text, text)
  to service_role;
