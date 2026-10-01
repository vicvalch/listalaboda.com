-- LB-03: MembershipInvite — invitation to become an authenticated member of
-- one wedding (ADR-001 §3, ADR-002 §5). Not a GuestInvitation.
--
-- The plaintext token is never stored: only its SHA-256 hash (lowercase hex).
-- Invites are single-use, expiring and revocable. Revocation is preferred
-- over deletion so the history of who was invited stays visible to owners.

create table public.membership_invites (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  -- Optional. When set, only an account with this (confirmed) email can
  -- accept. When null, the link is a bearer invite for any signed-in user.
  email text,
  -- ADR-001 §3: an invite is bound to one intended role, owner or
  -- collaborator (the partner is typically invited as owner).
  intended_role public.wedding_role not null default 'collaborator',
  token_hash text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint membership_invites_token_hash_key unique (token_hash),
  constraint membership_invites_token_hash_format
    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint membership_invites_email_normalized
    check (
      email is null
      or (
        email = lower(btrim(email))
        and char_length(email) <= 320
        and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'
      )
    ),
  -- Never permanent, never longer than 30 days.
  constraint membership_invites_expiry_window
    check (expires_at > created_at and expires_at <= created_at + interval '30 days'),
  constraint membership_invites_single_outcome
    check (revoked_at is null or accepted_at is null),
  constraint membership_invites_accepted_by_requires_accepted_at
    check (accepted_by is null or accepted_at is not null)
);

comment on table public.membership_invites is
  'Single-use, expiring, revocable invite to become a wedding member. Stores only the token hash.';
comment on column public.membership_invites.token_hash is
  'SHA-256 of the invite token, lowercase hex. The plaintext token is never stored.';

-- Owners listing a wedding's invites, and the wedding_id FK cascade.
-- (token_hash lookups use the unique constraint's index.)
create index membership_invites_wedding_id_idx
  on public.membership_invites (wedding_id);

alter table public.membership_invites enable row level security;
revoke all on table public.membership_invites from anon, authenticated;

create trigger membership_invites_set_updated_at
  before update on public.membership_invites
  for each row execute function private.set_updated_at();

-- Accepted and revoked are terminal states: no un-revoking, no re-accepting,
-- no revoking an accepted invite. Revocation time is the server's clock.
create function private.guard_membership_invite_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (old.accepted_at is not null or old.revoked_at is not null)
     and (new.accepted_at is distinct from old.accepted_at
          or new.revoked_at is distinct from old.revoked_at) then
    raise exception 'membership_invite_closed'
      using errcode = '23514',
            detail = 'Accepted or revoked invites cannot change state.';
  end if;

  if new.revoked_at is distinct from old.revoked_at then
    new.revoked_at := now();
  end if;

  return new;
end;
$$;

revoke all on function private.guard_membership_invite_state() from public;

create trigger membership_invites_guard_state
  before update on public.membership_invites
  for each row execute function private.guard_membership_invite_state();
