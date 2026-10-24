-- STUDIO-02A: one transaction for an existing block's same-slot placement.
-- Additive: existing callers, columns, RLS and publication are unchanged.
create function public.reorder_wedding_site_photo_block(
  target_wedding_id uuid,
  target_block_id uuid,
  expected_anchor text,
  expected_order uuid[],
  before_block_id uuid default null
)
returns uuid[]
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_block public.wedding_site_photo_blocks%rowtype;
  v_order uuid[];
  v_next uuid[] := array[]::uuid[];
  v_id uuid;
begin
  if auth.uid() is null or not private.is_wedding_member(target_wedding_id) then
    raise exception 'wedding_photo_not_found' using errcode = 'P0002';
  end if;

  -- Same key as prepare_wedding_site_photo_block: no inserts can enter
  -- between the slot snapshot and commit. At most 12 blocks per wedding.
  perform pg_advisory_xact_lock(hashtextextended('lb_wedding_site_photo_blocks:' || target_wedding_id::text, 0));
  -- Lock ALL wedding blocks so a concurrent anchor edit cannot enter the
  -- slot. UUID order is stable, independent of positions being changed.
  perform b.id from public.wedding_site_photo_blocks b
    where b.wedding_id = target_wedding_id order by b.id for update;

  select * into v_block from public.wedding_site_photo_blocks b
    where b.id = target_block_id and b.wedding_id = target_wedding_id;
  if not found or v_block.kind not in ('gallery', 'carousel', 'photo_text') then
    raise exception 'wedding_photo_not_found' using errcode = 'P0002';
  end if;
  if expected_anchor is distinct from coalesce(v_block.anchor::text, 'top') then
    raise exception 'wedding_photo_stale_order' using errcode = '40001';
  end if;
  select array_agg(b.id order by b.position, b.id) into v_order
    from public.wedding_site_photo_blocks b
    where b.wedding_id = target_wedding_id and b.kind <> 'cover'
      and b.anchor is not distinct from v_block.anchor;
  if expected_order is distinct from v_order then
    raise exception 'wedding_photo_stale_order' using errcode = '40001';
  end if;
  if before_block_id is not null and not (before_block_id = any(v_order)) then
    raise exception 'wedding_photo_invalid' using errcode = '23514';
  end if;
  if before_block_id = target_block_id then return v_order; end if;

  foreach v_id in array v_order loop
    if v_id = before_block_id then v_next := array_append(v_next, target_block_id); end if;
    if v_id <> target_block_id then v_next := array_append(v_next, v_id); end if;
  end loop;
  if before_block_id is null then v_next := array_append(v_next, target_block_id); end if;
  if v_next = v_order then return v_order; end if;

  -- One statement; any trigger, RLS, constraint or transaction failure
  -- rolls back every position. No content/visibility/photo rows are written.
  update public.wedding_site_photo_blocks b set position = o.ordinality::integer - 1
    from unnest(v_next) with ordinality as o(id, ordinality)
    where b.id = o.id and b.wedding_id = target_wedding_id;
  select array_agg(b.id order by b.position, b.id) into v_order
    from public.wedding_site_photo_blocks b
    where b.wedding_id = target_wedding_id and b.kind <> 'cover'
      and b.anchor is not distinct from v_block.anchor;
  if v_order is distinct from v_next then
    raise exception 'wedding_photo_stale_order' using errcode = '40001';
  end if;
  return v_order;
end;
$$;

revoke all on function public.reorder_wedding_site_photo_block(uuid, uuid, text, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.reorder_wedding_site_photo_block(uuid, uuid, text, uuid[], uuid) to authenticated;
comment on function public.reorder_wedding_site_photo_block(uuid, uuid, text, uuid[], uuid) is
  'STUDIO-02A: atomic same-slot placement with expected order; RLS applies. Legacy swaps may cause a transaction-aborting deadlock; refresh and retry, never replay automatically.';
