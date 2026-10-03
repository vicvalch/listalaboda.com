-- LB-09: the guest list — GuestInvitation (household / party) → Guest → RSVP
-- (Constitution §3 "Guest", §6, §8 Phase 2; ADR-001 §2, §7; ADR-002 §5, §7).
--
-- A GuestInvitation is NOT a MembershipInvite: it never creates an account or
-- a wedding membership. It is one party's RSVP capability, unlocked by a
-- token whose SHA-256 hash is the only form stored.
--
-- Every row carries wedding_id, and children reference their parent by
-- (id, wedding_id), so a guest can only belong to a party of its own wedding
-- and an RSVP only to a guest of its own wedding — enforced relationally,
-- even for privileged writes.
--
-- Organizers are the wedding's members, owners and collaborators alike: the
-- guest list is shared wedding planning content (Constitution §10 PRIVATE
-- "guest list": wedding members only). The one exception is the link itself:
-- replacing or revoking a party's bearer link changes an external security
-- boundary, so only owners may do it (enforced below, not just in the UI).
-- Guests (no account) never touch these tables: they read and answer only
-- through the token functions in the next migration. anon has no table
-- privileges at all.
--
-- Party size is the number of guest rows: one or more named guests, with no
-- fixed maximum. There is no stored party size, plus-one count or response
-- counter: they would compete with the rows. An explicit invited capacity
-- (max_guests, plus-ones) is a future product decision, not modeled here.

-- ------------------------------------------------------ guest_invitations

create table public.guest_invitations (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  -- How the couple names the party: "Familia Pérez", "Ana y Carlos".
  label text not null,
  -- SHA-256 of the current link token, lowercase hex. Never readable through
  -- the API (no column grant). Replaced on "Generar nuevo enlace".
  token_hash text not null,
  -- When the current token was issued (database clock, set by the trigger
  -- below). Input to the derived expiry; not client-writable.
  token_issued_at timestamptz not null default now(),
  -- Set when access was revoked (database clock). A revoked token stays
  -- dead; only a NEW token (rotation) clears it.
  revoked_at timestamptz,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint guest_invitations_token_hash_key unique (token_hash),
  constraint guest_invitations_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  -- Stored already normalized: trimmed, nonblank, ≤ 120 chars, plain text.
  constraint guest_invitations_label_valid check (
    char_length(label) between 1 and 120
    and label !~ '^[[:space:]]|[[:space:]]$'
    and label !~ '[[:cntrl:]]'
  ),
  -- Target of the guests' same-wedding foreign key.
  constraint guest_invitations_id_wedding_key unique (id, wedding_id)
);

comment on table public.guest_invitations is
  'One guest household/party of a wedding and its RSVP link. Not a MembershipInvite; stores only the token hash.';
comment on column public.guest_invitations.token_hash is
  'SHA-256 of the current guest link token, lowercase hex. The plaintext token is never stored.';
comment on column public.guest_invitations.token_issued_at is
  'When the current token was issued. Expiry is derived (private.guest_invitation_expires_at), never stored.';
comment on column public.guest_invitations.created_by is
  'Provenance only; never used for authorization.';

-- Organizers list a wedding's parties; also serves the wedding_id FK cascade.
-- (token_hash lookups use the unique constraint's index.)
create index guest_invitations_wedding_id_idx on public.guest_invitations (wedding_id);

alter table public.guest_invitations enable row level security;
revoke all on table public.guest_invitations from anon, authenticated;

create trigger guest_invitations_set_updated_at
  before update on public.guest_invitations
  for each row execute function private.set_updated_at();

-- Link lifecycle, on the database clock:
--   * only owners replace or revoke a link: for client roles, changing
--     token_hash or revoked_at requires the owner role in the party's
--     wedding (members keep editing the label through the same UPDATE
--     policy; privileges and policies can't split one row by column);
--   * a new token_hash (rotation) re-stamps token_issued_at and clears
--     revoked_at: the new link works, the old one is gone;
--   * revoking stamps revoked_at with now();
--   * a revoked token can't be un-revoked or re-stamped: it stays dead.
-- The initial link is written by INSERT (party creation), which any member
-- may do; this trigger only guards later changes.
create function private.guard_guest_invitation_link()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.token_hash is distinct from old.token_hash
      or new.revoked_at is distinct from old.revoked_at)
     and current_user in ('anon', 'authenticated')
     and not private.has_wedding_role(old.wedding_id, array['owner']::public.wedding_role[]) then
    raise exception 'guest_link_owner_only'
      using errcode = '42501',
            detail = 'Only wedding owners can replace or revoke a guest link.';
  end if;

  if new.token_hash is distinct from old.token_hash then
    new.token_issued_at := now();
    new.revoked_at := null;
    return new;
  end if;

  new.token_issued_at := old.token_issued_at;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'guest_invitation_revoked'
      using errcode = '23514',
            detail = 'A revoked guest link cannot be reopened; generate a new link instead.';
  end if;
  if old.revoked_at is null and new.revoked_at is not null then
    new.revoked_at := now();
  end if;
  return new;
end;
$$;

revoke all on function private.guard_guest_invitation_link() from public;

create trigger guest_invitations_guard_link
  before update on public.guest_invitations
  for each row execute function private.guard_guest_invitation_link();

-- Guest link expiry (ADR-002 §5: "valid until a defined point after the
-- wedding"). Derived on every check from the CURRENT wedding date, never
-- stored, so moving the wedding moves the deadline:
--   * dated wedding   → 00:00 UTC on (wedding date + 31 days), i.e. at least
--                       30 full days after the wedding day in any time zone;
--   * no wedding date → 365 days after the token was issued.
-- Mirrored by guestLinkExpiresAt in src/lib/guests/link.ts.
create function private.guest_invitation_expires_at(
  token_issued_at timestamptz,
  wedding_date date
)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select case
    when guest_invitation_expires_at.wedding_date is not null
      then pg_catalog.timezone('UTC', (guest_invitation_expires_at.wedding_date + 31)::timestamp)
    else guest_invitation_expires_at.token_issued_at + interval '365 days'
  end;
$$;

revoke all on function private.guest_invitation_expires_at(timestamptz, date) from public;

-- ----------------------------------------------------------------- guests

create table public.guests (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null,
  guest_invitation_id uuid not null,
  -- One invited person. No email, phone, account or membership.
  name text not null,
  -- clock_timestamp(), not now(): guests added in one statement (a new
  -- party) get increasing values, so the party keeps the order typed.
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default now(),
  constraint guests_name_valid check (
    char_length(name) between 1 and 120
    and name !~ '^[[:space:]]|[[:space:]]$'
    and name !~ '[[:cntrl:]]'
  ),
  -- Same-wedding invariant: the party is identified by (party id, THIS
  -- guest's wedding id). Deleting the party deletes its guests.
  constraint guests_invitation_same_wedding
    foreign key (guest_invitation_id, wedding_id)
    references public.guest_invitations (id, wedding_id)
    on delete cascade,
  -- Target of the RSVPs' same-wedding foreign key.
  constraint guests_id_wedding_key unique (id, wedding_id)
);

comment on table public.guests is
  'One invited person in a guest party. Not an account and not a wedding member.';

-- Organizers load a wedding's guests; serves the party FK cascade
-- (guest_invitation_id, wedding_id) and the token functions' party lookup.
create index guests_wedding_invitation_idx
  on public.guests (wedding_id, guest_invitation_id);

alter table public.guests enable row level security;
revoke all on table public.guests from anon, authenticated;

create trigger guests_set_updated_at
  before update on public.guests
  for each row execute function private.set_updated_at();

-- Party size: at least one guest, no fixed maximum.
--
-- At least one guest: checked at COMMIT (deferred), so a party and its first guests
-- are created in one transaction (public.create_guest_invitation), and the
-- last guest can't be removed on its own — delete the party instead. When
-- the party itself is deleted its guests cascade and the party is gone,
-- which is allowed. The party row is locked so two transactions removing
-- "the other" last guests serialize.
create function private.enforce_guest_invitation_has_guest()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invitation_id uuid;
begin
  if tg_table_name = 'guest_invitations' then
    v_invitation_id := new.id;
  else
    v_invitation_id := old.guest_invitation_id;
  end if;

  perform 1 from public.guest_invitations i where i.id = v_invitation_id for update;
  if not found then
    return null;
  end if;

  if not exists (
    select 1 from public.guests g where g.guest_invitation_id = v_invitation_id
  ) then
    raise exception 'guest_invitation_needs_guest'
      using errcode = '23514',
            detail = 'A guest party must keep at least one guest.';
  end if;
  return null;
end;
$$;

revoke all on function private.enforce_guest_invitation_has_guest() from public;

create constraint trigger guest_invitations_require_guest
  after insert on public.guest_invitations
  deferrable initially deferred
  for each row execute function private.enforce_guest_invitation_has_guest();

create constraint trigger guests_keep_one_per_invitation
  after delete or update of guest_invitation_id on public.guests
  deferrable initially deferred
  for each row execute function private.enforce_guest_invitation_has_guest();

-- ------------------------------------------------------------------ rsvps

create table public.rsvps (
  -- One current response per guest: the guest IS the key. Answering again
  -- updates this row; a second row for the same guest is impossible.
  guest_id uuid primary key,
  wedding_id uuid not null,
  attending boolean not null,
  -- Optional food notes for this guest ("vegetariana"). Plain text, trimmed,
  -- blank = null, ≤ 500 chars. No menu, allergy taxonomy or catering model.
  dietary_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rsvps_dietary_note_valid check (
    dietary_note is null
    or (
      char_length(dietary_note) between 1 and 500
      and dietary_note !~ '^[[:space:]]|[[:space:]]$'
      and dietary_note !~ '[[:cntrl:]]'
    )
  ),
  -- Same-wedding invariant; removing a guest removes their response.
  constraint rsvps_guest_same_wedding
    foreign key (guest_id, wedding_id)
    references public.guests (id, wedding_id)
    on delete cascade
);

comment on table public.rsvps is
  'A guest''s current RSVP. No row = "Sin responder". Written only through public.submit_guest_rsvp.';

-- No extra index: the primary key serves the guest FK cascade and the
-- organizers' per-guest lookups.

alter table public.rsvps enable row level security;
revoke all on table public.rsvps from anon, authenticated;

create trigger rsvps_set_updated_at
  before update on public.rsvps
  for each row execute function private.set_updated_at();

-- -------------------------------------------- organizer privileges + RLS
--
-- Any member of the wedding (owner or collaborator). Ids, wedding_id,
-- provenance and link timestamps are not client-writable; rows never move
-- between weddings or parties.

-- token_hash is insertable (create) and updatable (rotation) but never
-- readable, so a read of the guest list can't be replayed as a guest link.
grant select (id, wedding_id, label, token_issued_at, revoked_at, created_by, created_at, updated_at)
  on table public.guest_invitations to authenticated;
grant insert (wedding_id, label, token_hash) on table public.guest_invitations to authenticated;
-- token_hash (rotation) and revoked_at (revocation) are owner-only: the
-- link guard trigger above refuses them for collaborators.
grant update (label, token_hash, revoked_at) on table public.guest_invitations to authenticated;
grant delete on table public.guest_invitations to authenticated;

create policy guest_invitations_select_member
  on public.guest_invitations for select
  to authenticated
  using (private.is_wedding_member(wedding_id));

create policy guest_invitations_insert_member
  on public.guest_invitations for insert
  to authenticated
  with check (private.is_wedding_member(wedding_id) and created_by = auth.uid());

create policy guest_invitations_update_member
  on public.guest_invitations for update
  to authenticated
  using (private.is_wedding_member(wedding_id))
  with check (private.is_wedding_member(wedding_id));

create policy guest_invitations_delete_member
  on public.guest_invitations for delete
  to authenticated
  using (private.is_wedding_member(wedding_id));

grant select on table public.guests to authenticated;
grant insert (wedding_id, guest_invitation_id, name) on table public.guests to authenticated;
grant update (name) on table public.guests to authenticated;
grant delete on table public.guests to authenticated;

create policy guests_select_member
  on public.guests for select
  to authenticated
  using (private.is_wedding_member(wedding_id));

create policy guests_insert_member
  on public.guests for insert
  to authenticated
  with check (private.is_wedding_member(wedding_id));

create policy guests_update_member
  on public.guests for update
  to authenticated
  using (private.is_wedding_member(wedding_id))
  with check (private.is_wedding_member(wedding_id));

create policy guests_delete_member
  on public.guests for delete
  to authenticated
  using (private.is_wedding_member(wedding_id));

-- Organizers read responses; they don't write them. Responses come from the
-- party through public.submit_guest_rsvp; removing a guest or party removes
-- the response by cascade.
grant select on table public.rsvps to authenticated;

create policy rsvps_select_member
  on public.rsvps for select
  to authenticated
  using (private.is_wedding_member(wedding_id));
