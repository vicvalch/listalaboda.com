-- LB-03: WeddingMembership — the only source of authority over a wedding
-- (ADR-001 §3). MVP roles: owner | collaborator.

-- An enum (rather than a text CHECK) so the closed role set reaches
-- TypeScript through the generated database types. Used by memberships and
-- membership invites alike.
create type public.wedding_role as enum ('owner', 'collaborator');

create table public.wedding_memberships (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  -- A removed account loses its memberships. If that would leave a wedding
  -- without an owner, the final-owner trigger below blocks the removal.
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.wedding_role not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Also serves (wedding_id, …) lookups, so no separate wedding_id index.
  constraint wedding_memberships_wedding_user_key unique (wedding_id, user_id)
);

comment on table public.wedding_memberships is
  'Membership of a user in a wedding. Ownership lives only here (role = owner).';

-- "Which weddings am I in?" lookups and the user_id FK cascade.
create index wedding_memberships_user_id_idx
  on public.wedding_memberships (user_id);

alter table public.wedding_memberships enable row level security;
revoke all on table public.wedding_memberships from anon, authenticated;

create trigger wedding_memberships_set_updated_at
  before update on public.wedding_memberships
  for each row execute function private.set_updated_at();

-- Final-owner invariant: a wedding always keeps at least one owner.
--
-- Runs AFTER the change so it sees the statement's final state (deleting or
-- demoting several owners in one statement is caught too). The wedding row is
-- locked first, so two concurrent transactions each removing "the other"
-- owner serialize and the second one sees the first's result.
--
-- When the wedding itself is being deleted, its memberships are removed by the
-- FK cascade and the wedding row is already gone; that is allowed.
--
-- SECURITY DEFINER so the lock and the owner count are not filtered by the
-- caller's RLS view. It only reads; it changes nothing.
create function private.enforce_wedding_has_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role <> 'owner' then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner' and new.wedding_id = old.wedding_id then
    return null;
  end if;

  perform 1 from public.weddings w where w.id = old.wedding_id for update;
  if not found then
    return null;
  end if;

  if not exists (
    select 1
    from public.wedding_memberships m
    where m.wedding_id = old.wedding_id
      and m.role = 'owner'
  ) then
    raise exception 'wedding_must_have_owner'
      using errcode = '23514',
            detail = 'A wedding must always keep at least one owner.';
  end if;

  return null;
end;
$$;

revoke all on function private.enforce_wedding_has_owner() from public;

create trigger wedding_memberships_keep_owner
  after update or delete on public.wedding_memberships
  for each row execute function private.enforce_wedding_has_owner();
