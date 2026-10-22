-- UX-01B (ADR-022, accepted 2026-10-22): curated wedding-site photography.
--
--   * public.wedding_site_photo_blocks: where photos appear on the site (one
--     cover per wedding, galleries, carousels, photo-with-text), anchored after
--     a fixed content section (null = right after the hero; the LB-10 section
--     order is unchanged). Hidden by default.
--   * public.wedding_photos: one row per uploaded photo (pending → ready),
--     at most one block per photo (same-wedding composite FK, SET NULL).
--   * public.wedding_photo_origin_usage: the monthly origin-download meter,
--     written only by the service_role-only claim.
--   * private.wedding_photo_upload_days: the per-wedding daily upload counter
--     (deleted photos still count), written only by create_wedding_photo.
--   * Storage bucket `wedding-photos` (private, 1 MB objects, image/webp only)
--     and its member policies: INSERT only the two rendition names of the
--     caller's own fresh pending photo, SELECT/DELETE for members of the
--     photo's wedding, no UPDATE (no overwrite), nothing for anon.
--   * get_published_wedding_site gains `site_photos` under the unchanged
--     publication gate; claim_published_wedding_photo (service_role only) is
--     the photo origin's one door (ADR-002 §6, the sixth module).
--
-- Object names are `<photo id>/1600.webp` and `<photo id>/640.webp`: a random
-- id, never a wedding id, slug or file name. No originals are stored.

-- ------------------------------------------------------------------ types

create type public.wedding_photo_state as enum ('pending', 'ready');

create type public.wedding_site_photo_block_kind as enum ('cover', 'gallery', 'carousel', 'photo_text');

-- Closed per kind (CHECK below): cover → standard; gallery → grid | masonry;
-- carousel → standard; photo_text → image_start | image_end.
create type public.wedding_site_photo_block_variant as enum ('standard', 'grid', 'masonry', 'image_start', 'image_end');

-- ------------------------------------------------------------- the blocks

create table public.wedding_site_photo_blocks (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  kind public.wedding_site_photo_block_kind not null,
  variant public.wedding_site_photo_block_variant not null,
  anchor public.content_section_kind,
  position integer not null default 0,
  is_visible boolean not null default false,
  title text,
  body text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wedding_site_photo_blocks_id_wedding_key unique (id, wedding_id),
  constraint wedding_site_photo_blocks_variant_check check (
    (kind = 'cover' and variant = 'standard')
    or (kind = 'gallery' and variant in ('grid', 'masonry'))
    or (kind = 'carousel' and variant = 'standard')
    or (kind = 'photo_text' and variant in ('image_start', 'image_end'))
  ),
  constraint wedding_site_photo_blocks_cover_anchor_check check (kind <> 'cover' or anchor is null),
  constraint wedding_site_photo_blocks_text_check check (kind = 'photo_text' or (title is null and body is null)),
  constraint wedding_site_photo_blocks_title_check check (
    title is null or (char_length(title) between 1 and 120 and title = btrim(title))
  ),
  constraint wedding_site_photo_blocks_body_check check (
    body is null or (char_length(body) between 1 and 2000 and body = btrim(body))
  ),
  constraint wedding_site_photo_blocks_position_check check (position >= 0)
);

comment on table public.wedding_site_photo_blocks is
  'Where photos appear on a wedding''s site (ADR-022): cover, gallery, carousel or photo with text, after a fixed section. Hidden by default.';

create unique index wedding_site_photo_blocks_one_cover
  on public.wedding_site_photo_blocks (wedding_id) where kind = 'cover';

create index wedding_site_photo_blocks_wedding_anchor_idx
  on public.wedding_site_photo_blocks (wedding_id, anchor, position);

create trigger wedding_site_photo_blocks_set_updated_at
  before update on public.wedding_site_photo_blocks
  for each row execute function private.set_updated_at();

-- ------------------------------------------------------------- the photos

create table public.wedding_photos (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  state public.wedding_photo_state not null default 'pending',
  block_id uuid,
  position integer not null default 0,
  alt_text text,
  caption text,
  focal_x integer not null default 5000,
  focal_y integer not null default 5000,
  width integer,
  height integer,
  bytes bigint,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint wedding_photos_id_wedding_key unique (id, wedding_id),
  constraint wedding_photos_block_fkey foreign key (block_id, wedding_id)
    references public.wedding_site_photo_blocks (id, wedding_id) on delete set null (block_id),
  constraint wedding_photos_state_check check (
    (state = 'pending' and block_id is null and width is null and height is null and bytes is null)
    or (state = 'ready' and width between 1 and 1600 and height between 1 and 1600 and bytes > 0)
  ),
  constraint wedding_photos_alt_text_check check (
    alt_text is null or (char_length(alt_text) between 1 and 250 and alt_text = btrim(alt_text))
  ),
  constraint wedding_photos_caption_check check (
    caption is null or (char_length(caption) between 1 and 200 and caption = btrim(caption))
  ),
  constraint wedding_photos_focal_check check (focal_x between 0 and 10000 and focal_y between 0 and 10000),
  constraint wedding_photos_position_check check (position >= 0)
);

comment on table public.wedding_photos is
  'A wedding''s uploaded photos (ADR-022): two processed WebP renditions in the private wedding-photos bucket, at most one block each.';

create index wedding_photos_wedding_state_idx on public.wedding_photos (wedding_id, state);
create index wedding_photos_block_position_idx on public.wedding_photos (block_id, position);

-- ------------------------------------------------- counters (no client access)

create table public.wedding_photo_origin_usage (
  month date primary key,
  origin_bytes bigint not null default 0,
  updated_at timestamptz not null default now(),
  constraint wedding_photo_origin_usage_month_check check (month = date_trunc('month', month)::date),
  constraint wedding_photo_origin_usage_bytes_check check (origin_bytes >= 0)
);

comment on table public.wedding_photo_origin_usage is
  'Bytes the photo origin downloaded from storage per month (ADR-022 §6 breaker). Written only by claim_published_wedding_photo.';

create table private.wedding_photo_upload_days (
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  day date not null,
  uploads integer not null default 0 check (uploads >= 0),
  primary key (wedding_id, day)
);

comment on table private.wedding_photo_upload_days is
  'Upload attempts accepted per wedding per UTC day (ADR-022 §6, §13.2). A rate limit, not wedding-planning time.';

-- ------------------------------------------------------------------ limits

-- The quotas and breakers in one place (ADR-022 §6). Raising a breaker is a
-- reviewed migration, together with a plan upgrade.
create function private.wedding_photo_limit(limit_name text)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case limit_name
    when 'photos_per_wedding' then 20
    when 'uploads_per_day' then 60
    when 'concurrent_pending' then 3
    when 'bytes_per_wedding' then 40 * 1024 * 1024
    when 'bytes_per_photo' then 2 * 1024 * 1024          -- two objects of at most 1 MB
    when 'bytes_total' then 800 * 1024 * 1024            -- of the 1 GB free storage
    when 'origin_bytes_per_month' then 3::bigint * 1024 * 1024 * 1024  -- of the 5 GB shared egress
    when 'blocks_per_wedding' then 12
    when 'photos_per_single_block' then 1
    when 'pending_minutes' then 15
  end::bigint;
$$;

revoke all on function private.wedding_photo_limit(text) from public;
grant execute on function private.wedding_photo_limit(text) to authenticated;

-- ---------------------------------------------------------- block triggers

-- New blocks: at most `blocks_per_wedding` per wedding, appended at the end.
-- SECURITY INVOKER: the member's own RLS applies; the advisory lock only
-- serializes concurrent inserts for the same wedding.
create function private.prepare_wedding_site_photo_block()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('lb_wedding_site_photo_blocks:' || new.wedding_id::text, 0));

  select count(*), coalesce(max(b.position) + 1, 0)
    into v_count, new.position
  from public.wedding_site_photo_blocks b
  where b.wedding_id = new.wedding_id;

  if v_count >= private.wedding_photo_limit('blocks_per_wedding') then
    raise exception 'wedding_site_photo_block_limit'
      using errcode = '23514',
            detail = 'A wedding has at most 12 photo blocks.';
  end if;

  return new;
end;
$$;

revoke all on function private.prepare_wedding_site_photo_block() from public;

create trigger wedding_site_photo_blocks_prepare
  before insert on public.wedding_site_photo_blocks
  for each row execute function private.prepare_wedding_site_photo_block();

-- ---------------------------------------------------------- photo triggers

-- Placing a photo in a block: a cover or photo-with-text block holds one
-- photo; the photo goes to the end of the block. The block row is locked so
-- two concurrent placements can't both take the last place. Leaving a block
-- (null, including the FK's SET NULL) needs no check.
create function private.place_wedding_photo()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_kind public.wedding_site_photo_block_kind;
  v_count integer;
begin
  if new.block_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.block_id is not distinct from new.block_id then
    return new;
  end if;

  select b.kind
    into v_kind
  from public.wedding_site_photo_blocks b
  where b.id = new.block_id
    and b.wedding_id = new.wedding_id
  for update;

  if not found then
    -- Not a block of this wedding (or not visible): the composite FK or RLS refuses it.
    return new;
  end if;

  select count(*), coalesce(max(p.position) + 1, 0)
    into v_count, new.position
  from public.wedding_photos p
  where p.block_id = new.block_id
    and p.id <> new.id;

  if v_kind in ('cover', 'photo_text') and v_count >= private.wedding_photo_limit('photos_per_single_block') then
    raise exception 'wedding_photo_block_full'
      using errcode = '23514',
            detail = 'A cover or photo-with-text block holds one photo.';
  end if;

  return new;
end;
$$;

revoke all on function private.place_wedding_photo() from public;

create trigger wedding_photos_place
  before insert or update of block_id on public.wedding_photos
  for each row execute function private.place_wedding_photo();

-- ---------------------------------------------------------------- RLS

alter table public.wedding_site_photo_blocks enable row level security;
alter table public.wedding_photos enable row level security;
alter table public.wedding_photo_origin_usage enable row level security;
alter table private.wedding_photo_upload_days enable row level security;

create policy "wedding_site_photo_blocks: members read"
  on public.wedding_site_photo_blocks for select to authenticated
  using (private.is_wedding_member(wedding_id));

create policy "wedding_site_photo_blocks: members insert"
  on public.wedding_site_photo_blocks for insert to authenticated
  with check (private.is_wedding_member(wedding_id));

create policy "wedding_site_photo_blocks: members update"
  on public.wedding_site_photo_blocks for update to authenticated
  using (private.is_wedding_member(wedding_id))
  with check (private.is_wedding_member(wedding_id));

create policy "wedding_site_photo_blocks: members delete"
  on public.wedding_site_photo_blocks for delete to authenticated
  using (private.is_wedding_member(wedding_id));

create policy "wedding_photos: members read"
  on public.wedding_photos for select to authenticated
  using (private.is_wedding_member(wedding_id));

create policy "wedding_photos: members update"
  on public.wedding_photos for update to authenticated
  using (private.is_wedding_member(wedding_id))
  with check (private.is_wedding_member(wedding_id));

create policy "wedding_photos: members delete"
  on public.wedding_photos for delete to authenticated
  using (private.is_wedding_member(wedding_id));

-- No INSERT policy on wedding_photos: rows are created only by
-- create_wedding_photo (quotas). No policies at all on the counters.

revoke all on public.wedding_site_photo_blocks from anon, authenticated;
revoke all on public.wedding_photos from anon, authenticated;
revoke all on public.wedding_photo_origin_usage from anon, authenticated, service_role;
revoke all on private.wedding_photo_upload_days from public, anon, authenticated, service_role;

grant select (id, wedding_id, kind, variant, anchor, position, is_visible, title, body, created_at, updated_at)
  on public.wedding_site_photo_blocks to authenticated;
grant insert (wedding_id, kind, variant, anchor, title, body) on public.wedding_site_photo_blocks to authenticated;
grant update (variant, anchor, position, is_visible, title, body) on public.wedding_site_photo_blocks to authenticated;
grant delete on public.wedding_site_photo_blocks to authenticated;

grant select (id, wedding_id, state, block_id, position, alt_text, caption, focal_x, focal_y, width, height, bytes, created_at)
  on public.wedding_photos to authenticated;
grant update (block_id, position, alt_text, caption, focal_x, focal_y) on public.wedding_photos to authenticated;
grant delete on public.wedding_photos to authenticated;

-- ----------------------------------------------------------------- bucket

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wedding-photos', 'wedding-photos', false, 1048576, array['image/webp']);

-- The photo id of a rendition object name, or null for any other name.
create function private.wedding_photo_object_id(object_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when object_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(1600|640)\.webp$'
      then split_part(object_name, '/', 1)::uuid
  end;
$$;

-- A member may write exactly the two rendition names of a pending photo of
-- their wedding that THEY created in the last 15 minutes.
create function private.can_upload_wedding_photo_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.wedding_photos p
    where p.id = private.wedding_photo_object_id(object_name)
      and p.state = 'pending'
      and p.created_by = auth.uid()
      and p.created_at > now() - make_interval(mins => private.wedding_photo_limit('pending_minutes')::integer)
      and private.is_wedding_member(p.wedding_id)
  );
$$;

-- A member may read or delete the renditions of any photo of their wedding.
create function private.can_access_wedding_photo_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.wedding_photos p
    where p.id = private.wedding_photo_object_id(object_name)
      and private.is_wedding_member(p.wedding_id)
  );
$$;

revoke all on function private.wedding_photo_object_id(text) from public;
revoke all on function private.can_upload_wedding_photo_object(text) from public;
revoke all on function private.can_access_wedding_photo_object(text) from public;
grant execute on function private.wedding_photo_object_id(text) to authenticated;
grant execute on function private.can_upload_wedding_photo_object(text) to authenticated;
grant execute on function private.can_access_wedding_photo_object(text) to authenticated;

create policy "wedding-photos: members upload pending renditions"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'wedding-photos' and private.can_upload_wedding_photo_object(name));

create policy "wedding-photos: members read"
  on storage.objects for select to authenticated
  using (bucket_id = 'wedding-photos' and private.can_access_wedding_photo_object(name));

create policy "wedding-photos: members delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'wedding-photos' and private.can_access_wedding_photo_object(name));

-- No UPDATE policy (no overwrite or move) and nothing for anon.

-- -------------------------------------------------------------- upload RPCs

-- Starts one upload: locks the wedding, deletes its stale pending rows (the
-- caller removed their objects first, ADR-022 §13.3), enforces every quota
-- and breaker, and returns the new pending photo's id. Refusals are named
-- (check_violation); a non-member gets the same error as a missing wedding.
create function public.create_wedding_photo(target_wedding_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_total bigint;
  v_count integer;
  v_pending integer;
  v_bytes bigint;
  v_uploads integer;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  perform 1 from public.weddings w where w.id = target_wedding_id for no key update;
  if not found or not private.is_wedding_member(target_wedding_id) then
    raise exception 'wedding_not_found' using errcode = 'P0002';
  end if;

  delete from public.wedding_photos p
  where p.wedding_id = target_wedding_id
    and p.state = 'pending'
    and p.created_at <= now() - make_interval(mins => private.wedding_photo_limit('pending_minutes')::integer);

  select coalesce(sum((o.metadata ->> 'size')::bigint), 0)
    into v_total
  from storage.objects o
  where o.bucket_id = 'wedding-photos';
  if v_total + private.wedding_photo_limit('bytes_per_photo') > private.wedding_photo_limit('bytes_total') then
    raise exception 'wedding_photos_paused' using errcode = '23514';
  end if;

  select count(*), count(*) filter (where p.state = 'pending'), coalesce(sum(p.bytes), 0)
    into v_count, v_pending, v_bytes
  from public.wedding_photos p
  where p.wedding_id = target_wedding_id;

  if v_count >= private.wedding_photo_limit('photos_per_wedding') then
    raise exception 'wedding_photo_limit' using errcode = '23514';
  end if;
  if v_pending >= private.wedding_photo_limit('concurrent_pending') then
    raise exception 'wedding_photo_busy' using errcode = '23514';
  end if;
  if v_bytes + private.wedding_photo_limit('bytes_per_photo') > private.wedding_photo_limit('bytes_per_wedding') then
    raise exception 'wedding_photo_storage_limit' using errcode = '23514';
  end if;

  insert into private.wedding_photo_upload_days as d (wedding_id, day, uploads)
  values (target_wedding_id, (now() at time zone 'utc')::date, 1)
  on conflict (wedding_id, day) do update set uploads = d.uploads + 1
  returning d.uploads into v_uploads;
  if v_uploads > private.wedding_photo_limit('uploads_per_day') then
    raise exception 'wedding_photo_daily_limit' using errcode = '23514';
  end if;

  insert into public.wedding_photos (wedding_id, created_by)
  values (target_wedding_id, v_uid)
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.create_wedding_photo(uuid) is
  'Starts a photo upload (ADR-022 §3): quotas and breakers under the wedding lock, stale pending sweep, new pending row.';

-- Finishes one upload: the caller's own fresh pending photo becomes ready
-- only if BOTH rendition objects exist as WebP; their sizes come from
-- storage, never from the caller, and the wedding's 40 MB budget is checked
-- again. The dimensions are the large rendition's (re-validated on delivery).
create function public.complete_wedding_photo(target_photo_id uuid, rendition_width integer, rendition_height integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wedding uuid;
  v_objects integer;
  v_size bigint;
  v_used bigint;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select p.wedding_id into v_wedding
  from public.wedding_photos p
  where p.id = target_photo_id;
  if not found then
    raise exception 'wedding_photo_not_found' using errcode = 'P0002';
  end if;

  perform 1 from public.weddings w where w.id = v_wedding for no key update;

  perform 1
  from public.wedding_photos p
  where p.id = target_photo_id
    and p.state = 'pending'
    and p.created_by = auth.uid()
    and p.created_at > now() - make_interval(mins => private.wedding_photo_limit('pending_minutes')::integer)
    and private.is_wedding_member(p.wedding_id)
  for update;
  if not found then
    raise exception 'wedding_photo_not_found' using errcode = 'P0002';
  end if;

  if rendition_width is null or rendition_height is null
     or rendition_width not between 1 and 1600 or rendition_height not between 1 and 1600 then
    raise exception 'wedding_photo_invalid' using errcode = '23514';
  end if;

  select count(*), coalesce(sum((o.metadata ->> 'size')::bigint), 0)
    into v_objects, v_size
  from storage.objects o
  where o.bucket_id = 'wedding-photos'
    and o.name in (target_photo_id::text || '/1600.webp', target_photo_id::text || '/640.webp')
    and o.metadata ->> 'mimetype' = 'image/webp';
  if v_objects <> 2 or v_size <= 0 then
    raise exception 'wedding_photo_incomplete' using errcode = '23514';
  end if;

  select coalesce(sum(p.bytes), 0) into v_used
  from public.wedding_photos p
  where p.wedding_id = v_wedding and p.state = 'ready';
  if v_used + v_size > private.wedding_photo_limit('bytes_per_wedding') then
    raise exception 'wedding_photo_storage_limit' using errcode = '23514';
  end if;

  update public.wedding_photos
  set state = 'ready', width = rendition_width, height = rendition_height, bytes = v_size
  where id = target_photo_id;

  return true;
end;
$$;

comment on function public.complete_wedding_photo(uuid, integer, integer) is
  'Finishes a photo upload (ADR-022 §3): both WebP renditions must exist; sizes are read from storage; 40 MB budget re-checked.';

revoke all on function public.create_wedding_photo(uuid) from public, anon, authenticated;
revoke all on function public.complete_wedding_photo(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.create_wedding_photo(uuid) to authenticated;
grant execute on function public.complete_wedding_photo(uuid, integer, integer) to authenticated;

-- ------------------------------------------------------------ editor RPCs

-- Makes a ready photo the wedding's cover: creates the (hidden) cover block if
-- there is none, moves the previous cover photo back to the library, and
-- returns its id (to purge its cached copies) or null. SECURITY INVOKER: the
-- member's RLS and grants apply to every statement.
create function public.set_wedding_cover_photo(target_wedding_id uuid, target_photo_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_block uuid;
  v_previous uuid;
begin
  perform 1
  from public.wedding_photos p
  where p.id = target_photo_id
    and p.wedding_id = target_wedding_id
    and p.state = 'ready'
  for update;
  if not found then
    raise exception 'wedding_photo_not_found' using errcode = 'P0002';
  end if;

  select b.id into v_block
  from public.wedding_site_photo_blocks b
  where b.wedding_id = target_wedding_id and b.kind = 'cover'
  for update;

  if v_block is null then
    insert into public.wedding_site_photo_blocks (wedding_id, kind, variant)
    values (target_wedding_id, 'cover', 'standard')
    returning id into v_block;
  end if;

  select p.id into v_previous
  from public.wedding_photos p
  where p.block_id = v_block and p.id <> target_photo_id
  limit 1;

  update public.wedding_photos
  set block_id = null
  where block_id = v_block and id <> target_photo_id;

  update public.wedding_photos
  set block_id = v_block
  where id = target_photo_id;

  return v_previous;
end;
$$;

comment on function public.set_wedding_cover_photo(uuid, uuid) is
  'Makes a ready photo the cover (ADR-022 §8): one write; the previous cover photo returns to the library.';

-- "Mover antes / Mover después": swaps a block with its neighbor in the same
-- anchor slot, or a photo with its neighbor in the same block. Returns false
-- when there is no neighbor in that direction. SECURITY INVOKER (RLS applies).
create function public.move_wedding_site_photo_block(target_block_id uuid, direction text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_block public.wedding_site_photo_blocks%rowtype;
  v_other uuid;
  v_other_position integer;
begin
  if direction not in ('before', 'after') then
    raise exception 'wedding_photo_invalid' using errcode = '23514';
  end if;

  select * into v_block from public.wedding_site_photo_blocks b where b.id = target_block_id for update;
  if not found or v_block.kind = 'cover' then
    raise exception 'wedding_photo_not_found' using errcode = 'P0002';
  end if;

  select b.id, b.position into v_other, v_other_position
  from public.wedding_site_photo_blocks b
  where b.wedding_id = v_block.wedding_id
    and b.kind <> 'cover'
    and b.anchor is not distinct from v_block.anchor
    and b.id <> v_block.id
    and case when direction = 'before'
          then (b.position, b.id) < (v_block.position, v_block.id)
          else (b.position, b.id) > (v_block.position, v_block.id) end
  order by
    case when direction = 'before' then b.position end desc,
    case when direction = 'before' then b.id end desc,
    case when direction = 'after' then b.position end asc,
    case when direction = 'after' then b.id end asc
  limit 1
  for update;

  if v_other is null then
    return false;
  end if;

  if v_other_position = v_block.position then
    -- Equal positions (never written by the app): separate them first.
    v_other_position := v_block.position + case when direction = 'before' then -1 else 1 end;
    if v_other_position < 0 then
      update public.wedding_site_photo_blocks set position = position + 1 where id = v_block.id;
      v_block.position := v_block.position + 1;
      v_other_position := v_block.position - 1;
    end if;
  end if;

  update public.wedding_site_photo_blocks set position = v_block.position where id = v_other;
  update public.wedding_site_photo_blocks set position = v_other_position where id = v_block.id;
  return true;
end;
$$;

create function public.move_wedding_photo(target_photo_id uuid, direction text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- Named columns only: members have no SELECT on every column (created_by).
  v_photo record;
  v_other uuid;
  v_other_position integer;
begin
  if direction not in ('before', 'after') then
    raise exception 'wedding_photo_invalid' using errcode = '23514';
  end if;

  select p.id, p.block_id, p.position into v_photo
  from public.wedding_photos p where p.id = target_photo_id for update;
  if not found or v_photo.block_id is null then
    raise exception 'wedding_photo_not_found' using errcode = 'P0002';
  end if;

  select p.id, p.position into v_other, v_other_position
  from public.wedding_photos p
  where p.block_id = v_photo.block_id
    and p.id <> v_photo.id
    and case when direction = 'before'
          then (p.position, p.id) < (v_photo.position, v_photo.id)
          else (p.position, p.id) > (v_photo.position, v_photo.id) end
  order by
    case when direction = 'before' then p.position end desc,
    case when direction = 'before' then p.id end desc,
    case when direction = 'after' then p.position end asc,
    case when direction = 'after' then p.id end asc
  limit 1
  for update;

  if v_other is null then
    return false;
  end if;

  if v_other_position = v_photo.position then
    v_other_position := v_photo.position + case when direction = 'before' then -1 else 1 end;
    if v_other_position < 0 then
      update public.wedding_photos set position = position + 1 where id = v_photo.id;
      v_photo.position := v_photo.position + 1;
      v_other_position := v_photo.position - 1;
    end if;
  end if;

  update public.wedding_photos set position = v_photo.position where id = v_other;
  update public.wedding_photos set position = v_other_position where id = v_photo.id;
  return true;
end;
$$;

revoke all on function public.set_wedding_cover_photo(uuid, uuid) from public, anon, authenticated;
revoke all on function public.move_wedding_site_photo_block(uuid, text) from public, anon, authenticated;
revoke all on function public.move_wedding_photo(uuid, text) from public, anon, authenticated;
grant execute on function public.set_wedding_cover_photo(uuid, uuid) to authenticated;
grant execute on function public.move_wedding_site_photo_block(uuid, text) to authenticated;
grant execute on function public.move_wedding_photo(uuid, text) to authenticated;

-- ------------------------------------------------------- the public predicate

-- THE one definition of a public photo (ADR-022 §13.4): ready, with alt text,
-- in a visible block. Used by the public read and the origin claim (both
-- SECURITY DEFINER, which run it as its owner); no client may execute it.
-- The caller adds the publication gate.
create function private.public_wedding_photos(target_wedding_id uuid)
returns table (
  block_id uuid,
  block_kind public.wedding_site_photo_block_kind,
  block_variant public.wedding_site_photo_block_variant,
  block_anchor public.content_section_kind,
  block_position integer,
  block_title text,
  block_body text,
  photo_id uuid,
  photo_position integer,
  width integer,
  height integer,
  alt_text text,
  caption text,
  focal_x integer,
  focal_y integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  select b.id, b.kind, b.variant, b.anchor, b.position, b.title, b.body,
         p.id, p.position, p.width, p.height, p.alt_text, p.caption, p.focal_x, p.focal_y
  from public.wedding_site_photo_blocks b
  join public.wedding_photos p on p.block_id = b.id and p.wedding_id = b.wedding_id
  where b.wedding_id = target_wedding_id
    and b.is_visible
    and p.state = 'ready'
    and p.alt_text is not null;
$$;

revoke all on function private.public_wedding_photos(uuid) from public, anon, authenticated, service_role;

-- --------------------------------------------------------- the public read

drop function public.get_published_wedding_site(text);

create function public.get_published_wedding_site(site_slug text)
returns table (
  wedding_name text,
  wedding_date date,
  wedding_city text,
  section_kind public.content_section_kind,
  section_title text,
  section_body text,
  site_theme public.wedding_site_theme,
  site_customization jsonb,
  site_photos jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  with pub as (
    select p.wedding_id
    from public.wedding_publications p
    where p.slug = get_published_wedding_site.site_slug
      and p.published_at is not null
  ),
  photos as (
    -- Visible blocks with at least one public photo, in position order; per
    -- photo only what the renderer needs. No paths, wedding ids, uploader,
    -- timestamps or sizes.
    select coalesce(jsonb_agg(blk.doc order by blk.block_position, blk.block_id), '[]'::jsonb) as doc
    from (
      select x.block_id, x.block_position,
             jsonb_build_object(
               'kind', x.block_kind,
               'variant', x.block_variant,
               'anchor', x.block_anchor,
               'title', x.block_title,
               'body', x.block_body,
               'photos', jsonb_agg(
                 jsonb_build_object(
                   'id', x.photo_id,
                   'width', x.width,
                   'height', x.height,
                   'alt', x.alt_text,
                   'caption', x.caption,
                   'focalX', x.focal_x,
                   'focalY', x.focal_y
                 ) order by x.photo_position, x.photo_id
               )
             ) as doc
      from pub, private.public_wedding_photos(pub.wedding_id) x
      group by x.block_id, x.block_position, x.block_kind, x.block_variant, x.block_anchor, x.block_title, x.block_body
    ) blk
  )
  select w.name, w.wedding_date, w.city, s.kind, s.title, s.body,
         coalesce(d.theme_key, 'classic'::public.wedding_site_theme),
         coalesce(d.customization, '{}'::jsonb),
         (select photos.doc from photos)
  from pub
  join public.weddings w on w.id = pub.wedding_id
  left join public.wedding_site_designs d on d.wedding_id = pub.wedding_id
  left join public.content_sections s
    on s.wedding_id = pub.wedding_id
   and s.is_visible
   and (s.body is not null or s.kind = 'rsvp')
  order by s.kind;
$$;

comment on function public.get_published_wedding_site(text) is
  'Public read path: a published wedding website by slug (safe wedding fields + visible sections + theme key + customization + public photos). No rows unless published.';

revoke all on function public.get_published_wedding_site(text) from public, anon, authenticated;
grant execute on function public.get_published_wedding_site(text) to anon, authenticated;

-- -------------------------------------------------------- the origin claim

-- The photo origin's one door (ADR-022 §4; ADR-002 §6, the sixth module):
-- the object name of one rendition, only if the slug's wedding is published,
-- the photo is public there (the shared predicate) and the month's origin
-- budget allows its size, which is added to the meter. Otherwise null, the
-- same for every reason. service_role only.
create function public.claim_published_wedding_photo(site_slug text, target_photo_id uuid, rendition text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_wedding uuid;
  v_name text;
  v_size bigint;
  v_month date := date_trunc('month', now() at time zone 'utc')::date;
begin
  if rendition is null or rendition not in ('1600', '640') then
    return null;
  end if;

  select p.wedding_id into v_wedding
  from public.wedding_publications p
  where p.slug = claim_published_wedding_photo.site_slug
    and p.published_at is not null;
  if v_wedding is null then
    return null;
  end if;

  if not exists (
    select 1 from private.public_wedding_photos(v_wedding) x where x.photo_id = target_photo_id
  ) then
    return null;
  end if;

  v_name := target_photo_id::text || '/' || rendition || '.webp';
  select (o.metadata ->> 'size')::bigint into v_size
  from storage.objects o
  where o.bucket_id = 'wedding-photos' and o.name = v_name;
  if v_size is null or v_size <= 0 then
    return null;
  end if;

  insert into public.wedding_photo_origin_usage (month) values (v_month) on conflict (month) do nothing;
  update public.wedding_photo_origin_usage
  set origin_bytes = origin_bytes + v_size, updated_at = now()
  where month = v_month
    and origin_bytes + v_size <= private.wedding_photo_limit('origin_bytes_per_month');
  if not found then
    return null;
  end if;

  return v_name;
end;
$$;

comment on function public.claim_published_wedding_photo(text, uuid, text) is
  'Photo origin claim (ADR-022 §4): object name of a public rendition of a published site, within the monthly origin budget. service_role only.';

revoke all on function public.claim_published_wedding_photo(text, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_published_wedding_photo(text, uuid, text) to service_role;
