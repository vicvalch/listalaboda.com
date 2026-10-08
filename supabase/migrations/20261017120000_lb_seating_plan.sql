-- LB-19: the seating plan foundation (ADR-012; Constitution §8 "Seating
-- (depends on Phase 2 RSVP data)"; ADR-001 §2, §7).
--
-- The seating unit is the existing public.guests row: one named person with
-- a stable id. There is no attendee/person copy, no plus-one or anonymous
-- seat and no child/adult field. Two tables:
--
--   * seating_tables       — a wedding's tables (name, capacity, order);
--   * seating_assignments  — at most ONE table per guest (guest_id is the
--                            primary key). No row = the guest has no table.
--
-- Both are wedding-scoped shared planning content: any member (owner or
-- collaborator) manages them; anon has no privileges at all. Every reference
-- is a same-wedding composite foreign key, so a guest can only sit at a table
-- of its own wedding, for every role, without relying on application checks.
--
-- Invariants enforced here, not in the app:
--   * capacity: a table never holds more assignment rows than its capacity.
--     EVERY assignment row counts (attending, pending, or a guest who declined
--     after being seated). Concurrent seats/moves into the same table are
--     serialized by locking the destination table row;
--   * a table's capacity can't drop below its current assignment count
--     (nobody is ever unseated silently);
--   * a guest whose current RSVP is "No" can't be newly seated or moved.
--     A guest who declines AFTER being seated keeps the assignment: the RSVP
--     never depends on seating (submit_guest_rsvp is unchanged), and the
--     organizers resolve the conflict by hand.
--
-- No activity events (ADR-008 stays guest-invitation/RSVP facts only), no
-- checklist relation, and nothing here is reachable from public, RSVP or
-- published-site functions.

-- ------------------------------------------------------------ seating_tables

create table public.seating_tables (
  id uuid primary key default gen_random_uuid(),
  -- Tenancy boundary. Deleting a wedding deletes its tables (and, through
  -- them, every assignment).
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  -- "Mesa 1", "Mesa de los novios". Not unique: two tables may share a name.
  name text not null,
  -- The maximum number of assignment rows (people) at this table.
  capacity integer not null,
  -- Display order within the wedding. 0 (the default) means "place at the
  -- end": the trigger below replaces it, so stored values are always
  -- positive. Not client-writable; there is no reordering in LB-19.
  sort_order integer not null default 0,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Stored already normalized: trimmed, nonblank, ≤ 80 chars, plain text.
  constraint seating_tables_name_valid check (
    char_length(name) between 1 and 80
    and name !~ '^[[:space:]]|[[:space:]]$'
    and name !~ '[[:cntrl:]]'
  ),
  constraint seating_tables_capacity_range check (capacity between 1 and 50),
  constraint seating_tables_sort_order_positive check (sort_order > 0),
  -- Target of the assignments' same-wedding foreign key.
  constraint seating_tables_id_wedding_key unique (id, wedding_id)
);

comment on table public.seating_tables is
  'A wedding''s seating tables. Wedding-owned planning content; authority from wedding_memberships only.';
comment on column public.seating_tables.capacity is
  'Maximum number of seating_assignments rows (people) at this table, 1–50. Every assignment counts.';
comment on column public.seating_tables.created_by is
  'Provenance only; never used for authorization.';

-- The page loads a wedding's tables in display order; also serves the
-- wedding_id FK cascade.
create index seating_tables_wedding_sort_idx
  on public.seating_tables (wedding_id, sort_order);

alter table public.seating_tables enable row level security;
revoke all on table public.seating_tables from anon, authenticated;

create trigger seating_tables_set_updated_at
  before update on public.seating_tables
  for each row execute function private.set_updated_at();

-- New tables (sort_order 0) go after the wedding's last table. Runs as the
-- caller, so it only sees rows RLS lets it see (a member sees the whole
-- wedding; a non-member's insert is rejected by RLS anyway). Two concurrent
-- inserts may tie; ties are broken by created_at, id on read.
create function private.assign_seating_table_sort_order()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.sort_order = 0 then
    select coalesce(max(t.sort_order), 0) + 10
      into new.sort_order
    from public.seating_tables t
    where t.wedding_id = new.wedding_id;
  end if;
  return new;
end;
$$;

revoke all on function private.assign_seating_table_sort_order() from public;

create trigger seating_tables_assign_sort_order
  before insert on public.seating_tables
  for each row execute function private.assign_seating_table_sort_order();

-- ------------------------------------------------------- seating_assignments

create table public.seating_assignments (
  -- One table per guest: the guest IS the key. Moving updates this row;
  -- a second assignment for the same guest is impossible.
  guest_id uuid primary key,
  wedding_id uuid not null,
  seating_table_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Same-wedding invariants: the guest and the table are identified by
  -- (id, THIS row's wedding id). Deleting the guest (or its party) or the
  -- table removes the assignment; the other side is untouched.
  constraint seating_assignments_guest_same_wedding
    foreign key (guest_id, wedding_id)
    references public.guests (id, wedding_id)
    on delete cascade,
  constraint seating_assignments_table_same_wedding
    foreign key (seating_table_id, wedding_id)
    references public.seating_tables (id, wedding_id)
    on delete cascade
);

comment on table public.seating_assignments is
  'Which table a guest sits at: at most one per guest. No row = no table. Never written by RSVP flows.';

-- The capacity count (per destination table) and the table FK cascade. The
-- guest FK cascade and per-guest lookups use the primary key.
create index seating_assignments_table_idx
  on public.seating_assignments (seating_table_id);

alter table public.seating_assignments enable row level security;
revoke all on table public.seating_assignments from anon, authenticated;

create trigger seating_assignments_set_updated_at
  before update on public.seating_assignments
  for each row execute function private.set_updated_at();

-- Seating a guest or moving them to another table:
--   1. a guest whose current RSVP is "No" can't be newly seated or moved
--      (no RSVP row = pending = allowed);
--   2. the destination table is locked (FOR UPDATE), then its assignment
--      rows are counted; a full table refuses. The lock serializes every
--      seat/move into that table and every capacity change of it, so two
--      transactions can never both take its last seat: the second waits,
--      then counts again with the first one's row committed.
-- An UPDATE that keeps the same table and guest does no work, so an already
-- seated guest who later declines can still be left where they are.
--
-- SECURITY INVOKER on purpose: it runs as the caller, under RLS. A member
-- sees every table and assignment of their own wedding, which is exactly
-- the destination's wedding (same-wedding FKs), so the count is complete;
-- locking needs the member's UPDATE privilege and policy on seating_tables,
-- which every member has. A non-member sees no table (nothing to lock) and
-- is refused by RLS right after. Privileged roles bypass RLS and see all.
create function private.enforce_seating_assignment()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_capacity integer;
  v_assigned integer;
begin
  if tg_op = 'UPDATE'
     and new.seating_table_id is not distinct from old.seating_table_id
     and new.guest_id is not distinct from old.guest_id then
    return new;
  end if;

  if exists (
    select 1
    from public.rsvps r
    where r.guest_id = new.guest_id
      and r.wedding_id = new.wedding_id
      and r.attending = false
  ) then
    raise exception 'seating_guest_declined'
      using errcode = '23514',
            detail = 'A guest who declined cannot be seated or moved.';
  end if;

  select t.capacity
    into v_capacity
  from public.seating_tables t
  where t.id = new.seating_table_id
    and t.wedding_id = new.wedding_id
  for update;

  if not found then
    -- Not a table of this wedding (or not visible): the same-wedding
    -- foreign key (or RLS) refuses it.
    return new;
  end if;

  select count(*)
    into v_assigned
  from public.seating_assignments a
  where a.seating_table_id = new.seating_table_id
    and a.guest_id <> new.guest_id;

  if v_assigned >= v_capacity then
    raise exception 'seating_table_full'
      using errcode = '23514',
            detail = 'The table has no free seats.';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_seating_assignment() from public;

create trigger seating_assignments_enforce
  before insert or update of seating_table_id, guest_id, wedding_id on public.seating_assignments
  for each row execute function private.enforce_seating_assignment();

-- Lowering a table's capacity below the people already seated there is
-- refused: nobody is unseated silently. The UPDATE already holds the table
-- row lock, so this count is serialized with seats and moves into it.
-- SECURITY INVOKER, for the same reasons as above.
create function private.enforce_seating_table_capacity()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_assigned integer;
begin
  if new.capacity is not distinct from old.capacity then
    return new;
  end if;

  select count(*)
    into v_assigned
  from public.seating_assignments a
  where a.seating_table_id = new.id;

  if v_assigned > new.capacity then
    raise exception 'seating_capacity_below_assigned'
      using errcode = '23514',
            detail = 'Unseat people first: the table has more people than the new capacity.';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_seating_table_capacity() from public;

create trigger seating_tables_enforce_capacity
  before update of capacity on public.seating_tables
  for each row execute function private.enforce_seating_table_capacity();

-- -------------------------------------------- organizer privileges + RLS
--
-- Any member of the wedding (owner or collaborator). Ids, ordering,
-- provenance and timestamps are not client-writable; rows never move between
-- weddings, and an assignment never changes guest.

grant select on table public.seating_tables to authenticated;
grant insert (wedding_id, name, capacity) on table public.seating_tables to authenticated;
grant update (name, capacity) on table public.seating_tables to authenticated;
grant delete on table public.seating_tables to authenticated;

create policy seating_tables_select_member
  on public.seating_tables for select
  to authenticated
  using (private.is_wedding_member(wedding_id));

create policy seating_tables_insert_member
  on public.seating_tables for insert
  to authenticated
  with check (private.is_wedding_member(wedding_id));

create policy seating_tables_update_member
  on public.seating_tables for update
  to authenticated
  using (private.is_wedding_member(wedding_id))
  with check (private.is_wedding_member(wedding_id));

create policy seating_tables_delete_member
  on public.seating_tables for delete
  to authenticated
  using (private.is_wedding_member(wedding_id));

grant select on table public.seating_assignments to authenticated;
grant insert (guest_id, wedding_id, seating_table_id) on table public.seating_assignments to authenticated;
grant update (seating_table_id) on table public.seating_assignments to authenticated;
grant delete on table public.seating_assignments to authenticated;

create policy seating_assignments_select_member
  on public.seating_assignments for select
  to authenticated
  using (private.is_wedding_member(wedding_id));

create policy seating_assignments_insert_member
  on public.seating_assignments for insert
  to authenticated
  with check (private.is_wedding_member(wedding_id));

create policy seating_assignments_update_member
  on public.seating_assignments for update
  to authenticated
  using (private.is_wedding_member(wedding_id))
  with check (private.is_wedding_member(wedding_id));

create policy seating_assignments_delete_member
  on public.seating_assignments for delete
  to authenticated
  using (private.is_wedding_member(wedding_id));
