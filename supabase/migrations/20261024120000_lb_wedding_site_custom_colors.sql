-- Wedding site custom colors (ADR-019 §11, CP7): a wedding may set six
-- semantic colors instead of a palette preset, light mode only.
--
-- Same column, same CHECK, same write path, same public read: the only change
-- is the validator, replaced in place (same signature, so the CHECK and the
-- save function keep calling it). Version 1 gains one optional group:
--
--   "colors": { "background", "surface", "text", "muted", "accent",
--               "accentText" }
--
--   * all six roles, exactly, or no group at all (never a partial palette);
--   * each value exactly '#' + six lowercase hex digits (no 3/4/8-digit hex,
--     uppercase, whitespace, names, functions, var(), url(), gradients);
--   * WCAG AA (4.5:1) for every text/background pair the renderer draws:
--     text and muted on background and surface, accent on background and
--     surface, accentText on accent. Same luminance formula, pairs and
--     threshold as src/lib/wedding-site/design/colors.ts (CONTRAST_PAIRS;
--     a DB test compares the two on many palettes);
--   * never together with a palette preset ("palette" and "colors" are
--     mutually exclusive);
--   * the 1024-byte cap is unchanged and still checked first (the largest
--     valid document is now about 450 bytes).
--
-- Every stored document stays valid: CP6 documents have no "colors" group.
-- No table, column, grant, RPC or projection change; privileges are kept by
-- CREATE OR REPLACE (EXECUTE for authenticated only, because a CHECK runs its
-- function with the writer's privileges; private is not exposed by the Data
-- API).

create or replace function private.wedding_site_customization_is_valid(theme public.wedding_site_theme, doc jsonb)
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
  -- Relative luminance per role, in this order.
  v_roles constant text[] := array['background', 'surface', 'text', 'muted', 'accent', 'accentText'];
  v_luminance float8[] := array[]::float8[];
  v_channel float8;
  v_sum float8;
  v_pair int[];
  v_light float8;
  v_dark float8;
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
    if v_group not in ('palette', 'typography', 'hero', 'layout', 'colors') then
      return false;
    end if;
    if pg_catalog.jsonb_typeof(v_body) <> 'object' or v_body = '{}'::jsonb then
      return false;
    end if;
    if v_group = 'colors' then
      -- Exactly the six roles, each exactly '#' + six lowercase hex digits.
      if (select pg_catalog.array_agg(k order by k collate "C") from pg_catalog.jsonb_object_keys(v_body) as k)
           is distinct from array['accent', 'accentText', 'background', 'muted', 'surface', 'text'] then
        return false;
      end if;
      for v_key, v_value in select f.key, f.value from pg_catalog.jsonb_each(v_body) as f loop
        if pg_catalog.jsonb_typeof(v_value) <> 'string'
           or pg_catalog.octet_length(v_value #>> '{}') <> 7
           or (v_value #>> '{}') !~ '^#[0123456789abcdef]{6}$' then
          return false;
        end if;
        -- WCAG 2.x relative luminance (same formula as colors.ts).
        v_sum := 0;
        for i in 0..2 loop
          v_channel := ('x' || pg_catalog.substr(v_value #>> '{}', 2 + i * 2, 2))::bit(8)::int / 255.0::float8;
          v_channel := case when v_channel <= 0.03928
                            then v_channel / 12.92
                            else pg_catalog.power((v_channel + 0.055) / 1.055, 2.4::float8) end;
          v_sum := v_sum + v_channel * (array[0.2126, 0.7152, 0.0722]::float8[])[i + 1];
        end loop;
        v_luminance[pg_catalog.array_position(v_roles, v_key)] := v_sum;
      end loop;
      -- Every text/background pair the renderer draws (CONTRAST_PAIRS).
      -- (foreground, background) as positions in v_roles: text/background,
      -- muted/background, text/surface, muted/surface, accent/background,
      -- accent/surface, accentText/accent.
      foreach v_pair slice 1 in array array[[3, 1], [4, 1], [3, 2], [4, 2], [5, 1], [5, 2], [6, 5]] loop
        v_light := greatest(v_luminance[v_pair[1]], v_luminance[v_pair[2]]);
        v_dark := least(v_luminance[v_pair[1]], v_luminance[v_pair[2]]);
        if (v_light + 0.05) / (v_dark + 0.05) < 4.5 then
          return false;
        end if;
      end loop;
      continue;
    end if;
    if v_group = 'palette' then
      if (select pg_catalog.array_agg(k order by k collate "C") from pg_catalog.jsonb_object_keys(v_body) as k)
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

  -- A preset and custom colors are mutually exclusive: never both.
  if doc ? 'palette' and doc ? 'colors' then
    return false;
  end if;

  return true;
end;
$$;

comment on function private.wedding_site_customization_is_valid(public.wedding_site_theme, jsonb) is
  'ADR-019 CP6/CP7: whether a customization document (version 1, overrides only, optional custom colors with WCAG AA contrast) is valid for a theme. Mirrors THEME_REGISTRY options and colors.ts.';
