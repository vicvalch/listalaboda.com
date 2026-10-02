-- LB-07: checklist assignment and wedding-scoped member display names
-- (Constitution §3, §4 "assignee — a member of this wedding, optional", §7.8, §7.9).
--
-- Two small additions:
--   * wedding_memberships.display_name — how a member appears inside ONE
--     wedding. Presentation only; never authorization. Each member sets
--     their own through public.set_wedding_display_name.
--   * checklist_items.assignee_membership_id — zero or one member of the
--     SAME wedding responsible for the item. Planning metadata only: it
--     grants nothing and restricts nothing; any member still manages any item.

-- ------------------------------------------------ member display names

alter table public.wedding_memberships
  add column display_name text;

-- Stored already normalized: trimmed, never blank (blank means "no name",
-- i.e. null), at most 80 characters, no control characters (plain text).
alter table public.wedding_memberships
  add constraint wedding_memberships_display_name_valid check (
    display_name is null
    or (
      char_length(display_name) between 1 and 80
      and display_name !~ '^[[:space:]]|[[:space:]]$'
      and display_name !~ '[[:cntrl:]]'
    )
  );

comment on column public.wedding_memberships.display_name is
  'How this member appears inside this wedding. Set only by the member themselves; presentation only, never authorization.';

-- Self-service rename. Not a column grant + RLS policy: privileges are per
-- column for the whole table, and policies are per row and OR-ed together.
-- `authenticated` already holds UPDATE(role) for owners' role management, so
-- a "members may update their own row" policy would let a collaborator
-- promote themselves, and granting UPDATE(display_name) would let owners
-- rename other members through their existing policy. This function changes
-- exactly one column of exactly the caller's own membership; the table's
-- grants and policies stay as LB-03 left them.
--
-- The caller is always auth.uid(); the function accepts no user or
-- membership id. A non-member gets the same error as a nonexistent wedding.
create function public.set_wedding_display_name(
  target_wedding_id uuid,
  new_display_name text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_name text;
begin
  if v_user_id is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  -- Blank (or only whitespace) clears the name. Over-long or control
  -- characters are rejected by the CHECK above.
  v_name := nullif(
    regexp_replace(coalesce(set_wedding_display_name.new_display_name, ''),
                   '^[[:space:]]+|[[:space:]]+$', '', 'g'),
    ''
  );

  update public.wedding_memberships m
  set display_name = v_name
  where m.wedding_id = set_wedding_display_name.target_wedding_id
    and m.user_id = v_user_id;

  if not found then
    raise exception 'wedding_not_found' using errcode = 'P0002';
  end if;

  return v_name;
end;
$$;

comment on function public.set_wedding_display_name(uuid, text) is
  'Sets the caller''s (auth.uid()) own display name in one wedding. Blank clears it.';

revoke all on function public.set_wedding_display_name(uuid, text) from public, anon, authenticated;
grant execute on function public.set_wedding_display_name(uuid, text) to authenticated;

-- ------------------------------------------------ checklist assignment

-- The target of the same-wedding foreign key below. (id is already unique;
-- this lets a child row reference the pair.)
alter table public.wedding_memberships
  add constraint wedding_memberships_id_wedding_key unique (id, wedding_id);

alter table public.checklist_items
  add column assignee_membership_id uuid;

-- Same-wedding invariant, enforced relationally: the assignee is identified
-- by (membership id, THIS ITEM'S wedding id), so a membership of another
-- wedding (or one that doesn't exist) simply isn't a valid reference. A null
-- assignee is "Sin asignar" (MATCH SIMPLE skips the check).
--
-- When the membership goes away (member removed, account deleted) only the
-- assignee is cleared; the item and its wedding_id stay.
alter table public.checklist_items
  add constraint checklist_items_assignee_same_wedding
    foreign key (assignee_membership_id, wedding_id)
    references public.wedding_memberships (id, wedding_id)
    on delete set null (assignee_membership_id);

comment on column public.checklist_items.assignee_membership_id is
  'Optional member of this wedding responsible for the item. Planning metadata only, never authorization.';

-- Serves the ON DELETE SET NULL lookup when a membership is removed. The
-- page loads the whole checklist per wedding and filters in memory, so no
-- per-assignee read index is needed.
create index checklist_items_assignee_idx
  on public.checklist_items (assignee_membership_id, wedding_id)
  where assignee_membership_id is not null;

-- Any member may assign, reassign or unassign (shared planning content);
-- checklist_items_update_member already scopes the row to members.
grant update (assignee_membership_id) on table public.checklist_items to authenticated;
