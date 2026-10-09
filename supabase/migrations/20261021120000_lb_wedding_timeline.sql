-- LB-23: the wedding day timeline, "Cronograma" (ADR-016; ADR-014 §11).
--
-- One table, public.wedding_timeline_entries: the couple's or planner's run
-- of show for the wedding day — what happens, when, where, who is responsible
-- and which vendor is involved. It is a mutable PLAN, not a calendar, a
-- checklist, a payment schedule or history.
--
-- Timing is wedding-RELATIVE wall-clock data, never a calendar date or an
-- instant:
--   * day_offset 0 = the wedding day, 1 = the following calendar day (the
--     continuation after midnight). Nothing else: LB-23 is not a calendar.
--   * start_time = local wall-clock time, whole minutes; null = "Sin hora".
--   * duration_minutes = optional; the end is derived, never stored.
-- The calendar day comes from the CURRENT weddings.wedding_date, so moving
-- the wedding moves the schedule without rewriting a row; the wedding's time
-- zone only interprets "now" (current/next), never what is displayed.
--
-- Timeline data is PRIVATE organizer data: any member (owner or
-- collaborator) manages it under member RLS; anon has no privileges, and
-- nothing here is reachable from public, RSVP, guest-capability or email
-- functions. No SECURITY DEFINER function, no RPC, no service role, no
-- trigger beyond updated_at.
--
-- Invariants enforced here, not in the app:
--   * plain-text title (1–120), location (1–120), responsible name (1–120)
--     and notes (≤ 4000, multiline): trimmed, no control characters;
--   * day_offset ∈ {0, 1};
--   * start_time in whole minutes, strictly before 24:00;
--   * duration 1–1440 minutes;
--   * a timed entry with a duration ends no later than the end of day 1
--     (the LB-23 window): never clipped, refused;
--   * the vendor, when set, is a vendor of the SAME wedding (composite FK);
--     deleting it only unlinks the entry.
--
-- No execution status, sort order, multi-vendor links, participants,
-- dependencies, checklist/payment links, activity events or public itinerary
-- (ADR-016 §§ "Deliberately not here").

-- Presentation metadata only: a badge, never grouping, authority or order.
create type public.wedding_timeline_phase as enum (
  'getting_ready',
  'setup',
  'ceremony',
  'photos',
  'cocktail',
  'reception',
  'closing'
);

create table public.wedding_timeline_entries (
  id uuid primary key default gen_random_uuid(),
  -- Tenancy boundary. Deleting a wedding deletes its timeline.
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  -- "Ceremonia", "Llega la floristería". Not unique.
  title text not null,
  -- 0 = the wedding day; 1 = the next calendar day (after midnight).
  day_offset smallint not null default 0,
  -- Local wall-clock time; null = time not decided yet ("Sin hora").
  start_time time,
  -- Null = a moment, or a length not known yet. The end is derived.
  duration_minutes smallint,
  phase public.wedding_timeline_phase,
  -- Free text ("Jardín", "Hotel · Suite 405"): no venue entity, no maps.
  location text,
  -- Free text ("Mariana (dama de honor)"): most responsibles aren't members.
  responsible_name text,
  -- Optional; at most one vendor, of this wedding (FK below).
  wedding_vendor_id uuid,
  notes text,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint wedding_timeline_entries_title_valid check (
    char_length(title) between 1 and 120
    and title !~ '^[[:space:]]|[[:space:]]$'
    and title !~ '[[:cntrl:]]'
  ),
  -- The LB-23 scope: the wedding day and its continuation after midnight.
  constraint wedding_timeline_entries_day_offset_valid check (
    day_offset in (0, 1)
  ),
  -- Whole minutes only (no seconds, no fractions) and never 24:00, which
  -- Postgres's time type would otherwise accept.
  constraint wedding_timeline_entries_start_time_valid check (
    start_time is null
    or (start_time < time '24:00' and extract(second from start_time) = 0)
  ),
  constraint wedding_timeline_entries_duration_valid check (
    duration_minutes is null
    or duration_minutes between 1 and 1440
  ),
  -- A timed entry with a duration ends within the timeline window: minute
  -- 0 of the wedding day through minute 2880 (midnight at the end of day 1).
  -- Plain arithmetic, never wrapping `time + interval`.
  constraint wedding_timeline_entries_end_within_window check (
    start_time is null
    or duration_minutes is null
    or day_offset * 1440
       + extract(hour from start_time) * 60
       + extract(minute from start_time)
       + duration_minutes <= 2880
  ),
  constraint wedding_timeline_entries_location_valid check (
    location is null
    or (
      char_length(location) between 1 and 120
      and location !~ '^[[:space:]]|[[:space:]]$'
      and location !~ '[[:cntrl:]]'
    )
  ),
  constraint wedding_timeline_entries_responsible_name_valid check (
    responsible_name is null
    or (
      char_length(responsible_name) between 1 and 120
      and responsible_name !~ '^[[:space:]]|[[:space:]]$'
      and responsible_name !~ '[[:cntrl:]]'
    )
  ),
  -- Trimmed, never blank (blank = null), ≤ 4000 characters; line feeds,
  -- carriage returns and tabs are the only control characters allowed.
  constraint wedding_timeline_entries_notes_valid check (
    notes is null
    or (
      char_length(notes) between 1 and 4000
      and notes !~ '^[[:space:]]|[[:space:]]$'
      and translate(notes, E'\n\r\t', '') !~ '[[:cntrl:]]'
    )
  ),
  -- Same-wedding invariant, enforced relationally (ADR-014 §11): the vendor
  -- is identified by (vendor id, THIS ENTRY'S wedding id), so another
  -- wedding's vendor (or one that doesn't exist) is never a valid reference,
  -- whoever writes it. Null = no vendor (MATCH SIMPLE skips the check).
  -- Deleting the vendor only clears this column: the entry and its
  -- wedding_id stay (the column list keeps wedding_id).
  constraint wedding_timeline_entries_vendor_same_wedding
    foreign key (wedding_vendor_id, wedding_id)
    references public.wedding_vendors (id, wedding_id)
    on delete set null (wedding_vendor_id)
);

comment on table public.wedding_timeline_entries is
  'A wedding''s run of show ("Cronograma"): wedding-relative wall-clock entries. Private organizer data; authority from wedding_memberships only. ADR-016.';
comment on column public.wedding_timeline_entries.day_offset is
  '0 = the wedding day, 1 = the following calendar day (after midnight). The calendar date is derived from the current weddings.wedding_date.';
comment on column public.wedding_timeline_entries.start_time is
  'Local wall-clock time in whole minutes; null = not decided yet. Never an instant.';
comment on column public.wedding_timeline_entries.duration_minutes is
  'Optional length in minutes (1–1440). The end is derived, never stored.';
comment on column public.wedding_timeline_entries.wedding_vendor_id is
  'Optional vendor of this wedding. Deleting the vendor sets only this column to null.';
comment on column public.wedding_timeline_entries.created_by is
  'Provenance only; never used for authorization.';

-- The page reads one wedding's entries in timeline order; also serves the
-- wedding_id FK cascade.
create index wedding_timeline_entries_wedding_time_idx
  on public.wedding_timeline_entries (wedding_id, day_offset, start_time);

-- Serves the vendor's ON DELETE SET NULL lookup.
create index wedding_timeline_entries_vendor_idx
  on public.wedding_timeline_entries (wedding_vendor_id, wedding_id)
  where wedding_vendor_id is not null;

alter table public.wedding_timeline_entries enable row level security;
revoke all on table public.wedding_timeline_entries from anon, authenticated;

create trigger wedding_timeline_entries_set_updated_at
  before update on public.wedding_timeline_entries
  for each row execute function private.set_updated_at();

-- -------------------------------------------- organizer privileges + RLS
--
-- Any member of the wedding (owner or collaborator), identically. Ids, the
-- wedding, provenance and timestamps are not client-writable; entries never
-- move between weddings.

grant select on table public.wedding_timeline_entries to authenticated;
grant insert (
  wedding_id, title, day_offset, start_time, duration_minutes, phase, location,
  responsible_name, wedding_vendor_id, notes
) on table public.wedding_timeline_entries to authenticated;
grant update (
  title, day_offset, start_time, duration_minutes, phase, location,
  responsible_name, wedding_vendor_id, notes
) on table public.wedding_timeline_entries to authenticated;
grant delete on table public.wedding_timeline_entries to authenticated;

create policy wedding_timeline_entries_select_member
  on public.wedding_timeline_entries for select
  to authenticated
  using (private.is_wedding_member(wedding_id));

create policy wedding_timeline_entries_insert_member
  on public.wedding_timeline_entries for insert
  to authenticated
  with check (private.is_wedding_member(wedding_id));

create policy wedding_timeline_entries_update_member
  on public.wedding_timeline_entries for update
  to authenticated
  using (private.is_wedding_member(wedding_id))
  with check (private.is_wedding_member(wedding_id));

create policy wedding_timeline_entries_delete_member
  on public.wedding_timeline_entries for delete
  to authenticated
  using (private.is_wedding_member(wedding_id));
