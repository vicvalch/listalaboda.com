-- Wedding site themes (ADR-019 §4, CP4): the wedding website's chosen
-- curated theme, and the public projection of it.
--
-- Design is presentation only, a third authority next to content
-- (content_sections) and publication (wedding_publications), never merged
-- with either:
--   * one row per wedding holding ONLY the theme key: no wedding data, no
--     content, no guest or RSVP data, no URLs, no free-form JSON;
--   * any member (owner or collaborator) chooses it, like content; it never
--     publishes or unpublishes anything (publication stays owner-only and
--     unchanged);
--   * no row = Classic. Existing weddings need no backfill, and nothing
--     writes a Classic row on read: the public read coalesces, and the
--     application falls back to Classic again for anything unknown.
--   * no DELETE: going back to the original look means choosing Classic.
--
-- The public sees the theme only through get_published_wedding_site, under
-- the existing publication gate, as one more column: the theme key.

create type public.wedding_site_theme as enum (
  'classic',
  'editorial',
  'minimal',
  'romantic',
  'tropical'
);

comment on type public.wedding_site_theme is
  'Curated wedding website themes (ADR-019). Mirrors WEDDING_SITE_THEME_KEYS in src/lib/wedding-site/design/themes.ts. Values are never removed.';

create table public.wedding_site_designs (
  -- At most one design per wedding; it can't move between weddings.
  wedding_id uuid primary key references public.weddings (id) on delete cascade,
  theme_key public.wedding_site_theme not null default 'classic',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.wedding_site_designs is
  'Private, presentation-only design choice of a wedding website (ADR-019). No row = Classic. Public only as the theme key through get_published_wedding_site while published.';
comment on column public.wedding_site_designs.theme_key is
  'The chosen curated theme. Changing it never touches content or publication.';

alter table public.wedding_site_designs enable row level security;
revoke all on table public.wedding_site_designs from anon, authenticated;

create trigger wedding_site_designs_set_updated_at
  before update on public.wedding_site_designs
  for each row execute function private.set_updated_at();

-- ------------------------------------------------------ privileges + RLS
--
-- Any member of the wedding. Only theme_key is updatable: wedding_id never
-- changes, so a design can't be moved to another wedding. No DELETE.

grant select (wedding_id, theme_key, created_at, updated_at)
  on table public.wedding_site_designs to authenticated;
grant insert (wedding_id, theme_key) on table public.wedding_site_designs to authenticated;
grant update (theme_key) on table public.wedding_site_designs to authenticated;

create policy wedding_site_designs_select_member
  on public.wedding_site_designs for select
  to authenticated
  using (private.is_wedding_member(wedding_id));

create policy wedding_site_designs_insert_member
  on public.wedding_site_designs for insert
  to authenticated
  with check (private.is_wedding_member(wedding_id));

create policy wedding_site_designs_update_member
  on public.wedding_site_designs for update
  to authenticated
  using (private.is_wedding_member(wedding_id))
  with check (private.is_wedding_member(wedding_id));

-- ------------------------------------------------ save_wedding_site_design

-- Chooses the theme of a wedding's website: inserted the first time,
-- updated afterwards (one row per wedding). SECURITY INVOKER: it runs with
-- the caller's own privileges and RLS, exactly like the equivalent table
-- writes; it only adds the atomic insert-or-update and a clear error for a
-- non-member (the same as a nonexistent wedding). Returns the saved theme.
create function public.save_wedding_site_design(
  target_wedding_id uuid,
  new_theme public.wedding_site_theme
)
returns public.wedding_site_theme
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_theme public.wedding_site_theme;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.is_wedding_member(save_wedding_site_design.target_wedding_id) then
    raise exception 'wedding_not_found' using errcode = 'P0002';
  end if;
  if save_wedding_site_design.new_theme is null then
    raise exception 'wedding_site_theme_required' using errcode = '22023';
  end if;

  insert into public.wedding_site_designs as d (wedding_id, theme_key)
  values (save_wedding_site_design.target_wedding_id, save_wedding_site_design.new_theme)
  on conflict (wedding_id) do update set theme_key = excluded.theme_key
  returning d.theme_key into v_theme;

  return v_theme;
end;
$$;

comment on function public.save_wedding_site_design(uuid, public.wedding_site_theme) is
  'Inserts or updates the website theme of a wedding, as the caller (any member; RLS applies).';

revoke all on function public.save_wedding_site_design(uuid, public.wedding_site_theme)
  from public, anon, authenticated;
grant execute on function public.save_wedding_site_design(uuid, public.wedding_site_theme)
  to authenticated;

-- ------------------------------------------------ public read boundary

-- Same function, same gate, same rows, plus one column: site_theme, the
-- wedding's chosen theme or 'classic' when it has none. Its return type
-- changes, so it is dropped and recreated (in this migration's transaction)
-- with the original privileges. Everything else is unchanged from LB-10:
-- the ONLY public read path to wedding data, exactly one PUBLISHED site by
-- slug, the wedding's name, date and city plus one row per VISIBLE section
-- in canonical kind order. Never: wedding id, created_by, time zone,
-- timestamps, members, checklist, guests, RSVPs, hidden sections, design
-- metadata or anything of an unpublished wedding. Unknown, unpublished and
-- malformed slugs all return no rows.
drop function public.get_published_wedding_site(text);

create function public.get_published_wedding_site(site_slug text)
returns table (
  wedding_name text,
  wedding_date date,
  wedding_city text,
  section_kind public.content_section_kind,
  section_title text,
  section_body text,
  site_theme public.wedding_site_theme
)
language sql
stable
security definer
set search_path = ''
as $$
  select w.name, w.wedding_date, w.city, s.kind, s.title, s.body,
         coalesce(d.theme_key, 'classic'::public.wedding_site_theme)
  from public.wedding_publications p
  join public.weddings w on w.id = p.wedding_id
  left join public.wedding_site_designs d on d.wedding_id = p.wedding_id
  left join public.content_sections s
    on s.wedding_id = p.wedding_id
   and s.is_visible
   and (s.body is not null or s.kind = 'rsvp')
  where p.slug = get_published_wedding_site.site_slug
    and p.published_at is not null
  order by s.kind;
$$;

comment on function public.get_published_wedding_site(text) is
  'Public read path: a published wedding website by slug (safe wedding fields + visible sections + theme key). No rows unless published.';

revoke all on function public.get_published_wedding_site(text) from public, anon, authenticated;
grant execute on function public.get_published_wedding_site(text) to anon, authenticated;
