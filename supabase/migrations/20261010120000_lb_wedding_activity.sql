-- LB-15: basic wedding activity history (Constitution §8 Phase 2 "Basic wedding
-- activity history"; ADR-001 §8; ADR-008).
--
-- A Wedding-scoped, append-only, chronological record of the important
-- GuestInvitation / RSVP facts: a party was created, its link was replaced or
-- revoked, its contact email changed, it answered (first time / again), and
-- an invitation, confirmation or reminder email was accepted by the provider
-- and recorded. Not logging, analytics, an event bus or an audit dump.
--
-- Invariants enforced here:
--   * every row belongs to exactly one wedding and is readable only by its
--     members (RLS); anon, guests and outsiders read nothing;
--   * no client role can insert, update or delete a row (no grants). Rows are
--     written ONLY inside the business functions below, in the same
--     transaction as the fact they describe: if the activity insert fails,
--     the business write rolls back, and vice versa;
--   * a row never changes after insert, for every role, except the two
--     referential actions of its foreign keys (a deleted party or account
--     nulls its reference; a deleted wedding takes its history with it);
--   * the event type and the actor kind are closed enums; the time is the
--     database clock; there is no free-form payload, text or JSON;
--   * no capability material (token, hash, envelope, URL), no RSVP answers or
--     notes, no email addresses and no provider ids are stored;
--   * nothing is backfilled: history begins when this migration runs.

-- ---------------------------------------------------------------- types

create type public.wedding_activity_event as enum (
  'guest_invitation_created',
  'guest_invitation_link_rotated',
  'guest_invitation_revoked',
  'guest_invitation_contact_email_changed',
  'guest_invitation_email_sent',
  'guest_rsvp_submitted',
  'guest_rsvp_updated',
  'rsvp_confirmation_email_sent',
  'rsvp_reminder_email_sent'
);

comment on type public.wedding_activity_event is
  'LB-15: the closed set of wedding activity events. Copy lives in the app (es.activity), never in the database.';

-- Who caused the fact:
--   member           — a signed-in wedding member (actor_user_id = auth.uid(),
--                      or, for a member-initiated email, the id the server
--                      derived from its authenticated WeddingAccess, which
--                      the recorder checks is a member of the wedding;
--                      attribution only, never authorization);
--   guest_capability — the holder of a party's RSVP link (no account, no id;
--                      the token is never an identity);
--   system           — no person: privileged maintenance outside the app's
--                      member flows. Normal app flows don't produce it today.
create type public.wedding_activity_actor as enum ('member', 'guest_capability', 'system');

comment on type public.wedding_activity_actor is
  'LB-15: who caused a wedding activity event. Only member rows carry a user id.';

-- ---------------------------------------------------------------- table

create table public.wedding_activity (
  id uuid primary key default gen_random_uuid(),
  -- The tenant. History never outlives its wedding.
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  event_type public.wedding_activity_event not null,
  -- The party the event is about. Required at insert (every LB-15 event is
  -- about a party); nulled when the party is deleted, so its history stays.
  guest_invitation_id uuid,
  actor_kind public.wedding_activity_actor not null,
  -- Set only for member actors; nulled if the account is deleted (the row
  -- then reads as a former member). Never a guest or a service identity.
  actor_user_id uuid references auth.users (id) on delete set null,
  -- Database clock, always (the insert guard overwrites any supplied value).
  occurred_at timestamptz not null default now(),
  -- Same-wedding invariant (ADR-001 §2). Deleting the party nulls ONLY the
  -- party reference (PostgreSQL 15+ column list): the row keeps its wedding.
  constraint wedding_activity_guest_invitation_same_wedding
    foreign key (guest_invitation_id, wedding_id)
    references public.guest_invitations (id, wedding_id)
    on delete set null (guest_invitation_id),
  -- Guests and the system never carry a user id.
  constraint wedding_activity_actor_user_only_for_members
    check (actor_kind = 'member' or actor_user_id is null)
);

comment on table public.wedding_activity is
  'LB-15 (ADR-008): append-only wedding activity history. Written only by the business functions, in the same transaction; members read it. No tokens, answers, notes, emails or provider data.';
comment on column public.wedding_activity.guest_invitation_id is
  'The party the event is about; null once that party was deleted (the history stays).';
comment on column public.wedding_activity.actor_user_id is
  'The member who caused the event (member actors only); null for guests and system, or after the account was deleted. Never shown as a label.';

-- The read path: one wedding's newest events first, bounded.
create index wedding_activity_wedding_recent_idx
  on public.wedding_activity (wedding_id, occurred_at desc, id desc);

-- Serves the party foreign key's ON DELETE SET NULL (a party deletion finds
-- its rows without scanning the wedding's whole history).
create index wedding_activity_guest_invitation_idx
  on public.wedding_activity (guest_invitation_id, wedding_id);

alter table public.wedding_activity enable row level security;
revoke all on table public.wedding_activity from public, anon, authenticated;

-- Members (owner or collaborator) read their wedding's history. Nobody gets
-- INSERT, UPDATE or DELETE: there is no client write path at all.
grant select on table public.wedding_activity to authenticated;

create policy wedding_activity_select_member
  on public.wedding_activity for select
  to authenticated
  using (private.is_wedding_member(wedding_id));

-- ------------------------------------------------------ append-only guard

-- For EVERY role, including the business functions' owner and service_role:
--   * INSERT: a member actor must name its user; every event names its
--     party; the time is the database clock (a supplied value is replaced);
--   * UPDATE: refused, except the foreign keys' own ON DELETE SET NULL
--     actions (run from the referential trigger, so the trigger depth is
--     at least 2), which may only null guest_invitation_id / actor_user_id;
--   * DELETE: refused, except the wedding's ON DELETE CASCADE (same depth
--     rule). Deleting a wedding deletes its history; nothing else does.
-- (A superuser can still disable triggers; that is outside the app's
-- boundary and not something this guard claims to stop.)
create function private.guard_wedding_activity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.actor_kind = 'member' and new.actor_user_id is null then
      raise exception 'wedding_activity_actor_required' using errcode = '23514';
    end if;
    if new.guest_invitation_id is null then
      raise exception 'wedding_activity_subject_required' using errcode = '23514';
    end if;
    new.occurred_at := now();
    return new;
  end if;

  if pg_catalog.pg_trigger_depth() < 2 then
    raise exception 'wedding_activity_append_only'
      using errcode = '55000',
            detail = 'Wedding activity is history: it is never edited or deleted.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if new.id is distinct from old.id
     or new.wedding_id is distinct from old.wedding_id
     or new.event_type is distinct from old.event_type
     or new.actor_kind is distinct from old.actor_kind
     or new.occurred_at is distinct from old.occurred_at
     or (new.guest_invitation_id is distinct from old.guest_invitation_id
         and new.guest_invitation_id is not null)
     or (new.actor_user_id is distinct from old.actor_user_id
         and new.actor_user_id is not null) then
    raise exception 'wedding_activity_append_only'
      using errcode = '55000',
            detail = 'Wedding activity is history: it is never edited or deleted.';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_wedding_activity() from public;

create trigger wedding_activity_guard
  before insert or update or delete on public.wedding_activity
  for each row execute function private.guard_wedding_activity();

-- ------------------------------------------------ create_guest_invitation

-- Unchanged contract (LB-13); now also appends guest_invitation_created, by
-- the calling member, in the same transaction as the party, its guests and
-- its envelope.
create or replace function public.create_guest_invitation(
  target_wedding_id uuid,
  party_label text,
  invitation_token_hash text,
  invitation_token_ciphertext text,
  guest_names text[],
  party_contact_email text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
  v_invitation_id uuid;
begin
  if v_caller is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  -- What the guest_invitations insert policy checked; a missing wedding is
  -- the same refusal as someone else's.
  if not private.is_wedding_member(create_guest_invitation.target_wedding_id) then
    raise exception 'guest_invitation_not_allowed' using errcode = '42501';
  end if;

  -- The contact email arrives normalized; the CHECK rejects anything else.
  insert into public.guest_invitations (wedding_id, label, token_hash, contact_email, created_by)
  values (
    create_guest_invitation.target_wedding_id,
    create_guest_invitation.party_label,
    create_guest_invitation.invitation_token_hash,
    create_guest_invitation.party_contact_email,
    v_caller
  )
  returning id into v_invitation_id;

  -- Names arrive normalized from the server; the CHECK rejects anything
  -- else. Order is kept: guests.created_at defaults to clock_timestamp(),
  -- which advances row by row. The deferred trigger requires at least one
  -- guest; there is no maximum.
  insert into public.guests (wedding_id, guest_invitation_id, name)
  select create_guest_invitation.target_wedding_id, v_invitation_id, n.name
  from unnest(coalesce(create_guest_invitation.guest_names, '{}'::text[]))
         with ordinality as n (name, position)
  order by n.position;

  -- The link's envelope, bound to the hash just written (the CHECK refuses
  -- anything that isn't the v1 shape, rolling the whole party back).
  insert into private.guest_invitation_capability_secrets
    (guest_invitation_id, wedding_id, token_hash, token_ciphertext)
  values (
    v_invitation_id,
    create_guest_invitation.target_wedding_id,
    create_guest_invitation.invitation_token_hash,
    create_guest_invitation.invitation_token_ciphertext
  );

  -- LB-15: the history row commits with the party, or neither does.
  insert into public.wedding_activity (wedding_id, event_type, guest_invitation_id, actor_kind, actor_user_id)
  values (create_guest_invitation.target_wedding_id, 'guest_invitation_created', v_invitation_id, 'member', v_caller);

  return v_invitation_id;
end;
$$;

comment on function public.create_guest_invitation(uuid, text, text, text, text[], text) is
  'Members only (checked from auth.uid()): creates a guest party with its first guests, optional contact email, recoverable link envelope and its activity row, atomically. The only way to create a party.';

-- ----------------------------------------- rotate_guest_invitation_link

-- Unchanged contract (LB-13); now also appends guest_invitation_link_rotated,
-- by the calling owner, in the same transaction as the new hash and
-- envelope. Neither the old nor the new hash is recorded.
create or replace function public.rotate_guest_invitation_link(
  target_wedding_id uuid,
  target_invitation_id uuid,
  invitation_token_hash text,
  invitation_token_ciphertext text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.is_wedding_member(rotate_guest_invitation_link.target_wedding_id) then
    return false;
  end if;
  if not private.has_wedding_role(
    rotate_guest_invitation_link.target_wedding_id,
    array['owner']::public.wedding_role[]
  ) then
    raise exception 'guest_link_owner_only'
      using errcode = '42501',
            detail = 'Only wedding owners can replace or revoke a guest link.';
  end if;

  update public.guest_invitations i
     set token_hash = rotate_guest_invitation_link.invitation_token_hash
   where i.id = rotate_guest_invitation_link.target_invitation_id
     and i.wedding_id = rotate_guest_invitation_link.target_wedding_id;
  if not found then
    return false;
  end if;

  -- Replaces the party's envelope (pre-LB-13 parties get their first one).
  insert into private.guest_invitation_capability_secrets as s
    (guest_invitation_id, wedding_id, token_hash, token_ciphertext)
  values (
    rotate_guest_invitation_link.target_invitation_id,
    rotate_guest_invitation_link.target_wedding_id,
    rotate_guest_invitation_link.invitation_token_hash,
    rotate_guest_invitation_link.invitation_token_ciphertext
  )
  on conflict (guest_invitation_id) do update
    set token_hash = excluded.token_hash,
        token_ciphertext = excluded.token_ciphertext;

  -- LB-15: the history row commits with the rotation, or neither does.
  insert into public.wedding_activity (wedding_id, event_type, guest_invitation_id, actor_kind, actor_user_id)
  values (
    rotate_guest_invitation_link.target_wedding_id,
    'guest_invitation_link_rotated',
    rotate_guest_invitation_link.target_invitation_id,
    'member',
    auth.uid()
  );
  return true;
end;
$$;

comment on function public.rotate_guest_invitation_link(uuid, uuid, text, text) is
  'Owners only: replaces a party''s link hash and its recoverable envelope, and records it in the wedding activity, atomically. The only way to rotate a guest link.';

-- ------------------------------------------- revoke_guest_invitation_link

-- "Revocar acceso" (owner-only), now through ONE door so the revocation and
-- its history row commit together. Until LB-15 clients revoked with a plain
-- UPDATE of revoked_at; that column grant is removed below (the link guard
-- trigger still re-checks the owner role for any client write and stamps
-- the database clock).
--
-- Same authorization as before, checked here from auth.uid(): a non-member
-- (or a party of another wedding) gets false, like a missing party; a
-- collaborator gets guest_link_owner_only. Revoking an already revoked link
-- is a no-op success that records nothing (nothing happened).
create function public.revoke_guest_invitation_link(
  target_wedding_id uuid,
  target_invitation_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.is_wedding_member(revoke_guest_invitation_link.target_wedding_id) then
    return false;
  end if;
  if not private.has_wedding_role(
    revoke_guest_invitation_link.target_wedding_id,
    array['owner']::public.wedding_role[]
  ) then
    raise exception 'guest_link_owner_only'
      using errcode = '42501',
            detail = 'Only wedding owners can replace or revoke a guest link.';
  end if;

  -- The link guard trigger stamps revoked_at with the database clock.
  update public.guest_invitations i
     set revoked_at = now()
   where i.id = revoke_guest_invitation_link.target_invitation_id
     and i.wedding_id = revoke_guest_invitation_link.target_wedding_id
     and i.revoked_at is null;

  if found then
    insert into public.wedding_activity (wedding_id, event_type, guest_invitation_id, actor_kind, actor_user_id)
    values (
      revoke_guest_invitation_link.target_wedding_id,
      'guest_invitation_revoked',
      revoke_guest_invitation_link.target_invitation_id,
      'member',
      auth.uid()
    );
    return true;
  end if;

  -- Already revoked (fine, nothing recorded) or not a party of this wedding.
  return exists (
    select 1 from public.guest_invitations i
    where i.id = revoke_guest_invitation_link.target_invitation_id
      and i.wedding_id = revoke_guest_invitation_link.target_wedding_id
  );
end;
$$;

comment on function public.revoke_guest_invitation_link(uuid, uuid) is
  'Owners only: revokes a party''s current link and records it in the wedding activity, atomically. The only way to revoke a guest link.';

revoke all on function public.revoke_guest_invitation_link(uuid, uuid) from public, anon, authenticated;
grant execute on function public.revoke_guest_invitation_link(uuid, uuid) to authenticated;

-- The plain UPDATE door for revocation is closed: it would revoke without
-- history. Label and contact-email edits keep their column grants.
revoke update (revoked_at) on table public.guest_invitations from authenticated;

-- ----------------------------------------- contact email change history

-- Members keep editing the contact email with a plain, RLS-checked UPDATE
-- (LB-11, unchanged). This trigger appends guest_invitation_contact_email_changed
-- in the SAME statement, so the change and its history row commit together.
-- It records THAT the address changed (set, edited or removed), never the old
-- or new address. The actor is the signed-in member; a write with no member
-- session (privileged maintenance) is recorded as system. Setting the email
-- while creating a party is part of guest_invitation_created, not a change.
create function private.record_guest_invitation_contact_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is not null and not exists (
    select 1 from public.wedding_memberships m
    where m.wedding_id = new.wedding_id and m.user_id = v_actor
  ) then
    v_actor := null;
  end if;

  insert into public.wedding_activity (wedding_id, event_type, guest_invitation_id, actor_kind, actor_user_id)
  values (
    new.wedding_id,
    'guest_invitation_contact_email_changed',
    new.id,
    case when v_actor is null then 'system' else 'member' end::public.wedding_activity_actor,
    v_actor
  );
  return null;
end;
$$;

revoke all on function private.record_guest_invitation_contact_email_change() from public;

create trigger guest_invitations_contact_email_activity
  after update of contact_email on public.guest_invitations
  for each row
  when (old.contact_email is distinct from new.contact_email)
  execute function private.record_guest_invitation_contact_email_change();

-- ---------------------------------------------------- submit_guest_rsvp

-- Unchanged contract (LB-09); now also appends ONE history row for the
-- party's successful submission, in the same transaction as the answers:
--   * guest_rsvp_submitted — the party had no saved answer before this one;
--   * guest_rsvp_updated   — it had (every later save, changed or not: the
--     product treats each save as a new answer and confirms it, LB-12).
-- Decided from the stored rows under the party's row lock, never from the
-- payload. The actor is the link holder (no user id; the token is never an
-- identity). Answers and notes stay in rsvps only. Any refusal raises
-- before anything is written, history included.
create or replace function public.submit_guest_rsvp(invitation_token_hash text, responses jsonb)
returns table (
  party_label text,
  guest_id uuid,
  guest_name text,
  attending boolean,
  dietary_note text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_invitation public.guest_invitations;
  v_wedding_date date;
  v_response jsonb;
  v_party_size integer;
  v_answered integer;
  v_had_answers boolean;
begin
  -- Row lock: concurrent submissions (double clicks, two devices) and
  -- organizer edits of the same party serialize.
  select i.* into v_invitation
  from public.guest_invitations i
  where i.token_hash = submit_guest_rsvp.invitation_token_hash
  for update;

  if not found then
    raise exception 'guest_invitation_unavailable' using errcode = 'P0001';
  end if;

  select w.wedding_date into v_wedding_date
  from public.weddings w where w.id = v_invitation.wedding_id;

  if v_invitation.revoked_at is not null
     or now() >= private.guest_invitation_expires_at(v_invitation.token_issued_at, v_wedding_date) then
    raise exception 'guest_invitation_unavailable' using errcode = 'P0001';
  end if;

  -- Exactly this party's guests, each once: the payload must be a non-empty
  -- array with one entry per current guest (checked before anything else
  -- is looked at, so the work is bounded by the party's size).
  if submit_guest_rsvp.responses is null
     or jsonb_typeof(submit_guest_rsvp.responses) <> 'array'
     or jsonb_array_length(submit_guest_rsvp.responses) = 0 then
    raise exception 'guest_rsvp_invalid' using errcode = '22023';
  end if;

  select count(*) into v_party_size
  from public.guests g
  where g.guest_invitation_id = v_invitation.id and g.wedding_id = v_invitation.wedding_id;

  if jsonb_array_length(submit_guest_rsvp.responses) <> v_party_size then
    raise exception 'guest_rsvp_mismatch' using errcode = 'P0001';
  end if;

  -- Shape: objects with a uuid guest_id, a JSON boolean attending and an
  -- optional string (or null) dietary_note.
  for v_response in select value from jsonb_array_elements(submit_guest_rsvp.responses)
  loop
    if jsonb_typeof(v_response) <> 'object'
       or jsonb_typeof(v_response -> 'guest_id') is distinct from 'string'
       or (v_response ->> 'guest_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(v_response -> 'attending') is distinct from 'boolean'
       or (v_response ? 'dietary_note'
           and jsonb_typeof(v_response -> 'dietary_note') not in ('string', 'null')) then
      raise exception 'guest_rsvp_invalid' using errcode = '22023';
    end if;
  end loop;

  -- Every entry names a different guest of THIS party (a forged id from
  -- another party or wedding, or a duplicate, leaves one unmatched).
  select count(distinct g.id) into v_answered
  from jsonb_array_elements(submit_guest_rsvp.responses) e
  join public.guests g
    on g.id = (e.value ->> 'guest_id')::uuid
   and g.guest_invitation_id = v_invitation.id
   and g.wedding_id = v_invitation.wedding_id;

  if v_answered <> v_party_size then
    raise exception 'guest_rsvp_mismatch' using errcode = 'P0001';
  end if;

  -- LB-15: first answer or a new one, from the stored rows (under the lock).
  select exists (
    select 1
    from public.rsvps rv
    join public.guests g on g.id = rv.guest_id and g.wedding_id = rv.wedding_id
    where g.guest_invitation_id = v_invitation.id and g.wedding_id = v_invitation.wedding_id
  ) into v_had_answers;

  -- One row per guest: insert, or update the existing one. The wedding id
  -- comes from the party, never from the caller. The note is trimmed and
  -- blank becomes null; the CHECK rejects over-long or control characters.
  insert into public.rsvps as r (guest_id, wedding_id, attending, dietary_note)
  select
    (e.value ->> 'guest_id')::uuid,
    v_invitation.wedding_id,
    (e.value ->> 'attending')::boolean,
    nullif(
      regexp_replace(coalesce(e.value ->> 'dietary_note', ''),
                     '^[[:space:]]+|[[:space:]]+$', '', 'g'),
      ''
    )
  from jsonb_array_elements(submit_guest_rsvp.responses) e
  on conflict on constraint rsvps_pkey do update
    set attending = excluded.attending,
        dietary_note = excluded.dietary_note;

  -- LB-15: one history row per successful submission; no answers, no notes.
  insert into public.wedding_activity (wedding_id, event_type, guest_invitation_id, actor_kind, actor_user_id)
  values (
    v_invitation.wedding_id,
    case when v_had_answers then 'guest_rsvp_updated' else 'guest_rsvp_submitted' end::public.wedding_activity_event,
    v_invitation.id,
    'guest_capability',
    null
  );

  return query
    select v_invitation.label, g.id, g.name, rv.attending, rv.dietary_note
    from public.guests g
    left join public.rsvps rv on rv.guest_id = g.id and rv.wedding_id = g.wedding_id
    where g.guest_invitation_id = v_invitation.id and g.wedding_id = v_invitation.wedding_id
    order by g.created_at, g.id;
end;
$$;

comment on function public.submit_guest_rsvp(text, jsonb) is
  'Guest capability (by token hash): saves one RSVP per guest for the whole party and its activity row (submitted/updated), atomically. Same error for every unusable link.';

-- ------------------------------------------- record_guest_invitation_email

-- Replaced (ADR-004, unchanged otherwise) to take the member who sent the
-- email and append guest_invitation_email_sent in the same transaction as
-- the send metadata. Still executable ONLY by service_role, after the
-- provider accepted.
--
-- acting_user_id: the initiating member as the application derived it from
-- its authenticated WeddingAccess (auth.getUser()), never a browser value;
-- only the server holds the service-role key. This function can't prove who
-- initiated the send; it verifies only that the attributed user is a member
-- of the target wedding, or nothing is recorded (sent_but_unrecorded),
-- metadata and history alike. Attribution only, never authorization.
drop function public.record_guest_invitation_email(uuid, uuid, text, text, text);

create function public.record_guest_invitation_email(
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
  returning i.invitation_email_sent_at into v_sent_at;

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
  return v_sent_at;
end;
$$;

comment on function public.record_guest_invitation_email(uuid, uuid, text, text, text, uuid) is
  'service_role only (ADR-004, ADR-008): records a party''s latest successful invitation email (database clock) and its activity row, atomically. The only writer of the send metadata.';

revoke all on function public.record_guest_invitation_email(uuid, uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.record_guest_invitation_email(uuid, uuid, text, text, text, uuid) to service_role;

-- ------------------------------------------ record_rsvp_confirmation_email

-- Unchanged contract (ADR-005); now also appends rsvp_confirmation_email_sent
-- in the same transaction as the confirmation metadata. The actor is the
-- party's link holder: the confirmation exists because the party saved its
-- RSVP, and no member sent it.
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
  returning i.rsvp_confirmation_email_sent_at into v_sent_at;

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
  return v_sent_at;
end;
$$;

comment on function public.record_rsvp_confirmation_email(uuid, uuid, text, text, text) is
  'service_role only (ADR-005, ADR-008): records a party''s latest successful RSVP confirmation email (database clock) and its activity row, atomically. The only writer of the confirmation metadata.';

-- ---------------------------------------------- record_rsvp_reminder_email

-- Replaced (ADR-007, unchanged otherwise) to take the member who sent the
-- reminder and append rsvp_reminder_email_sent in the same transaction as
-- the reminder metadata. Same acting_user_id rule as the invitation email.
drop function public.record_rsvp_reminder_email(uuid, uuid, text, text, text);

create function public.record_rsvp_reminder_email(
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
  returning i.rsvp_reminder_email_sent_at into v_sent_at;

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
  return v_sent_at;
end;
$$;

comment on function public.record_rsvp_reminder_email(uuid, uuid, text, text, text, uuid) is
  'service_role only (ADR-007, ADR-008): records a party''s latest successful RSVP reminder email (database clock) and its activity row, atomically. The only writer of the reminder metadata.';

revoke all on function public.record_rsvp_reminder_email(uuid, uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.record_rsvp_reminder_email(uuid, uuid, text, text, text, uuid) to service_role;

-- ---------------------------------------------------- get_wedding_activity

-- The one read path the app uses: one wedding's most recent events, newest
-- first (occurred_at desc, id desc), at most 50 per call whatever is asked.
-- SECURITY INVOKER: RLS decides (members of that wedding only; anyone else
-- gets no rows). Returns only what the page shows:
--   * the party's CURRENT label (null once the party was deleted; no label
--     snapshot is stored);
--   * the actor's kind and, for a member still in the wedding, their
--     membership id (labelled by the app like everywhere else); never a
--     user id, email or token.
create function public.get_wedding_activity(target_wedding_id uuid, max_events integer default 50)
returns table (
  id uuid,
  event_type public.wedding_activity_event,
  occurred_at timestamptz,
  guest_invitation_id uuid,
  party_label text,
  actor_kind public.wedding_activity_actor,
  actor_membership_id uuid
)
language sql
stable
security invoker
set search_path = ''
as $$
  select a.id, a.event_type, a.occurred_at, a.guest_invitation_id, i.label, a.actor_kind, m.id
  from public.wedding_activity a
  left join public.guest_invitations i
    on i.id = a.guest_invitation_id and i.wedding_id = a.wedding_id
  left join public.wedding_memberships m
    on m.user_id = a.actor_user_id and m.wedding_id = a.wedding_id
  where a.wedding_id = get_wedding_activity.target_wedding_id
  order by a.occurred_at desc, a.id desc
  limit least(greatest(coalesce(get_wedding_activity.max_events, 50), 1), 50);
$$;

comment on function public.get_wedding_activity(uuid, integer) is
  'Members only (RLS): a wedding''s latest activity, newest first, at most 50 rows. No tokens, answers, notes, emails or provider data.';

revoke all on function public.get_wedding_activity(uuid, integer) from public, anon, authenticated;
grant execute on function public.get_wedding_activity(uuid, integer) to authenticated;
