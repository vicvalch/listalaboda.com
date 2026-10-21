-- QA-03a (ADR-021 §7): a planner subscription's scheduled cancellation date.
--
-- Stripe can schedule a cancellation two ways: cancel_at_period_end (ends when
-- the current period ends) or cancel_at (a timestamp, which may fall before,
-- at or AFTER the current period's end; after it, the subscription renews at
-- least once more first). Only the first was stored, so a cancel_at schedule
-- read as "renews". This adds billing_subscriptions.cancel_at (display only:
-- access still follows the status, and Stripe's own transition to canceled
-- ends it) and lets apply_stripe_subscription_event store it.
--
-- Deployment-safe transition. The function gains ONE trailing parameter,
-- cancel_at: a timestamp, 'infinity' = no cancellation scheduled, or the
-- default '-infinity' = not sent (null is read as 'infinity'). It is
-- dropped and recreated (a parameter list can't change in place) inside this
-- migration's transaction, so there is never more than one
-- apply_stripe_subscription_event and no ambiguous overload:
--   * the webhook deployed before this migration calls it with named
--     arguments and no cancel_at: it resolves to the new function, and its
--     calls never clear a stored cancel_at (an insert stores null, as before);
--   * the new webhook always sends cancel_at ('infinity' when Stripe has none,
--     so a schedule removed in Stripe clears it). Deploy it only after this
--     migration (before it, its calls fail and Stripe redelivers them).
-- Every other rule (dedupe, local correlation, stale observations, terminal
-- statuses, the entitlement recomputation), SECURITY DEFINER, search_path and
-- the service_role-only grant are unchanged. Existing rows get cancel_at null
-- (no backfill: the next event about each subscription fills it).

alter table public.billing_subscriptions add column cancel_at timestamptz;

comment on column public.billing_subscriptions.cancel_at is
  'When Stripe will cancel this subscription (Stripe cancel_at), as last reconciled; null = none scheduled. Display only, never authorization.';

grant select (cancel_at) on table public.billing_subscriptions to authenticated;

drop function public.apply_stripe_subscription_event(text, text, boolean, timestamptz, text, text, uuid, public.billing_entitlement_key, public.billing_subscription_status, boolean, timestamptz, text, timestamptz);

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
  current_period_end timestamptz default null,
  cancel_at timestamptz default '-infinity'
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
  -- '-infinity' (the default) = the caller didn't send cancel_at; 'infinity'
  -- (or null) = Stripe has no cancellation scheduled.
  v_cancel_at_sent boolean := apply_stripe_subscription_event.cancel_at is distinct from '-infinity'::timestamptz;
  v_sent_cancel_at timestamptz := case
    when apply_stripe_subscription_event.cancel_at = 'infinity'::timestamptz then null
    else apply_stripe_subscription_event.cancel_at
  end;
  v_cancel_at timestamptz;
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
     or not pg_catalog.isfinite(apply_stripe_subscription_event.observed_at)
     or (v_cancel_at_sent and v_sent_cancel_at is not null and not pg_catalog.isfinite(v_sent_cancel_at)) then
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
        status, current_period_end, cancel_at_period_end, cancel_at, stripe_observed_at
      ) values (
        v_user,
        apply_stripe_subscription_event.stripe_customer_id,
        apply_stripe_subscription_event.stripe_subscription_id,
        apply_stripe_subscription_event.stripe_price_id,
        apply_stripe_subscription_event.entitlement_key,
        apply_stripe_subscription_event.subscription_status,
        apply_stripe_subscription_event.current_period_end,
        apply_stripe_subscription_event.cancel_at_period_end,
        case when v_cancel_at_sent then v_sent_cancel_at end,
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
      -- An older caller (no cancel_at) never clears a stored one.
      v_cancel_at := case when v_cancel_at_sent then v_sent_cancel_at else v_existing.cancel_at end;
      if v_existing.status is not distinct from apply_stripe_subscription_event.subscription_status
         and v_existing.stripe_price_id is not distinct from apply_stripe_subscription_event.stripe_price_id
         and v_existing.current_period_end is not distinct from apply_stripe_subscription_event.current_period_end
         and v_existing.cancel_at_period_end = apply_stripe_subscription_event.cancel_at_period_end
         and v_existing.cancel_at is not distinct from v_cancel_at then
        v_outcome := 'no_change';
      else
        v_outcome := 'applied';
      end if;
      update public.billing_subscriptions s
         set stripe_price_id = apply_stripe_subscription_event.stripe_price_id,
             status = apply_stripe_subscription_event.subscription_status,
             current_period_end = apply_stripe_subscription_event.current_period_end,
             cancel_at_period_end = apply_stripe_subscription_event.cancel_at_period_end,
             cancel_at = v_cancel_at,
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

comment on function public.apply_stripe_subscription_event(text, text, boolean, timestamptz, text, text, uuid, public.billing_entitlement_key, public.billing_subscription_status, boolean, timestamptz, text, timestamptz, timestamptz) is
  'service_role only (ADR-002 §6, ADR-021 §6–§7): applies a verified Stripe subscription event using the subscription state retrieved at observed_at. Dedupes by event id; never moves state backwards; recomputes planner_pro. cancel_at: a timestamp, ''infinity'' = none scheduled, ''-infinity'' (default) = not sent (keep the stored value).';

revoke all on function public.apply_stripe_subscription_event(text, text, boolean, timestamptz, text, text, uuid, public.billing_entitlement_key, public.billing_subscription_status, boolean, timestamptz, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_stripe_subscription_event(text, text, boolean, timestamptz, text, text, uuid, public.billing_entitlement_key, public.billing_subscription_status, boolean, timestamptz, text, timestamptz, timestamptz)
  to service_role;
