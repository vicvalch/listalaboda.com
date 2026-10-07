-- LB-18.2: delivery status and provider delivery events (ADR-011 §7).
-- Passive ingestion foundation for signed Resend webhooks.
--
-- Adds, on top of the LB-18.1 ledger:
--   * public.email_deliveries.status / status_event_at: the delivery's
--     current, rank-monotonic status. 'accepted' is the record's own state
--     (every existing and every newly recorded row starts there);
--   * public.email_delivery_events: append-only history of the provider's
--     delivery events, one row per provider event id (svix-id);
--   * public.ingest_email_delivery_event: the ONE writer of both, SECURITY
--     DEFINER, executable only by service_role, called only through
--     src/lib/email/delivery-event-store.ts after the webhook route verified
--     the provider's signature.
--
-- Correlation is strictly local (ADR-011 §4): the provider's email id →
-- email_deliveries.provider_message_id → party → Wedding. The function takes
-- no wedding, party, delivery id, recipient or payload from the provider.
--
-- Rank, never the provider timestamp, decides the current status: events
-- arrive duplicated and out of order, and a lower- or equal-rank event only
-- adds history. Delivery status never touches LB-17 execution state
-- (automatic_rsvp_reminders), the latest-send metadata or activity history.
--
-- Not here (later LB-18 slices): delivery UI and member reads of the status,
-- resend/suppression rules, recipient_undeliverable, recently_reminded,
-- production webhook activation.

-- ---------------------------------------------------------------- types

-- Declared in rank order: the enum's ordering is the rank order.
create type public.email_delivery_status as enum (
  'accepted',    -- 0: provider accepted and the app recorded it (never set by a webhook)
  'delayed',     -- 10
  'failed',      -- 20: sender-side failure
  'delivered',   -- 30
  'suppressed',  -- 40
  'bounced',     -- 50
  'complained'   -- 60
);

comment on type public.email_delivery_status is
  'LB-18.2 (ADR-011 §7): a recorded email''s delivery status. Rank-monotonic: accepted 0 < delayed 10 < failed 20 < delivered 30 < suppressed 40 < bounced 50 < complained 60.';

create type public.email_delivery_event_type as enum (
  'delivered',         -- email.delivered        → delivered
  'delivery_delayed',  -- email.delivery_delayed → delayed
  'failed',            -- email.failed           → failed
  'suppressed',        -- email.suppressed       → suppressed
  'bounced',           -- email.bounced          → bounced
  'complained'         -- email.complained       → complained
);

comment on type public.email_delivery_event_type is
  'LB-18.2 (ADR-011 §7): the six subscribed provider delivery events. Opens and clicks are never ingested.';

create type public.email_bounce_type as enum ('permanent', 'transient', 'undetermined');

comment on type public.email_bounce_type is
  'LB-18.2: normalized provider bounce.type (Permanent → permanent; Transient/Temporary → transient; anything else → undetermined).';

create type public.email_delivery_ingest_outcome as enum (
  'applied',          -- new event, status advanced
  'no_change',        -- new event, recorded as history; status kept (same or lower rank)
  'duplicate',        -- this provider event id was already ingested; nothing changed
  'unknown_message'   -- no recorded email has this provider id; nothing written
);

comment on type public.email_delivery_ingest_outcome is
  'LB-18.2: closed result of public.ingest_email_delivery_event. Carries no ids.';

-- ------------------------------------------------------------ rank rule

create function private.email_delivery_status_rank(status public.email_delivery_status)
returns integer
language sql
immutable
strict
set search_path = ''
as $$
  select case status
    when 'accepted' then 0
    when 'delayed' then 10
    when 'failed' then 20
    when 'delivered' then 30
    when 'suppressed' then 40
    when 'bounced' then 50
    when 'complained' then 60
  end
$$;

comment on function private.email_delivery_status_rank(public.email_delivery_status) is
  'LB-18.2 (ADR-011 §7): the status precedence. A status only ever moves to a strictly higher rank.';

revoke all on function private.email_delivery_status_rank(public.email_delivery_status) from public, anon, authenticated;

-- ------------------------------------------------------ status columns

-- Metadata-only ADD COLUMN (constant default): existing rows read as
-- accepted / null, accepted_at keeps its meaning.
alter table public.email_deliveries
  add column status public.email_delivery_status not null default 'accepted',
  add column status_event_at timestamptz,
  -- accepted ⇔ no event advanced it; every other status names its event's time.
  add constraint email_deliveries_status_event_at_consistent
    check ((status = 'accepted') = (status_event_at is null)),
  -- Target of the events' same-wedding composite FK.
  add constraint email_deliveries_id_wedding_unique unique (id, wedding_id);

comment on column public.email_deliveries.status is
  'LB-18.2 (ADR-011 §7): current delivery status, rank-monotonic. Changed only by ingest_email_delivery_event. Not readable by clients yet (LB-18.3).';
comment on column public.email_deliveries.status_event_at is
  'Provider occurred_at of the event that last ADVANCED status; null while accepted.';

-- ------------------------------------------------------------- the guard

-- Replaced (LB-18.1 rules unchanged). For EVERY role:
--   * INSERT: accepted_at is the database clock; a new row is always
--     accepted with no status_event_at (only the record functions insert);
--   * UPDATE: identity columns never change; status only moves to a strictly
--     higher rank, and status_event_at changes only together with it (the
--     CHECK above keeps the pair consistent);
--   * DELETE: only the foreign keys' cascades (trigger depth ≥ 2).
create or replace function private.guard_email_deliveries()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status is distinct from 'accepted' or new.status_event_at is not null then
      raise exception 'email_delivery_status_invalid'
        using errcode = '55000',
              detail = 'A recorded email starts as accepted.';
    end if;
    new.accepted_at := now();
    return new;
  end if;

  if tg_op = 'DELETE' then
    if pg_catalog.pg_trigger_depth() < 2 then
      raise exception 'email_delivery_identity_immutable'
        using errcode = '55000',
              detail = 'Email delivery rows are deleted only with their wedding or party.';
    end if;
    return old;
  end if;

  if new.id is distinct from old.id
     or new.wedding_id is distinct from old.wedding_id
     or new.guest_invitation_id is distinct from old.guest_invitation_id
     or new.kind is distinct from old.kind
     or new.provider_message_id is distinct from old.provider_message_id
     or new.recipient is distinct from old.recipient
     or new.accepted_at is distinct from old.accepted_at then
    raise exception 'email_delivery_identity_immutable'
      using errcode = '55000',
            detail = 'An email delivery''s identity never changes.';
  end if;

  -- The enum is declared in rank order, so its own ordering IS the rank
  -- (a DB test pins it to email_delivery_status_rank). No function call: the
  -- guard runs with the caller's privileges, and service_role has no access
  -- to schema private.
  if new.status is distinct from old.status then
    if new.status <= old.status then
      raise exception 'email_delivery_status_regression'
        using errcode = '55000',
              detail = 'A delivery status only moves to a higher rank.';
    end if;
  elsif new.status_event_at is distinct from old.status_event_at then
    raise exception 'email_delivery_status_invalid'
      using errcode = '55000',
            detail = 'status_event_at changes only when the status advances.';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------- event table

create table public.email_delivery_events (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null,
  wedding_id uuid not null,
  -- The provider's event id (the svix-id header): the same for every retry
  -- of one event, so it is the deduplication key.
  provider_event_id text not null,
  event_type public.email_delivery_event_type not null,
  bounce_type public.email_bounce_type,
  -- The provider's event time (top-level created_at). History only: it
  -- never decides precedence.
  occurred_at timestamptz not null,
  -- Database clock (the guard overwrites any supplied value).
  received_at timestamptz not null default now(),

  constraint email_delivery_events_provider_event_id_unique unique (provider_event_id),
  -- Same-wedding invariant; the delivery's cascade (party or wedding
  -- deletion) removes its events.
  constraint email_delivery_events_delivery_same_wedding
    foreign key (delivery_id, wedding_id)
    references public.email_deliveries (id, wedding_id)
    on delete cascade,
  constraint email_delivery_events_provider_event_id_valid check (
    provider_event_id ~ '^[A-Za-z0-9_-]{1,128}$'
  ),
  -- A bounce always says which kind (undetermined when the provider didn't);
  -- no other event has one.
  constraint email_delivery_events_bounce_type_only_for_bounces check (
    (event_type = 'bounced') = (bounce_type is not null)
  )
);

comment on table public.email_delivery_events is
  'LB-18.2 (ADR-011 §7): append-only provider delivery events, one per provider event id. Internal audit: no client role reads or writes it. Written only by ingest_email_delivery_event. Stores no recipient, subject, sender, payload, reason text, link, IP or user agent.';

create index email_delivery_events_delivery_idx
  on public.email_delivery_events (delivery_id, wedding_id, occurred_at);

-- Append-only, for EVERY role: no updates; deletes only through the
-- delivery's cascade (trigger depth ≥ 2).
create function private.guard_email_delivery_events()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.received_at := now();
    return new;
  end if;

  if tg_op = 'DELETE' and pg_catalog.pg_trigger_depth() >= 2 then
    return old;
  end if;

  raise exception 'email_delivery_event_immutable'
    using errcode = '55000',
          detail = 'Delivery events are append-only.';
end;
$$;

revoke all on function private.guard_email_delivery_events() from public;

create trigger email_delivery_events_guard
  before insert or update or delete on public.email_delivery_events
  for each row execute function private.guard_email_delivery_events();

-- No client role, and not even service_role directly: the one SECURITY
-- DEFINER ingest function below is the only writer, and nothing reads it yet.
alter table public.email_delivery_events enable row level security;
revoke all on table public.email_delivery_events from public, anon, authenticated, service_role;

-- -------------------------------------------------------- the one writer

-- service_role only (ADR-002 §6, ADR-011 §7). Called by the server-only
-- delivery event store after the webhook route verified the provider's
-- signature and normalized the event. One transaction:
--   1. find the recorded email by the provider's email id (none → unknown_message, nothing written);
--   2. lock it;
--   3. insert the event, deduplicated by provider_event_id (already there → duplicate, nothing changed);
--   4. advance status/status_event_at only if the event's status outranks the current one.
-- Concurrent deliveries of one event serialize on the row lock and the
-- unique constraint: exactly one row, at most one transition.
create function public.ingest_email_delivery_event(
  provider_event_id text,
  provider_message_id text,
  event_type public.email_delivery_event_type,
  occurred_at timestamptz,
  bounce_type public.email_bounce_type default null
)
returns public.email_delivery_ingest_outcome
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_delivery_id uuid;
  v_wedding_id uuid;
  v_current public.email_delivery_status;
  v_incoming public.email_delivery_status;
  v_event_row_id uuid;
begin
  if ingest_email_delivery_event.provider_event_id is null
     or ingest_email_delivery_event.provider_event_id !~ '^[A-Za-z0-9_-]{1,128}$'
     or ingest_email_delivery_event.provider_message_id is null
     or ingest_email_delivery_event.provider_message_id !~ '^[A-Za-z0-9._:-]{1,200}$'
     or ingest_email_delivery_event.event_type is null
     or ingest_email_delivery_event.occurred_at is null
     or not pg_catalog.isfinite(ingest_email_delivery_event.occurred_at)
     or ((ingest_email_delivery_event.event_type = 'bounced') <> (ingest_email_delivery_event.bounce_type is not null)) then
    raise exception 'email_delivery_event_invalid' using errcode = '22023';
  end if;

  select d.id, d.wedding_id, d.status into v_delivery_id, v_wedding_id, v_current
  from public.email_deliveries d
  where d.provider_message_id = ingest_email_delivery_event.provider_message_id
  for update;

  if not found then
    return 'unknown_message'::public.email_delivery_ingest_outcome;
  end if;

  insert into public.email_delivery_events (delivery_id, wedding_id, provider_event_id, event_type, bounce_type, occurred_at)
  values (
    v_delivery_id,
    v_wedding_id,
    ingest_email_delivery_event.provider_event_id,
    ingest_email_delivery_event.event_type,
    ingest_email_delivery_event.bounce_type,
    ingest_email_delivery_event.occurred_at
  )
  on conflict on constraint email_delivery_events_provider_event_id_unique do nothing
  returning id into v_event_row_id;

  if v_event_row_id is null then
    return 'duplicate'::public.email_delivery_ingest_outcome;
  end if;

  v_incoming := case ingest_email_delivery_event.event_type
    when 'delivered' then 'delivered'
    when 'delivery_delayed' then 'delayed'
    when 'failed' then 'failed'
    when 'suppressed' then 'suppressed'
    when 'bounced' then 'bounced'
    when 'complained' then 'complained'
  end::public.email_delivery_status;

  if private.email_delivery_status_rank(v_incoming) <= private.email_delivery_status_rank(v_current) then
    return 'no_change'::public.email_delivery_ingest_outcome;
  end if;

  update public.email_deliveries d
     set status = v_incoming,
         status_event_at = ingest_email_delivery_event.occurred_at
   where d.id = v_delivery_id;

  return 'applied'::public.email_delivery_ingest_outcome;
end;
$$;

comment on function public.ingest_email_delivery_event(text, text, public.email_delivery_event_type, timestamptz, public.email_bounce_type) is
  'service_role only (ADR-002 §6, ADR-011 §7): ingests one signature-verified, normalized provider delivery event. Correlates by provider email id only; dedupes by provider event id; advances status by rank only. Returns a closed outcome, never ids.';

revoke all on function public.ingest_email_delivery_event(text, text, public.email_delivery_event_type, timestamptz, public.email_bounce_type)
  from public, anon, authenticated;
grant execute on function public.ingest_email_delivery_event(text, text, public.email_delivery_event_type, timestamptz, public.email_bounce_type)
  to service_role;
