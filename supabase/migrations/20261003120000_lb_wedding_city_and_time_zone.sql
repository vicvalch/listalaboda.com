-- LB-08: optional wedding city and explicit wedding time zone
-- (Constitution §7.2 "optional city", §7.9 "upcoming/overdue", §14.7).
--
--   * weddings.city — human-readable context ("San José"). Plain text, not a
--     venue, address, coordinate or country.
--   * weddings.time_zone — the IANA zone ("America/Costa_Rica") that defines
--     the wedding's local calendar day, so "atrasado" can be derived on read.
--     Never an offset ("-06:00"), never inferred. NULL means "not set": the
--     checklist works exactly as before and nothing is labelled overdue.
--
-- Both are nullable; existing weddings keep NULL. No derived state (overdue,
-- effective dates) is persisted, and checklist statuses do not change.
--
-- Member removal (§7.12) needs no schema change: LB-03 already lets owners
-- delete memberships of their wedding (RLS), keeps the final owner (trigger)
-- and LB-07 unassigns the removed member's items (ON DELETE SET NULL).

alter table public.weddings
  add column city text,
  add column time_zone text;

-- Stored already normalized, like display names: trimmed, never blank (blank
-- means "no city", i.e. null), at most 120 characters, no control characters.
alter table public.weddings
  add constraint weddings_city_valid check (
    city is null
    or (
      char_length(city) between 1 and 120
      and city !~ '^[[:space:]]|[[:space:]]$'
      and city !~ '[[:cntrl:]]'
    )
  );

comment on column public.weddings.city is
  'Optional city of the wedding, plain text. Context only; not a venue or address.';
comment on column public.weddings.time_zone is
  'Optional IANA time zone defining the wedding''s local calendar day. Used only to derive overdue items.';

-- Time-zone validation.
--
-- Not a CHECK constraint: a CHECK must be immutable, but "is this a zone the
-- server knows" is a catalog lookup (pg_timezone_names) whose answer depends
-- on the installed tz database. Hiding that lookup in a function falsely
-- declared immutable could make a later restore or upgrade fail. A trigger
-- validates each write against the live catalog instead, and existing rows
-- are never re-judged.
--
-- The catalog also lists the tz database's `posix/…` and `right/…` copies of
-- every zone and its `Factory` placeholder; those are not zone identifiers a
-- wedding should hold. Offsets ("-06:00", "GMT-6") are not in the catalog.
create function private.validate_wedding_time_zone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.time_zone is not null
     and (
       new.time_zone like 'posix/%'
       or new.time_zone like 'right/%'
       or new.time_zone = 'Factory'
       or not exists (
         select 1 from pg_catalog.pg_timezone_names z where z.name = new.time_zone
       )
     ) then
    raise exception 'invalid_time_zone'
      using errcode = '22023',
            detail = 'time_zone must be an IANA time zone identifier.';
  end if;
  return new;
end;
$$;

revoke all on function private.validate_wedding_time_zone() from public;

create trigger weddings_validate_time_zone
  before insert or update of time_zone on public.weddings
  for each row execute function private.validate_wedding_time_zone();

-- Owners edit city and time zone in wedding settings, like name and date
-- (weddings_update_owner already restricts the row to owners). id,
-- created_by and timestamps stay non-updatable.
grant update (city, time_zone) on table public.weddings to authenticated;

-- ------------------------------------------------------ create_wedding

-- Creation now accepts the optional city and time zone, so a wedding can be
-- created complete. The old two-argument function is dropped rather than
-- overloaded: two create_wedding signatures would make PostgREST's
-- named-argument resolution ambiguous. Same contract as LB-03: SECURITY
-- DEFINER (clients have no INSERT on weddings or memberships), empty
-- search_path, creator is always auth.uid(), and the wedding and its owner
-- membership are written in one transaction, so an invalid city or zone
-- leaves nothing behind.
drop function public.create_wedding(text, date);

create function public.create_wedding(
  wedding_name text,
  wedding_date date default null,
  wedding_city text default null,
  wedding_time_zone text default null
)
returns public.weddings
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_wedding public.weddings;
begin
  if v_user_id is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  insert into public.weddings (created_by, name, wedding_date, city, time_zone)
  values (
    v_user_id,
    btrim(create_wedding.wedding_name),
    create_wedding.wedding_date,
    -- Blank (or only whitespace) means no city. Length and control
    -- characters are checked by weddings_city_valid.
    nullif(
      regexp_replace(coalesce(create_wedding.wedding_city, ''),
                     '^[[:space:]]+|[[:space:]]+$', '', 'g'),
      ''
    ),
    -- Blank means no zone; anything else must be a valid zone (trigger).
    nullif(create_wedding.wedding_time_zone, '')
  )
  returning * into v_wedding;

  insert into public.wedding_memberships (wedding_id, user_id, role)
  values (v_wedding.id, v_user_id, 'owner');

  return v_wedding;
end;
$$;

comment on function public.create_wedding(text, date, text, text) is
  'Creates a wedding (optional date, city, time zone) and makes the caller (auth.uid()) its owner, atomically.';

revoke all on function public.create_wedding(text, date, text, text) from public, anon, authenticated;
grant execute on function public.create_wedding(text, date, text, text) to authenticated;
