-- LB-05: the wedding checklist — wedding-owned, mutable tenant data
-- (Constitution §4, ADR-001 §2, §5).
--
-- Every checklist item belongs to exactly one wedding; the wedding is the
-- authority boundary. Authority comes only from wedding_memberships (RLS via
-- private.is_wedding_member); created_by / completed_by are provenance only.
--
-- Checklist content is shared planning content: owners AND collaborators may
-- add, edit, change status and delete items (Constitution §3). Seeding from a
-- template is owner-only and goes through public.initialize_wedding_checklist.

-- ------------------------------------------- template application record

-- One row per wedding that was seeded from a template. It is what makes
-- seeding idempotent below the UI: the unique wedding_id means a wedding is
-- seeded at most once, even after its items are edited or deleted (re-seeding
-- an emptied list would be a surprise reset, not a feature). It also records
-- exactly which template version was copied, by whom and when.
create table public.wedding_checklist_template_applications (
  id uuid primary key default gen_random_uuid(),
  -- Also serves the wedding_id FK cascade.
  wedding_id uuid not null unique references public.weddings (id) on delete cascade,
  -- Applied template versions are history: they can't be deleted while a
  -- wedding records them.
  template_id uuid not null references public.checklist_templates (id) on delete restrict,
  applied_by uuid default auth.uid() references auth.users (id) on delete set null,
  applied_at timestamptz not null default now()
);

comment on table public.wedding_checklist_template_applications is
  'Which template version seeded a wedding''s checklist. At most one per wedding; written only by initialize_wedding_checklist.';
comment on column public.wedding_checklist_template_applications.applied_by is
  'Provenance only; never used for authorization.';

alter table public.wedding_checklist_template_applications enable row level security;
revoke all on table public.wedding_checklist_template_applications from anon, authenticated;

-- Members can see whether (and from what) their checklist was seeded. There
-- is no client write path: the RPC is the only writer.
grant select on table public.wedding_checklist_template_applications to authenticated;

create policy wedding_checklist_template_applications_select_member
  on public.wedding_checklist_template_applications for select
  to authenticated
  using (private.is_wedding_member(wedding_id));

-- ------------------------------------------------------- checklist items

create table public.checklist_items (
  id uuid primary key default gen_random_uuid(),
  -- Tenancy boundary. Deleting a wedding deletes its checklist.
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  -- Informational provenance: which template item this was copied from
  -- (null for custom items). The copy is independent; editing either side
  -- never changes the other. Template version/key are reachable through it.
  source_template_item_id uuid
    references public.checklist_template_items (id) on delete restrict,
  title text not null,
  description text,
  -- Optional for custom items; always set for template copies.
  category public.checklist_category,
  status public.checklist_item_status not null default 'pending',
  timing_mode public.checklist_timing_mode not null default 'none',
  -- The timing RULE is stored, never a derived date: the effective due date
  -- of a relative item is weddings.wedding_date + relative_days, computed on
  -- read, so it follows wedding date changes. Absolute dates never move.
  relative_days integer,
  due_date date,
  -- Deterministic display order within the wedding. Template copies keep
  -- the template's order. 0 (the default) means "place at the end": the
  -- trigger below replaces it, so stored values are always positive.
  sort_order integer not null default 0,
  -- Stamped by the database (trigger below); not writable by clients.
  completed_at timestamptz,
  completed_by uuid references auth.users (id) on delete set null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint checklist_items_title_not_blank check (title ~ '[^[:space:]]'),
  constraint checklist_items_title_length check (char_length(title) <= 200),
  constraint checklist_items_description_length
    check (description is null or char_length(description) <= 2000),
  constraint checklist_items_timing check (
    (timing_mode = 'none' and relative_days is null and due_date is null)
    or (timing_mode = 'relative_to_wedding' and relative_days is not null and due_date is null)
    or (timing_mode = 'absolute' and due_date is not null and relative_days is null)
  ),
  constraint checklist_items_sort_order_positive check (sort_order > 0),
  constraint checklist_items_relative_days_range
    check (relative_days is null or relative_days between -1000 and 1000),
  -- done <=> completed_at is set.
  constraint checklist_items_completed_at_matches_status
    check ((status = 'done') = (completed_at is not null)),
  constraint checklist_items_completed_by_requires_done
    check (completed_by is null or status = 'done')
);

comment on table public.checklist_items is
  'A wedding''s own checklist. Wedding-owned; authority from wedding_memberships only.';
comment on column public.checklist_items.relative_days is
  'Days from the wedding date: negative = before, 0 = wedding day, positive = after.';
comment on column public.checklist_items.created_by is
  'Provenance only; never used for authorization.';

-- The page loads a wedding's whole checklist in display order; this also
-- serves the wedding_id FK cascade. Status filtering and progress are
-- computed over that same per-wedding result, so no status index.
create index checklist_items_wedding_sort_idx
  on public.checklist_items (wedding_id, sort_order);

alter table public.checklist_items enable row level security;
revoke all on table public.checklist_items from anon, authenticated;

create trigger checklist_items_set_updated_at
  before update on public.checklist_items
  for each row execute function private.set_updated_at();

-- Completion timestamps come from the database clock and the session's
-- identity, never from the client. Entering 'done' stamps them; leaving it
-- clears them; any other update keeps them as they were.
create function private.stamp_checklist_item_completion()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    new.completed_at := old.completed_at;
    new.completed_by := old.completed_by;
  elsif new.status = 'done' then
    new.completed_at := now();
    new.completed_by := auth.uid();
  else
    new.completed_at := null;
    new.completed_by := null;
  end if;
  return new;
end;
$$;

revoke all on function private.stamp_checklist_item_completion() from public;

create trigger checklist_items_stamp_completion
  before insert or update on public.checklist_items
  for each row execute function private.stamp_checklist_item_completion();

-- New items without an explicit position (sort_order 0) go after the
-- wedding's last item.
-- Runs as the caller, so it only sees rows RLS lets it see (a member sees the
-- whole wedding; a non-member's insert is rejected by RLS anyway). Two
-- concurrent inserts may tie; ties are broken by created_at, id on read.
create function private.assign_checklist_item_sort_order()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.sort_order = 0 then
    select coalesce(max(c.sort_order), 0) + 10
      into new.sort_order
    from public.checklist_items c
    where c.wedding_id = new.wedding_id;
  end if;
  return new;
end;
$$;

revoke all on function private.assign_checklist_item_sort_order() from public;

create trigger checklist_items_assign_sort_order
  before insert on public.checklist_items
  for each row execute function private.assign_checklist_item_sort_order();

-- Privileges: only the columns a member legitimately supplies. Ids,
-- provenance (source_template_item_id, created_by), completion stamps and
-- ordering are never client-writable; wedding_id is fixed after insert, so
-- rows never move between weddings.
grant select on table public.checklist_items to authenticated;
grant insert (wedding_id, title, description, category, timing_mode, relative_days, due_date)
  on table public.checklist_items to authenticated;
grant update (title, description, category, status, timing_mode, relative_days, due_date)
  on table public.checklist_items to authenticated;
grant delete on table public.checklist_items to authenticated;

-- Shared planning content: any member of the wedding (owner or collaborator).
create policy checklist_items_select_member
  on public.checklist_items for select
  to authenticated
  using (private.is_wedding_member(wedding_id));

create policy checklist_items_insert_member
  on public.checklist_items for insert
  to authenticated
  with check (private.is_wedding_member(wedding_id));

create policy checklist_items_update_member
  on public.checklist_items for update
  to authenticated
  using (private.is_wedding_member(wedding_id))
  with check (private.is_wedding_member(wedding_id));

-- Hard delete: user-managed planning content, no audit/history model yet.
create policy checklist_items_delete_member
  on public.checklist_items for delete
  to authenticated
  using (private.is_wedding_member(wedding_id));
