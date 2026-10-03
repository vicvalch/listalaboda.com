-- LB-10: explicit publication of the wedding website and its public read
-- boundary (Constitution §10.9 "Nothing is public unless explicitly
-- published. Wedding fields are private by default", §14.8; ADR-002 §7
-- "Public reads go through a dedicated read path (view/function) that
-- returns only published content, never the raw weddings row").
--
-- Publication is its own record, not columns on weddings:
--   * it is the one thing that turns private wedding data public, so it is
--     owner-only as a whole (like replacing a guest link, it changes an
--     external boundary) — while weddings stays exactly as before;
--   * clients get no write privileges on it at all: the slug and the
--     publication state change only through the owner-checked functions
--     below, which also validate (a slug first, something to show) and
--     stamp the database clock;
--   * the public never reads it, weddings or content_sections directly:
--     anon has no table privileges. The only public read path is
--     public.get_published_wedding_site(slug), which returns a fixed, safe
--     projection: the wedding's name, date and city plus its visible
--     sections — and nothing at all unless the wedding is published.
--
-- The slug is a public locator (/boda/<slug>), not a secret: knowing it
-- grants nothing while the site is unpublished, and an unknown slug, an
-- unpublished one and a malformed one all look the same (no rows).

create table public.wedding_publications (
  -- At most one publication per wedding; it can't move between weddings.
  wedding_id uuid primary key references public.weddings (id) on delete cascade,
  -- Lowercase ASCII words joined by single hyphens, 3–80 characters,
  -- globally unique. Chosen by an owner; never derived later from the name.
  slug text not null,
  -- Null = not published (the site doesn't exist publicly). Set by
  -- publish_wedding_site from the database clock; cleared by unpublishing.
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wedding_publications_slug_key unique (slug),
  constraint wedding_publications_slug_format check (
    char_length(slug) between 3 and 80
    and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  -- Words that read as the app's own routes. Mirrored by RESERVED_SLUGS in
  -- src/lib/wedding-site/slug.ts.
  constraint wedding_publications_slug_not_reserved check (
    slug not in ('admin', 'api', 'app', 'auth', 'boda', 'invite', 'login', 'rsvp', 'signup')
  )
);

comment on table public.wedding_publications is
  'Explicit, owner-controlled publication of a wedding''s website: its public slug and whether it is published. Written only through the owner functions.';
comment on column public.wedding_publications.slug is
  'Public locator of the site (/boda/<slug>). Not a secret and not an authorization input.';
comment on column public.wedding_publications.published_at is
  'When the site was (last) published; null = not published. Database clock only.';

-- (slug lookups use the unique constraint's index; wedding_id is the key.)

alter table public.wedding_publications enable row level security;
revoke all on table public.wedding_publications from anon, authenticated;

create trigger wedding_publications_set_updated_at
  before update on public.wedding_publications
  for each row execute function private.set_updated_at();

-- Members (owner or collaborator) see the publication state and address in
-- the editor. No INSERT/UPDATE/DELETE privilege for any client role.
grant select (wedding_id, slug, published_at, created_at, updated_at)
  on table public.wedding_publications to authenticated;

create policy wedding_publications_select_member
  on public.wedding_publications for select
  to authenticated
  using (private.is_wedding_member(wedding_id));

-- ------------------------------------------------- owner-only entry points
--
-- SECURITY DEFINER because clients hold no write privileges on
-- wedding_publications. Every authority decision is made here from
-- auth.uid() and wedding_memberships: a non-member gets the same error as a
-- nonexistent wedding (wedding_not_found); a collaborator gets
-- site_publication_owner_only. No user id, role or timestamp is accepted.

create function private.require_wedding_site_owner(target_wedding_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.is_wedding_member(require_wedding_site_owner.target_wedding_id) then
    raise exception 'wedding_not_found' using errcode = 'P0002';
  end if;
  if not private.has_wedding_role(
    require_wedding_site_owner.target_wedding_id,
    array['owner']::public.wedding_role[]
  ) then
    raise exception 'site_publication_owner_only' using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.require_wedding_site_owner(uuid) from public;

-- Chooses or changes the site's address. Publication state is untouched:
-- changing the slug of a published site moves it at once (the old address
-- stops resolving; there are no redirects). A slug held by another wedding
-- fails with unique_violation, without saying which wedding holds it.
create function public.set_wedding_site_slug(target_wedding_id uuid, new_slug text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_slug text;
begin
  perform private.require_wedding_site_owner(set_wedding_site_slug.target_wedding_id);

  insert into public.wedding_publications as p (wedding_id, slug)
  values (set_wedding_site_slug.target_wedding_id, set_wedding_site_slug.new_slug)
  on conflict (wedding_id) do update set slug = excluded.slug
  returning p.slug into v_slug;

  return v_slug;
end;
$$;

comment on function public.set_wedding_site_slug(uuid, text) is
  'Owner-only: sets the wedding website''s public address. Does not publish.';

-- Publishes the site: from now on get_published_wedding_site(slug) returns
-- it. Requires a chosen address and at least one visible section (a site is
-- never published empty by accident). Publishing an already published site
-- changes nothing. One statement, so there is no half-published state.
create function public.publish_wedding_site(target_wedding_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_published_at timestamptz;
begin
  perform private.require_wedding_site_owner(publish_wedding_site.target_wedding_id);

  -- Row lock: a concurrent address change or unpublish serializes with this.
  perform 1 from public.wedding_publications p
  where p.wedding_id = publish_wedding_site.target_wedding_id
  for update;
  if not found then
    raise exception 'wedding_site_slug_required' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.content_sections s
    where s.wedding_id = publish_wedding_site.target_wedding_id and s.is_visible
  ) then
    raise exception 'wedding_site_empty' using errcode = 'P0001';
  end if;

  update public.wedding_publications p
  set published_at = coalesce(p.published_at, now())
  where p.wedding_id = publish_wedding_site.target_wedding_id
  returning p.published_at into v_published_at;

  return v_published_at;
end;
$$;

comment on function public.publish_wedding_site(uuid) is
  'Owner-only: publishes the wedding website at its chosen address.';

-- Unpublishes: the public address stops resolving immediately. Content,
-- visibility and the chosen address are kept, so publishing again restores
-- the same site at the same address. Unpublishing an unpublished (or
-- never-configured) site changes nothing. Guest links are not affected.
create function public.unpublish_wedding_site(target_wedding_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_wedding_site_owner(unpublish_wedding_site.target_wedding_id);

  update public.wedding_publications p
  set published_at = null
  where p.wedding_id = unpublish_wedding_site.target_wedding_id
    and p.published_at is not null;
end;
$$;

comment on function public.unpublish_wedding_site(uuid) is
  'Owner-only: takes the wedding website offline, keeping its content and address.';

revoke all on function public.set_wedding_site_slug(uuid, text) from public, anon, authenticated;
revoke all on function public.publish_wedding_site(uuid) from public, anon, authenticated;
revoke all on function public.unpublish_wedding_site(uuid) from public, anon, authenticated;
grant execute on function public.set_wedding_site_slug(uuid, text) to authenticated;
grant execute on function public.publish_wedding_site(uuid) to authenticated;
grant execute on function public.unpublish_wedding_site(uuid) to authenticated;

-- ------------------------------------------------ public read boundary

-- The ONLY public read path to wedding data. Looks up exactly one
-- PUBLISHED site by its slug and returns a fixed projection:
--   * the wedding's name, date and city (each row repeats them);
--   * one row per VISIBLE section, in canonical kind order, with its kind,
--     title override and body. A published site with no visible section
--     returns one row with null section fields.
-- Never: wedding id, created_by, time zone, timestamps, members, checklist,
-- guests, RSVPs, hidden sections or anything of an unpublished wedding.
-- Unknown, unpublished and malformed slugs all return no rows.
create function public.get_published_wedding_site(site_slug text)
returns table (
  wedding_name text,
  wedding_date date,
  wedding_city text,
  section_kind public.content_section_kind,
  section_title text,
  section_body text
)
language sql
stable
security definer
set search_path = ''
as $$
  select w.name, w.wedding_date, w.city, s.kind, s.title, s.body
  from public.wedding_publications p
  join public.weddings w on w.id = p.wedding_id
  left join public.content_sections s
    on s.wedding_id = p.wedding_id
   and s.is_visible
   and (s.body is not null or s.kind = 'rsvp')
  where p.slug = get_published_wedding_site.site_slug
    and p.published_at is not null
  order by s.kind;
$$;

comment on function public.get_published_wedding_site(text) is
  'Public read path: a published wedding website by slug (safe wedding fields + visible sections). No rows unless published.';

revoke all on function public.get_published_wedding_site(text) from public, anon, authenticated;
grant execute on function public.get_published_wedding_site(text) to anon, authenticated;

-- ------------------------------------------ published context for guests

-- For a guest RSVP link (by token hash): the slug of its wedding's site, but
-- ONLY while that site is published — the same thing anyone can already
-- reach at /boda/<slug>. Two independent checks: the link must be usable
-- (exactly as in get_guest_invitation: not revoked, not expired), and the
-- wedding must be published. Holding a guest link never reveals anything of
-- an unpublished wedding. Null otherwise; no other field is returned (the
-- RSVP page reads the public fields through get_published_wedding_site).
create function public.get_guest_invitation_site_slug(invitation_token_hash text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.slug
  from public.guest_invitations i
  join public.weddings w on w.id = i.wedding_id
  join public.wedding_publications p on p.wedding_id = i.wedding_id
  where i.token_hash = get_guest_invitation_site_slug.invitation_token_hash
    and i.revoked_at is null
    and now() < private.guest_invitation_expires_at(i.token_issued_at, w.wedding_date)
    and p.published_at is not null;
$$;

comment on function public.get_guest_invitation_site_slug(text) is
  'Guest capability (by token hash): the wedding website slug, only while the link is usable AND the site is published.';

revoke all on function public.get_guest_invitation_site_slug(text) from public, anon, authenticated;
grant execute on function public.get_guest_invitation_site_slug(text) to anon, authenticated;
