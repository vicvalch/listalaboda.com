-- LB-18.1: email delivery ledger (ADR-011). Persistence foundation only.
--
-- Provider acceptance is not delivery, and the per-flow *_provider_id
-- columns keep only the LATEST send of each channel (manual and automatic
-- reminders even share one), so a later provider delivery event can't be
-- mapped back to the send it is about. This migration adds the missing
-- identity: one immutable row per provider-accepted email that the
-- application successfully recorded, keyed by the provider's email id.
--
-- Hybrid model (ADR-011 §2): the existing business metadata on
-- guest_invitations (sent_at / sent_to / provider_id, latest only) is
-- unchanged and still read by every current flow; the ledger is additive.
--
-- Written ONLY inside the four existing record functions, in the same
-- transaction as their metadata and activity row, through one private
-- helper. Their signatures, grants and checks are unchanged. A record that
-- fails (or a send the application reports as sent_but_unrecorded /
-- sent_unrecorded) leaves no ledger row: the whole transaction rolls back.
--
-- Not here (later LB-18 slices): delivery status columns, the provider
-- event table, webhook ingestion, UI, suppression and eligibility changes.
-- Nothing is backfilled: sends recorded before this migration have no
-- ledger row (delivery status unavailable).

-- ----------------------------------------------------------------- type

create type public.email_delivery_kind as enum (
  'guest_invitation',         -- LB-11, record_guest_invitation_email
  'rsvp_confirmation',        -- LB-12, record_rsvp_confirmation_email
  'rsvp_reminder_manual',     -- LB-14, record_rsvp_reminder_email
  'rsvp_reminder_automatic'   -- LB-17, record_automatic_rsvp_reminder_email
);

comment on type public.email_delivery_kind is
  'LB-18.1 (ADR-011): which application email a ledger row records. One value per record function.';

-- ---------------------------------------------------------------- table

create table public.email_deliveries (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  guest_invitation_id uuid not null,
  kind public.email_delivery_kind not null,
  -- The provider's email id, exactly as EmailSender.send returned it (the
  -- same value the latest-send *_provider_id column receives). The future
  -- correlation key for provider delivery events; never readable by clients.
  provider_message_id text not null,
  -- The address the provider accepted: the party's contact email at record
  -- time (the record functions require it to equal the current one).
  recipient text not null,
  -- Database clock of the record transaction (the guard overwrites any
  -- supplied value): equals the matching *_sent_at the same call wrote.
  accepted_at timestamptz not null default now(),

  constraint email_deliveries_provider_message_id_unique unique (provider_message_id),
  -- Same-wedding invariant (ADR-001 §2). Deleting the party deletes its
  -- ledger rows: no recipient address outlives the party it was sent for.
  constraint email_deliveries_party_same_wedding
    foreign key (guest_invitation_id, wedding_id)
    references public.guest_invitations (id, wedding_id)
    on delete cascade,
  -- The storable provider id contract (isStorableMessageId, the record
  -- functions' own check, the *_provider_id CHECKs).
  constraint email_deliveries_provider_message_id_valid check (
    provider_message_id ~ '^[A-Za-z0-9._:-]{1,200}$'
  ),
  -- The repository's email invariant, identical to the *_sent_to CHECKs.
  constraint email_deliveries_recipient_valid check (
    char_length(recipient) <= 254
    and char_length(split_part(recipient, '@', 1)) <= 64
    and recipient ~ '^[A-Za-z0-9!#$%&''*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&''*+/=?^_`{|}~-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
  )
);

comment on table public.email_deliveries is
  'LB-18.1 (ADR-011): one immutable identity row per provider-accepted application email that was successfully recorded. Written only by the four record functions, in their transaction. No backfill.';
comment on column public.email_deliveries.provider_message_id is
  'Provider email id from EmailSender.send (unique). Future correlation key for delivery events. Never readable by clients.';
comment on column public.email_deliveries.recipient is
  'The address the provider accepted (the party''s contact email at record time). PRIVATE: wedding members only.';
comment on column public.email_deliveries.accepted_at is
  'Database clock of the record transaction (equals the matching *_sent_at).';

-- Latest delivery per party and kind (LB-18.3 status), and the party FK
-- (leading guest_invitation_id) for cascades.
create index email_deliveries_party_kind_latest_idx
  on public.email_deliveries (guest_invitation_id, kind, accepted_at desc);
-- One wedding's deliveries (the member RLS read of a whole guest page) and
-- the wedding FK's cascade.
create index email_deliveries_wedding_idx
  on public.email_deliveries (wedding_id);

-- --------------------------------------------------------- identity guard

-- For EVERY role, including the record functions' owner and service_role:
--   * INSERT: accepted_at is the database clock (a supplied value is
--     replaced);
--   * UPDATE: the identity columns never change. There are no other columns
--     yet; LB-18.2's delivery status columns will be the only updatable ones;
--   * DELETE: refused, except the foreign keys' ON DELETE CASCADE (run from
--     the referential trigger, so the trigger depth is at least 2): deleting
--     the wedding or the party deletes its ledger rows; nothing else does.
-- (A superuser can still disable triggers; that is outside the app's
-- boundary and not something this guard claims to stop.)
create function private.guard_email_deliveries()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
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
  return new;
end;
$$;

revoke all on function private.guard_email_deliveries() from public;

create trigger email_deliveries_guard
  before insert or update or delete on public.email_deliveries
  for each row execute function private.guard_email_deliveries();

-- ------------------------------------------------------------ privileges
--
-- Members (owners and collaborators) read what the guest page will show,
-- like the latest-send metadata they already read: never the provider id.
-- No client role inserts, updates or deletes; anon has nothing.

alter table public.email_deliveries enable row level security;
revoke all on table public.email_deliveries from public, anon, authenticated;

grant select (id, wedding_id, guest_invitation_id, kind, recipient, accepted_at)
  on table public.email_deliveries to authenticated;

create policy email_deliveries_select_member
  on public.email_deliveries for select
  to authenticated
  using (private.is_wedding_member(wedding_id));

-- -------------------------------------------------- the one ledger writer

-- Called only from the four record functions below (SECURITY DEFINER, as
-- their owner), after their metadata update succeeded. A reused provider id
-- fails the record (uniform error; the provider id is not echoed) and rolls
-- back the whole transaction: the caller reports sent_but_unrecorded /
-- sent_unrecorded, exactly as for any other record failure.
create function private.record_email_delivery(
  target_wedding_id uuid,
  target_invitation_id uuid,
  delivery_kind public.email_delivery_kind,
  provider_message_id text,
  recipient text
)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  insert into public.email_deliveries (wedding_id, guest_invitation_id, kind, provider_message_id, recipient)
  values (
    record_email_delivery.target_wedding_id,
    record_email_delivery.target_invitation_id,
    record_email_delivery.delivery_kind,
    record_email_delivery.provider_message_id,
    record_email_delivery.recipient
  );
exception
  when unique_violation then
    raise exception 'email_delivery_not_recorded' using errcode = 'P0001';
end;
$$;

comment on function private.record_email_delivery(uuid, uuid, public.email_delivery_kind, text, text) is
  'LB-18.1 (ADR-011): inserts one email_deliveries row. Called only inside the four record functions'' transactions.';

revoke all on function private.record_email_delivery(uuid, uuid, public.email_delivery_kind, text, text)
  from public, anon, authenticated;

-- ------------------------------------------- record_guest_invitation_email

-- Replaced (ADR-004, ADR-008; unchanged otherwise): also writes the ledger
-- row (guest_invitation) in the same transaction. Same signature, so the
-- service_role-only grant is kept.
create or replace function public.record_guest_invitation_email(
  target_wedding_id uuid,
  target_invitation_id uuid,
  invitation_token_hash text,
  recipient text,
  provider_message_id text,
  acting_user_id uuid
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sent_at timestamptz;
  v_sent_to text;
begin
  if record_guest_invitation_email.provider_message_id is null
     or record_guest_invitation_email.provider_message_id !~ '^[A-Za-z0-9._:-]{1,200}$' then
    raise exception 'guest_invitation_email_not_recorded' using errcode = '22023';
  end if;

  if record_guest_invitation_email.acting_user_id is null or not exists (
    select 1 from public.wedding_memberships m
    where m.wedding_id = record_guest_invitation_email.target_wedding_id
      and m.user_id = record_guest_invitation_email.acting_user_id
  ) then
    raise exception 'guest_invitation_email_not_recorded' using errcode = 'P0001';
  end if;

  update public.guest_invitations i
     set invitation_email_sent_at = now(),
         invitation_email_sent_to = i.contact_email,
         invitation_email_provider_id = record_guest_invitation_email.provider_message_id
   where i.id = record_guest_invitation_email.target_invitation_id
     and i.wedding_id = record_guest_invitation_email.target_wedding_id
     and i.token_hash = record_guest_invitation_email.invitation_token_hash
     and i.contact_email is not null
     and i.contact_email = record_guest_invitation_email.recipient
  returning i.invitation_email_sent_at, i.invitation_email_sent_to into v_sent_at, v_sent_to;

  if not found then
    raise exception 'guest_invitation_email_not_recorded' using errcode = 'P0001';
  end if;

  -- LB-15: no recipient, provider id or link in the history row.
  insert into public.wedding_activity (wedding_id, event_type, guest_invitation_id, actor_kind, actor_user_id)
  values (
    record_guest_invitation_email.target_wedding_id,
    'guest_invitation_email_sent',
    record_guest_invitation_email.target_invitation_id,
    'member',
    record_guest_invitation_email.acting_user_id
  );

  -- LB-18.1: the send's ledger identity.
  perform private.record_email_delivery(
    record_guest_invitation_email.target_wedding_id,
    record_guest_invitation_email.target_invitation_id,
    'guest_invitation',
    record_guest_invitation_email.provider_message_id,
    v_sent_to
  );
  return v_sent_at;
end;
$$;

comment on function public.record_guest_invitation_email(uuid, uuid, text, text, text, uuid) is
  'service_role only (ADR-004, ADR-008, ADR-011): records a party''s latest successful invitation email (database clock), its activity row and its email_deliveries row, atomically. The only writer of the send metadata.';

-- ------------------------------------------ record_rsvp_confirmation_email

-- Replaced (ADR-005, ADR-008; unchanged otherwise): also writes the ledger
-- row (rsvp_confirmation). Every successful confirmation gets its own row,
-- although the latest-send columns keep only the newest.
create or replace function public.record_rsvp_confirmation_email(
  target_wedding_id uuid,
  target_invitation_id uuid,
  invitation_token_hash text,
  recipient text,
  provider_message_id text
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sent_at timestamptz;
  v_sent_to text;
begin
  if record_rsvp_confirmation_email.provider_message_id is null
     or record_rsvp_confirmation_email.provider_message_id !~ '^[A-Za-z0-9._:-]{1,200}$' then
    raise exception 'rsvp_confirmation_email_not_recorded' using errcode = '22023';
  end if;

  update public.guest_invitations i
     set rsvp_confirmation_email_sent_at = now(),
         rsvp_confirmation_email_sent_to = i.contact_email,
         rsvp_confirmation_email_provider_id = record_rsvp_confirmation_email.provider_message_id
   where i.id = record_rsvp_confirmation_email.target_invitation_id
     and i.wedding_id = record_rsvp_confirmation_email.target_wedding_id
     and i.token_hash = record_rsvp_confirmation_email.invitation_token_hash
     and i.contact_email is not null
     and i.contact_email = record_rsvp_confirmation_email.recipient
  returning i.rsvp_confirmation_email_sent_at, i.rsvp_confirmation_email_sent_to into v_sent_at, v_sent_to;

  if not found then
    raise exception 'rsvp_confirmation_email_not_recorded' using errcode = 'P0001';
  end if;

  insert into public.wedding_activity (wedding_id, event_type, guest_invitation_id, actor_kind, actor_user_id)
  values (
    record_rsvp_confirmation_email.target_wedding_id,
    'rsvp_confirmation_email_sent',
    record_rsvp_confirmation_email.target_invitation_id,
    'guest_capability',
    null
  );

  -- LB-18.1: the send's ledger identity.
  perform private.record_email_delivery(
    record_rsvp_confirmation_email.target_wedding_id,
    record_rsvp_confirmation_email.target_invitation_id,
    'rsvp_confirmation',
    record_rsvp_confirmation_email.provider_message_id,
    v_sent_to
  );
  return v_sent_at;
end;
$$;

comment on function public.record_rsvp_confirmation_email(uuid, uuid, text, text, text) is
  'service_role only (ADR-005, ADR-008, ADR-011): records a party''s latest successful RSVP confirmation email (database clock), its activity row and its email_deliveries row, atomically. The only writer of the confirmation metadata.';

-- ---------------------------------------------- record_rsvp_reminder_email

-- Replaced (ADR-007, ADR-008; unchanged otherwise): also writes the ledger
-- row. This function records MANUAL reminders only (automatic ones have
-- their own record function below), so the kind is rsvp_reminder_manual.
create or replace function public.record_rsvp_reminder_email(
  target_wedding_id uuid,
  target_invitation_id uuid,
  invitation_token_hash text,
  recipient text,
  provider_message_id text,
  acting_user_id uuid
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sent_at timestamptz;
  v_sent_to text;
begin
  if record_rsvp_reminder_email.provider_message_id is null
     or record_rsvp_reminder_email.provider_message_id !~ '^[A-Za-z0-9._:-]{1,200}$' then
    raise exception 'rsvp_reminder_email_not_recorded' using errcode = '22023';
  end if;

  if record_rsvp_reminder_email.acting_user_id is null or not exists (
    select 1 from public.wedding_memberships m
    where m.wedding_id = record_rsvp_reminder_email.target_wedding_id
      and m.user_id = record_rsvp_reminder_email.acting_user_id
  ) then
    raise exception 'rsvp_reminder_email_not_recorded' using errcode = 'P0001';
  end if;

  update public.guest_invitations i
     set rsvp_reminder_email_sent_at = now(),
         rsvp_reminder_email_sent_to = i.contact_email,
         rsvp_reminder_email_provider_id = record_rsvp_reminder_email.provider_message_id
    from public.weddings w
   where w.id = i.wedding_id
     and i.id = record_rsvp_reminder_email.target_invitation_id
     and i.wedding_id = record_rsvp_reminder_email.target_wedding_id
     and i.token_hash = record_rsvp_reminder_email.invitation_token_hash
     and i.revoked_at is null
     and now() < private.guest_invitation_expires_at(i.token_issued_at, w.wedding_date)
     and i.contact_email is not null
     and i.contact_email = record_rsvp_reminder_email.recipient
  returning i.rsvp_reminder_email_sent_at, i.rsvp_reminder_email_sent_to into v_sent_at, v_sent_to;

  if not found then
    raise exception 'rsvp_reminder_email_not_recorded' using errcode = 'P0001';
  end if;

  insert into public.wedding_activity (wedding_id, event_type, guest_invitation_id, actor_kind, actor_user_id)
  values (
    record_rsvp_reminder_email.target_wedding_id,
    'rsvp_reminder_email_sent',
    record_rsvp_reminder_email.target_invitation_id,
    'member',
    record_rsvp_reminder_email.acting_user_id
  );

  -- LB-18.1: the send's ledger identity.
  perform private.record_email_delivery(
    record_rsvp_reminder_email.target_wedding_id,
    record_rsvp_reminder_email.target_invitation_id,
    'rsvp_reminder_manual',
    record_rsvp_reminder_email.provider_message_id,
    v_sent_to
  );
  return v_sent_at;
end;
$$;

comment on function public.record_rsvp_reminder_email(uuid, uuid, text, text, text, uuid) is
  'service_role only (ADR-007, ADR-008, ADR-011): records a party''s latest successful manual RSVP reminder email (database clock), its activity row and its email_deliveries row, atomically. The only writer of the manual reminder metadata.';

-- ----------------------------------- record_automatic_rsvp_reminder_email

-- Replaced (ADR-010; unchanged otherwise): also writes the ledger row
-- (rsvp_reminder_automatic) in the same transaction as the metadata, the
-- system activity row and sending → sent. If anything here raises, nothing
-- is written and the runner reports sent_unrecorded through finish.
create or replace function public.record_automatic_rsvp_reminder_email(
  target_occurrence_id uuid,
  occurrence_claim_token uuid,
  invitation_token_hash text,
  recipient text,
  provider_message_id text
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_party_id uuid;
  v_occurrence public.automatic_rsvp_reminders;
  v_sent_at timestamptz;
  v_sent_to text;
begin
  if record_automatic_rsvp_reminder_email.provider_message_id is null
     or record_automatic_rsvp_reminder_email.provider_message_id !~ '^[A-Za-z0-9._:-]{1,200}$' then
    raise exception 'automatic_rsvp_reminder_not_recorded' using errcode = '22023';
  end if;

  select o.guest_invitation_id into v_party_id
  from public.automatic_rsvp_reminders o
  where o.id = record_automatic_rsvp_reminder_email.target_occurrence_id;
  if not found then
    raise exception 'automatic_rsvp_reminder_not_recorded' using errcode = 'P0001';
  end if;

  perform 1 from public.guest_invitations i where i.id = v_party_id for update;

  select * into v_occurrence
  from public.automatic_rsvp_reminders o
  where o.id = record_automatic_rsvp_reminder_email.target_occurrence_id
  for update;

  if not found
     or v_occurrence.state <> 'sending'
     or v_occurrence.claim_token is distinct from record_automatic_rsvp_reminder_email.occurrence_claim_token then
    raise exception 'automatic_rsvp_reminder_not_recorded' using errcode = 'P0001';
  end if;

  update public.guest_invitations i
     set rsvp_reminder_email_sent_at = now(),
         rsvp_reminder_email_sent_to = i.contact_email,
         rsvp_reminder_email_provider_id = record_automatic_rsvp_reminder_email.provider_message_id
    from public.weddings w
   where w.id = i.wedding_id
     and i.id = v_occurrence.guest_invitation_id
     and i.wedding_id = v_occurrence.wedding_id
     and i.token_hash = record_automatic_rsvp_reminder_email.invitation_token_hash
     and i.revoked_at is null
     and now() < private.guest_invitation_expires_at(i.token_issued_at, w.wedding_date)
     and i.contact_email is not null
     and i.contact_email = record_automatic_rsvp_reminder_email.recipient
  returning i.rsvp_reminder_email_sent_at, i.rsvp_reminder_email_sent_to into v_sent_at, v_sent_to;

  if not found then
    raise exception 'automatic_rsvp_reminder_not_recorded' using errcode = 'P0001';
  end if;

  insert into public.wedding_activity (wedding_id, event_type, guest_invitation_id, actor_kind, actor_user_id)
  values (v_occurrence.wedding_id, 'rsvp_reminder_email_sent', v_occurrence.guest_invitation_id, 'system', null);

  -- LB-18.1: the send's ledger identity.
  perform private.record_email_delivery(
    v_occurrence.wedding_id,
    v_occurrence.guest_invitation_id,
    'rsvp_reminder_automatic',
    record_automatic_rsvp_reminder_email.provider_message_id,
    v_sent_to
  );

  update public.automatic_rsvp_reminders o
     set state = 'sent', sent_at = v_sent_at, claim_token = null, lease_expires_at = null
   where o.id = v_occurrence.id;

  return v_sent_at;
end;
$$;

comment on function public.record_automatic_rsvp_reminder_email(uuid, uuid, text, text, text) is
  'service_role only (ADR-010, ADR-011): after the provider accepted, atomically writes the latest-reminder metadata, the system activity row, the email_deliveries row and sending → sent. Raises (changing nothing) otherwise.';
