-- LB-10: the wedding website's content — ContentSection (Constitution §6,
-- §8 Phase 2 "minimal wedding website made of explicitly published
-- content"; ADR-001 §2; ADR-002 §7; ADR-003 "website sections ... generic,
-- data-driven").
--
-- A ContentSection is wedding-owned planning content, like the checklist:
-- any member (owner or collaborator) reads and edits it. It is PRIVATE.
-- Nothing here is public by itself: a section reaches the public only
-- through public.get_published_wedding_site (next migration), and only
-- while the wedding is explicitly published AND the section is visible.
--
-- Deliberately not a CMS:
--   * a fixed set of kinds, exactly the Constitution's Phase 2 website
--     sections, at most one row per kind per wedding;
--   * plain text only (no HTML, Markdown, JSON blocks, embeds or styles);
--   * the public order is the kinds' canonical order (the enum order), so
--     there is no stored position and no reordering.
--
-- Rows are created on first save (insert or update by kind), never by
-- opening the editor: a wedding without rows has an empty, hidden site.

create type public.content_section_kind as enum (
  'intro',
  'ceremony',
  'reception',
  'schedule',
  'dress_code',
  'faq',
  'rsvp'
);

comment on type public.content_section_kind is
  'The wedding website''s fixed sections, in public display order.';

create table public.content_sections (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  kind public.content_section_kind not null,
  -- Optional heading override; null shows the kind's default heading.
  title text,
  -- Plain text; line breaks (\n only) are kept. Null = nothing written.
  body text,
  -- Whether the section appears on the site WHEN the wedding is published.
  -- Off by default: a section is shown only after someone chooses to.
  is_visible boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One section per kind per wedding.
  constraint content_sections_wedding_kind_key unique (wedding_id, kind),
  -- Stored already normalized: trimmed, never blank (blank = null), at most
  -- 120 characters, no control characters.
  constraint content_sections_title_valid check (
    title is null
    or (
      char_length(title) between 1 and 120
      and title !~ '^[[:space:]]|[[:space:]]$'
      and title !~ '[[:cntrl:]]'
    )
  ),
  -- Trimmed, never blank, at most 5000 characters; line feeds are the only
  -- control character allowed (no \r, tabs or other controls).
  constraint content_sections_body_valid check (
    body is null
    or (
      char_length(body) between 1 and 5000
      and body !~ '^[[:space:]]|[[:space:]]$'
      and replace(body, E'\n', '') !~ '[[:cntrl:]]'
    )
  ),
  -- A visible section must have something to show. The RSVP section is the
  -- exception: without text it shows the product's fixed guidance (use your
  -- personal invitation link), never an RSVP form.
  constraint content_sections_visible_needs_body check (
    not is_visible or body is not null or kind = 'rsvp'
  )
);

comment on table public.content_sections is
  'Private, wedding-owned website content. Public only through get_published_wedding_site while the wedding is published and the section is visible.';
comment on column public.content_sections.is_visible is
  'Shown on the published site. Does not make anything public by itself: the wedding must also be published.';

-- No extra index: the (wedding_id, kind) unique index serves the editor's
-- per-wedding read, the public lookup and the wedding FK cascade.

alter table public.content_sections enable row level security;
revoke all on table public.content_sections from anon, authenticated;

create trigger content_sections_set_updated_at
  before update on public.content_sections
  for each row execute function private.set_updated_at();

-- ------------------------------------------------------ privileges + RLS
--
-- Any member of the wedding. Ids, wedding_id and kind are not updatable:
-- a section never moves between weddings or changes kind. No DELETE: a
-- section is cleared or hidden, never removed (its kind is fixed).

grant select (id, wedding_id, kind, title, body, is_visible, created_at, updated_at)
  on table public.content_sections to authenticated;
grant insert (wedding_id, kind, title, body, is_visible) on table public.content_sections to authenticated;
grant update (title, body, is_visible) on table public.content_sections to authenticated;

create policy content_sections_select_member
  on public.content_sections for select
  to authenticated
  using (private.is_wedding_member(wedding_id));

create policy content_sections_insert_member
  on public.content_sections for insert
  to authenticated
  with check (private.is_wedding_member(wedding_id));

create policy content_sections_update_member
  on public.content_sections for update
  to authenticated
  using (private.is_wedding_member(wedding_id))
  with check (private.is_wedding_member(wedding_id));

-- ------------------------------------------------ save_wedding_site_section

-- Saves one section (title, body, visibility) of a wedding, inserting it the
-- first time and updating it afterwards, keyed by (wedding, kind) — so the
-- browser never needs a section id, and there is never a second row of a
-- kind. SECURITY INVOKER: it runs with the caller's own privileges and RLS,
-- exactly like the equivalent table writes; it only adds the atomic
-- insert-or-update. Values arrive normalized from the server (an empty
-- title or body means "none" and is stored as null); the CHECKs above
-- reject anything else.
create function public.save_wedding_site_section(
  target_wedding_id uuid,
  section_kind public.content_section_kind,
  section_title text,
  section_body text,
  section_visible boolean
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  insert into public.content_sections as s (wedding_id, kind, title, body, is_visible)
  values (
    save_wedding_site_section.target_wedding_id,
    save_wedding_site_section.section_kind,
    nullif(save_wedding_site_section.section_title, ''),
    nullif(save_wedding_site_section.section_body, ''),
    coalesce(save_wedding_site_section.section_visible, false)
  )
  on conflict on constraint content_sections_wedding_kind_key do update
    set title = excluded.title,
        body = excluded.body,
        is_visible = excluded.is_visible;
end;
$$;

comment on function public.save_wedding_site_section(uuid, public.content_section_kind, text, text, boolean) is
  'Inserts or updates one website section of a wedding, as the caller (RLS applies).';

revoke all on function public.save_wedding_site_section(uuid, public.content_section_kind, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.save_wedding_site_section(uuid, public.content_section_kind, text, text, boolean)
  to authenticated;
