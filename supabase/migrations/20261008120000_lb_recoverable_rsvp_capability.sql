-- LB-13: recoverable RSVP capability (ADR-006).
--
-- A party's guest link should stay the SAME link until an owner explicitly
-- replaces it, and organizers should be able to share it again later
-- (copy, and future reminders) without the plaintext token ever being
-- stored. So each new or rotated link now has two stored forms with
-- different jobs:
--
--   * guest_invitations.token_hash (unchanged): SHA-256 of the token. The
--     ONLY thing that validates an incoming guest link (get_guest_invitation,
--     submit_guest_rsvp). Nothing here changes that path.
--   * private.guest_invitation_capability_secrets.token_ciphertext: an
--     AES-256-GCM envelope of the token, made by the server with a key that
--     lives only in the server environment (never in PostgreSQL), and bound
--     to the token hash. Used only for explicit organizer recovery. The
--     database never sees the plaintext or the key and can't decrypt; it
--     only checks the envelope's shape.
--
-- A database dump alone still doesn't reveal usable links: the envelopes
-- need the key. Dump AND key together do (ADR-006, threat model).
--
-- Invariants enforced here:
--   * a new party and its envelope are created in one transaction, and a
--     rotation replaces the hash and the envelope in one transaction:
--     after LB-13 no hash can become current without a matching envelope
--     (deferred constraint trigger below, for every role);
--   * existing (pre-LB-13) parties keep working with their hash only. They
--     get no fabricated envelope and are never rotated automatically; they
--     become recoverable when an owner explicitly generates a new link;
--   * no client role can read or write the envelopes directly, and there is
--     no standalone writer: only create_guest_invitation and
--     rotate_guest_invitation_link write them, inline. Members get one
--     party's envelope (and its hash, to verify the binding) through one
--     narrow function, only while that link is current and usable.

-- ------------------------------------------- capability secret storage

-- In `private`: not exposed through the Data API at all, on top of RLS
-- and the missing grants.
create table private.guest_invitation_capability_secrets (
  guest_invitation_id uuid primary key,
  wedding_id uuid not null,
  -- The token hash this envelope belongs to (the AES-GCM associated data).
  -- Recovery uses the envelope only while this equals the party's CURRENT
  -- token_hash.
  token_hash text not null,
  -- `v1.<iv>.<ciphertext>.<tag>`, base64url: 12-byte IV, 43-byte
  -- ciphertext (a 43-character token), 16-byte GCM tag. Never plaintext.
  token_ciphertext text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Same-wedding invariant; deleting the party (or the wedding) deletes
  -- its envelope.
  constraint guest_invitation_capability_secrets_invitation_same_wedding
    foreign key (guest_invitation_id, wedding_id)
    references public.guest_invitations (id, wedding_id)
    on delete cascade,
  constraint guest_invitation_capability_secrets_token_hash_format
    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint guest_invitation_capability_secrets_ciphertext_v1 check (
    char_length(token_ciphertext) <= 200
    and token_ciphertext ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{58}\.[A-Za-z0-9_-]{22}$'
  )
);

comment on table private.guest_invitation_capability_secrets is
  'LB-13 (ADR-006): AES-256-GCM envelope of a party''s current link token, for explicit organizer recovery only. Never plaintext; the key is not in the database. token_hash on guest_invitations stays the only validator.';

alter table private.guest_invitation_capability_secrets enable row level security;
-- No policies and no grants: no client role reaches it (and `private` isn't
-- on the Data API). Only the SECURITY DEFINER functions below do.
revoke all on table private.guest_invitation_capability_secrets from public, anon, authenticated;

-- The wedding cascade goes through guest_invitations; this serves the
-- composite foreign key's checks.
create index guest_invitation_capability_secrets_invitation_wedding_idx
  on private.guest_invitation_capability_secrets (guest_invitation_id, wedding_id);

create trigger guest_invitation_capability_secrets_set_updated_at
  before update on private.guest_invitation_capability_secrets
  for each row execute function private.set_updated_at();

-- -------------------------------------------- hash + envelope atomicity

-- At COMMIT, a party whose token_hash was set in this transaction (created
-- or rotated) must have an envelope bound to that exact hash. So "hash
-- rotated, envelope missing or stale" can't commit, through any path or
-- role: the whole transaction rolls back and the old link (and envelope)
-- stay current. Parties that existed before LB-13 are untouched until
-- their hash changes. Deferred, because the party row comes first.
create function private.enforce_guest_invitation_capability_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token_hash text;
begin
  -- Re-read the row as of now: it may have been rotated again or deleted
  -- later in the same transaction.
  select i.token_hash into v_token_hash
  from public.guest_invitations i
  where i.id = new.id;
  if not found then
    return null;
  end if;

  if not exists (
    select 1 from private.guest_invitation_capability_secrets s
    where s.guest_invitation_id = new.id
      and s.token_hash = v_token_hash
  ) then
    raise exception 'guest_invitation_capability_secret_required'
      using errcode = '23514',
            detail = 'A new or rotated guest link must store its encrypted capability in the same transaction.';
  end if;
  return null;
end;
$$;

revoke all on function private.enforce_guest_invitation_capability_secret() from public;

create constraint trigger guest_invitations_require_capability_secret
  after insert or update of token_hash on public.guest_invitations
  deferrable initially deferred
  for each row execute function private.enforce_guest_invitation_capability_secret();

-- There is deliberately NO standalone envelope writer: the only code that
-- writes private.guest_invitation_capability_secrets is inside the two
-- business functions below, in the same statement sequence (and so the same
-- transaction) as the hash it belongs to. No client role holds EXECUTE on
-- any other function that could write an envelope.

-- ------------------------------------------------ create_guest_invitation

-- Replaced to take the envelope of the party's first link. The party, its
-- guests, its contact email and its envelope commit together or not at all.
-- There is no hash-only variant any more.
--
-- Now SECURITY DEFINER (it was SECURITY INVOKER): the envelope table has no
-- client grants, and an invoker function would need a separately granted
-- writer. Running as the owner bypasses RLS, so the function enforces
-- exactly what the insert policy did, itself, from auth.uid(): signed in,
-- a member (owner or collaborator) of the target wedding, created_by = the
-- caller. Rows still carry the target wedding id (composite FKs keep guests
-- and the envelope in the party's wedding), CHECKs and triggers still apply.
-- Clients lose their own INSERT grant on guest_invitations (below): this is
-- the only way to create a party.
drop function public.create_guest_invitation(uuid, text, text, text[], text);

create function public.create_guest_invitation(
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

  return v_invitation_id;
end;
$$;

comment on function public.create_guest_invitation(uuid, text, text, text, text[], text) is
  'Members only (checked from auth.uid()): creates a guest party with its first guests, optional contact email and recoverable link envelope, atomically. The only way to create a party.';

revoke all on function public.create_guest_invitation(uuid, text, text, text, text[], text) from public, anon, authenticated;
grant execute on function public.create_guest_invitation(uuid, text, text, text, text[], text) to authenticated;

-- Clients can no longer insert parties directly (it would fail at commit
-- anyway: no envelope). The insert policy stays as an inert backstop.
revoke insert (wedding_id, label, token_hash, contact_email) on table public.guest_invitations from authenticated;

-- ----------------------------------------- rotate_guest_invitation_link

-- "Generar nuevo enlace" (owner-only): the new hash and its envelope in one
-- transaction, through the ONLY door left for rotation (the token_hash
-- column grant is revoked below). SECURITY DEFINER because clients can no
-- longer write token_hash or envelopes; it therefore checks everything
-- itself, from auth.uid(): a non-member (or a party of another wedding)
-- gets false, like a missing party; a collaborator gets
-- guest_link_owner_only, as before. The link guard trigger still re-stamps
-- token_issued_at and clears revoked_at. If anything fails (e.g. a
-- malformed envelope), nothing changes: the old link and its envelope stay
-- current.
create function public.rotate_guest_invitation_link(
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
  return true;
end;
$$;

comment on function public.rotate_guest_invitation_link(uuid, uuid, text, text) is
  'Owners only: replaces a party''s link hash and its recoverable envelope atomically. The only way to rotate a guest link.';

revoke all on function public.rotate_guest_invitation_link(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.rotate_guest_invitation_link(uuid, uuid, text, text) to authenticated;

-- Clients can no longer rotate through a plain UPDATE (the deferred trigger
-- would refuse it at commit anyway: no envelope). Revocation (revoked_at,
-- owner-only through the link guard trigger) and label edits keep their
-- column grants.
revoke update (token_hash) on table public.guest_invitations from authenticated;

-- -------------------------------- get_guest_invitation_recovery_envelope

-- Explicit organizer recovery of ONE party's current link. Members only
-- (owner or collaborator); anyone else (outsider, anon, another wedding's
-- member, an unknown or mismatched id) gets no row, like a missing party.
--
-- One row:
--   * link_state 'recoverable' + token_hash + token_ciphertext: the link
--     is current and usable (not revoked, not expired) and has an envelope
--     bound to its current hash. The server decrypts it with its key and
--     re-checks the hash; the database can't and doesn't.
--   * 'unavailable' (revoked or expired): nothing else. A dead link is
--     never handed out for sharing.
--   * 'legacy' (no envelope for the current hash, e.g. a pre-LB-13 party):
--     nothing else. Its hash is NOT returned: members never get a usable
--     capability they couldn't recover anyway.
--
-- Never returns the plaintext (it isn't stored), the contact email,
-- guests, RSVPs, other parties or other wedding data. The hash is returned
-- only next to an envelope the caller may recover, so it reveals nothing
-- the recovered link wouldn't. SECURITY DEFINER only because no client
-- role can read token_hash or the envelopes.
create function public.get_guest_invitation_recovery_envelope(
  target_wedding_id uuid,
  target_invitation_id uuid
)
returns table (link_state text, token_hash text, token_ciphertext text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    case
      when i.revoked_at is not null
        or now() >= private.guest_invitation_expires_at(i.token_issued_at, w.wedding_date)
        then 'unavailable'
      when s.guest_invitation_id is null then 'legacy'
      else 'recoverable'
    end,
    case
      when i.revoked_at is null
        and now() < private.guest_invitation_expires_at(i.token_issued_at, w.wedding_date)
        and s.guest_invitation_id is not null
        then i.token_hash
    end,
    case
      when i.revoked_at is null
        and now() < private.guest_invitation_expires_at(i.token_issued_at, w.wedding_date)
        and s.guest_invitation_id is not null
        then s.token_ciphertext
    end
  from public.guest_invitations i
  join public.weddings w on w.id = i.wedding_id
  left join private.guest_invitation_capability_secrets s
    on s.guest_invitation_id = i.id
   and s.wedding_id = i.wedding_id
   and s.token_hash = i.token_hash
  where i.id = get_guest_invitation_recovery_envelope.target_invitation_id
    and i.wedding_id = get_guest_invitation_recovery_envelope.target_wedding_id
    and auth.uid() is not null
    and private.is_wedding_member(i.wedding_id);
$$;

comment on function public.get_guest_invitation_recovery_envelope(uuid, uuid) is
  'Members only (LB-13, ADR-006): one party''s link recovery state and, only while its current link is usable and recoverable, its hash and encrypted envelope. Never plaintext.';

revoke all on function public.get_guest_invitation_recovery_envelope(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_guest_invitation_recovery_envelope(uuid, uuid) to authenticated;
