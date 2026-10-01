-- LB-05: controlled, atomic checklist initialization from a template.
--
-- An explicit RPC (not part of create_wedding, not a trigger): seeding is a
-- deliberate product action by an owner, and the provenance it records is
-- explicit. It runs as the function owner because clients can neither read
-- templates nor write provenance columns; every authority decision is made
-- here from auth.uid() and wedding_memberships.
--
-- Rules:
--   * caller must be signed in;
--   * caller must be an OWNER of the wedding (seeding changes the wedding's
--     shared content wholesale; day-to-day editing is open to collaborators);
--     a non-member gets the same error as a nonexistent wedding;
--   * the template is the active 'default-wedding-es' version (the highest
--     active one); its exact id/version is recorded;
--   * a wedding is seeded at most once: a second call changes nothing and
--     reports already_initialized (the unique wedding_id on
--     wedding_checklist_template_applications enforces this, also under
--     concurrency);
--   * all-or-nothing: the record and every copied item are written in one
--     transaction.
--
-- The function accepts no user id and no template content.

create function public.initialize_wedding_checklist(target_wedding_id uuid)
returns table (template_key text, template_version integer, item_count integer, already_initialized boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user_id uuid := auth.uid();
  v_template public.checklist_templates;
  v_application_id uuid;
  v_item_count integer;
begin
  if v_user_id is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  if not private.is_wedding_member(initialize_wedding_checklist.target_wedding_id) then
    raise exception 'wedding_not_found' using errcode = 'P0002';
  end if;

  if not private.has_wedding_role(
    initialize_wedding_checklist.target_wedding_id,
    array['owner']::public.wedding_role[]
  ) then
    raise exception 'checklist_initialize_forbidden' using errcode = '42501';
  end if;

  select t.* into v_template
  from public.checklist_templates t
  where t.key = 'default-wedding-es'
    and t.is_active
  order by t.version desc
  limit 1;

  if not found then
    raise exception 'checklist_template_unavailable' using errcode = 'P0002';
  end if;

  insert into public.wedding_checklist_template_applications (wedding_id, template_id, applied_by)
  values (initialize_wedding_checklist.target_wedding_id, v_template.id, v_user_id)
  on conflict (wedding_id) do nothing
  returning id into v_application_id;

  if v_application_id is null then
    -- Already seeded (possibly by a concurrent call that just committed).
    return query
      select t.key, t.version, 0, true
      from public.wedding_checklist_template_applications a
      join public.checklist_templates t on t.id = a.template_id
      where a.wedding_id = initialize_wedding_checklist.target_wedding_id;
    return;
  end if;

  insert into public.checklist_items (
    wedding_id, source_template_item_id, title, description, category,
    timing_mode, relative_days, sort_order, created_by
  )
  select
    initialize_wedding_checklist.target_wedding_id, ti.id, ti.title, ti.description, ti.category,
    ti.timing_mode, ti.relative_days, ti.sort_order, v_user_id
  from public.checklist_template_items ti
  where ti.template_id = v_template.id;

  get diagnostics v_item_count = row_count;

  return query select v_template.key, v_template.version, v_item_count, false;
end;
$$;

comment on function public.initialize_wedding_checklist(uuid) is
  'Owner-only, atomic, at-most-once: copies the active default template into the wedding''s checklist for auth.uid().';

revoke all on function public.initialize_wedding_checklist(uuid) from public, anon, authenticated;
grant execute on function public.initialize_wedding_checklist(uuid) to authenticated;
