-- Wedding site customization (ADR-019 §10, CP6): safe, closed choices on top
-- of the chosen curated theme.
--
-- Still presentation only, still the design authority (never content or
-- publication):
--   * one more column, wedding_site_designs.customization: a versioned JSON
--     document holding ONLY the wedding's overrides among the options its
--     theme offers (palette preset, type pairing, heading scale, hero,
--     width, density, alignment, section style). Never resolved values,
--     colors, CSS, class names, fonts, URLs, text or wedding data. '{}' = no
--     overrides (every existing row, no backfill needed);
--   * a CHECK through private.wedding_site_customization_is_valid: the
--     database refuses any document the application would refuse, for every
--     writer. The per-theme option lists mirror THEME_REGISTRY in
--     src/lib/wedding-site/design/themes.ts (tests compare the two value by
--     value);
--   * save_wedding_site_design takes the theme AND the customization: the one
--     write path for both (the 2-argument form is replaced, not kept);
--   * get_published_wedding_site returns the customization next to the theme,
--     under the unchanged publication gate.

-- ------------------------------------------------------------- validator

-- Whether a customization document is valid for a theme. Pure (immutable):
-- reads only its arguments. Rules (version 1):
--   * a JSON object of at most 1024 bytes of JSON text (the largest valid
--     document is about 300 bytes; the cap is checked before anything else);
--   * '{}' (no overrides), or schemaVersion exactly 1 plus only the groups
--     palette, typography, hero, layout;
--   * each group a non-empty object with only its own keys:
--       palette    {kind: "preset", key}          (both, exactly)
--       typography {pairing?, headingScale?}
--       hero       {variant}
--       layout     {width?, density?, alignment?, sectionStyle?}
--   * every value a string from THE THEME'S option list for that field.
-- Anything else (arrays, strings or null where an object belongs, numbers,
-- unknown keys, hex colors, CSS, url(...), markup) is invalid.
--
-- Executable by authenticated only because a CHECK runs its function with
-- the writer's privileges (members write through the SECURITY INVOKER save
-- function). The private schema is not exposed by the Data API, so no client
-- can call it as an RPC; anon has no privilege at all.
create function private.wedding_site_customization_is_valid(theme public.wedding_site_theme, doc jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  -- The theme's options per "group.key" (mirrors ThemeDefinition.options).
  v_choices jsonb := case wedding_site_customization_is_valid.theme
    when 'classic' then '{
      "palette.key": ["app", "warm", "slate"],
      "typography.pairing": ["system", "serif", "mixed"],
      "typography.headingScale": ["regular", "display"],
      "hero.variant": ["simple", "editorial"],
      "layout.width": ["regular", "narrow", "wide"],
      "layout.density": ["regular", "compact", "airy"],
      "layout.alignment": ["center", "start"],
      "layout.sectionStyle": ["plain", "editorial", "ruled"]
    }'::jsonb
    when 'editorial' then '{
      "palette.key": ["ivory", "parchment", "charcoal"],
      "typography.pairing": ["serif", "italic", "mixed"],
      "typography.headingScale": ["display", "regular"],
      "hero.variant": ["editorial", "simple", "framed"],
      "layout.width": ["narrow", "regular"],
      "layout.density": ["airy", "regular"],
      "layout.alignment": ["center", "start"],
      "layout.sectionStyle": ["editorial", "plain"]
    }'::jsonb
    when 'minimal' then '{
      "palette.key": ["mono", "stone", "ink"],
      "typography.pairing": ["sans", "serif", "mixed"],
      "typography.headingScale": ["compact", "regular"],
      "hero.variant": ["grid", "simple"],
      "layout.width": ["wide", "regular"],
      "layout.density": ["compact", "regular"],
      "layout.alignment": ["start"],
      "layout.sectionStyle": ["ruled", "plain"]
    }'::jsonb
    when 'romantic' then '{
      "palette.key": ["rose", "wine", "champagne"],
      "typography.pairing": ["italic", "serif", "mixed"],
      "typography.headingScale": ["display", "regular"],
      "hero.variant": ["framed", "editorial", "simple"],
      "layout.width": ["regular", "narrow"],
      "layout.density": ["airy", "regular"],
      "layout.alignment": ["center"],
      "layout.sectionStyle": ["centered", "editorial", "plain"]
    }'::jsonb
    when 'tropical' then '{
      "palette.key": ["sand", "forest", "sunset"],
      "typography.pairing": ["mixed", "serif", "sans"],
      "typography.headingScale": ["display", "regular"],
      "hero.variant": ["banner", "editorial", "simple"],
      "layout.width": ["regular", "narrow", "wide"],
      "layout.density": ["compact", "regular", "airy"],
      "layout.alignment": ["start", "center"],
      "layout.sectionStyle": ["tiles", "editorial", "plain"]
    }'::jsonb
  end;
  v_group text;
  v_body jsonb;
  v_key text;
  v_value jsonb;
  v_allowed jsonb;
begin
  if theme is null or doc is null or v_choices is null then
    return false;
  end if;
  if pg_catalog.jsonb_typeof(doc) <> 'object' then
    return false;
  end if;
  if pg_catalog.octet_length(doc::text) > 1024 then
    return false;
  end if;
  if doc = '{}'::jsonb then
    return true;
  end if;
  if (doc -> 'schemaVersion') is distinct from '1'::jsonb then
    return false;
  end if;

  for v_group, v_body in select e.key, e.value from pg_catalog.jsonb_each(doc) as e loop
    continue when v_group = 'schemaVersion';
    if v_group not in ('palette', 'typography', 'hero', 'layout') then
      return false;
    end if;
    if pg_catalog.jsonb_typeof(v_body) <> 'object' or v_body = '{}'::jsonb then
      return false;
    end if;
    if v_group = 'palette' then
      if (select pg_catalog.array_agg(k order by k) from pg_catalog.jsonb_object_keys(v_body) as k)
           is distinct from array['key', 'kind']
         or (v_body -> 'kind') is distinct from '"preset"'::jsonb then
        return false;
      end if;
    end if;
    for v_key, v_value in select f.key, f.value from pg_catalog.jsonb_each(v_body) as f loop
      continue when v_group = 'palette' and v_key = 'kind';
      v_allowed := v_choices -> (v_group || '.' || v_key);
      if v_allowed is null
         or pg_catalog.jsonb_typeof(v_value) <> 'string'
         or not (v_allowed ? (v_value #>> '{}')) then
        return false;
      end if;
    end loop;
  end loop;

  return true;
end;
$$;

comment on function private.wedding_site_customization_is_valid(public.wedding_site_theme, jsonb) is
  'ADR-019 CP6: whether a customization document (version 1, overrides only) is valid for a theme. Mirrors THEME_REGISTRY options.';

revoke all on function private.wedding_site_customization_is_valid(public.wedding_site_theme, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function private.wedding_site_customization_is_valid(public.wedding_site_theme, jsonb)
  to authenticated;

-- ------------------------------------------------------------- the column

alter table public.wedding_site_designs
  add column customization jsonb not null default '{}'::jsonb,
  add constraint wedding_site_designs_customization_valid
    check (private.wedding_site_customization_is_valid(theme_key, customization));

comment on column public.wedding_site_designs.customization is
  'ADR-019 CP6: the overrides chosen among the theme''s closed options, as a versioned document ({} = none). Never resolved values or free-form data.';

-- Members read and write it like the theme (RLS unchanged). The CHECK holds
-- for every write, including a direct theme change: a theme that doesn't
-- allow a stored override is refused until the customization is normalized.
grant select (customization) on table public.wedding_site_designs to authenticated;
grant insert (customization) on table public.wedding_site_designs to authenticated;
grant update (customization) on table public.wedding_site_designs to authenticated;

-- ------------------------------------------------ save_wedding_site_design

-- Replaced: the theme and its customization are saved together, so a saved
-- pair is always valid (the application normalizes the customization when
-- the theme changes; the CHECK refuses anything else). Same rules as CP4:
-- SECURITY INVOKER (the caller's privileges and RLS), any member, never
-- touches content or publication. Returns the saved theme.
drop function public.save_wedding_site_design(uuid, public.wedding_site_theme);

create function public.save_wedding_site_design(
  target_wedding_id uuid,
  new_theme public.wedding_site_theme,
  new_customization jsonb
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
  if not coalesce(
    private.wedding_site_customization_is_valid(
      save_wedding_site_design.new_theme,
      save_wedding_site_design.new_customization
    ),
    false
  ) then
    raise exception 'wedding_site_customization_invalid' using errcode = '22023';
  end if;

  insert into public.wedding_site_designs as d (wedding_id, theme_key, customization)
  values (
    save_wedding_site_design.target_wedding_id,
    save_wedding_site_design.new_theme,
    save_wedding_site_design.new_customization
  )
  on conflict (wedding_id) do update
    set theme_key = excluded.theme_key,
        customization = excluded.customization
  returning d.theme_key into v_theme;

  return v_theme;
end;
$$;

comment on function public.save_wedding_site_design(uuid, public.wedding_site_theme, jsonb) is
  'Inserts or updates the website theme and its customization of a wedding, as the caller (any member; RLS applies).';

revoke all on function public.save_wedding_site_design(uuid, public.wedding_site_theme, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_wedding_site_design(uuid, public.wedding_site_theme, jsonb)
  to authenticated;

-- ------------------------------------------------ public read boundary

-- Same function, same gate, same rows, plus one column: site_customization,
-- the stored overrides document ('{}' when there is no design row). Closed
-- presentation keys only, already checked by the CHECK; the application
-- re-reads it before rendering anyway. Dropped and recreated (its return
-- type changes) with the original privileges; everything else is exactly
-- the CP4 function.
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
  site_customization jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select w.name, w.wedding_date, w.city, s.kind, s.title, s.body,
         coalesce(d.theme_key, 'classic'::public.wedding_site_theme),
         coalesce(d.customization, '{}'::jsonb)
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
  'Public read path: a published wedding website by slug (safe wedding fields + visible sections + theme key + customization). No rows unless published.';

revoke all on function public.get_published_wedding_site(text) from public, anon, authenticated;
grant execute on function public.get_published_wedding_site(text) to anon, authenticated;
