-- LB-05: checklist templates — global, versioned REFERENCE data
-- (Constitution §5, ADR-001 §5). Not wedding-owned tenant data.
--
-- A template is identified by (key, version). A version, once shipped, is
-- treated as immutable: content changes ship as a new version row, so a
-- wedding's recorded provenance always names exactly what it was seeded from.
--
-- Applying a template COPIES its items into the wedding (see
-- public.initialize_wedding_checklist). There is no live link: later template
-- changes never touch existing weddings' checklist items.
--
-- Clients get no privileges on these tables. The application never reads
-- templates directly; the initialization RPC reads them as the function owner.

-- Fixed, curated category set (Constitution §5: custom categories are Phase 3).
-- Labels are Spanish UI copy in the message catalog; these are stable keys.
create type public.checklist_category as enum (
  'first_steps',
  'venue_and_date',
  'vendors',
  'attire',
  'invitations',
  'ceremony',
  'reception',
  'final_preparations',
  'after_wedding'
);

-- How an item's due date is defined:
--   none                 no date
--   relative_to_wedding  relative_days from the wedding date (negative = before)
--   absolute             a fixed calendar date (due_date)
create type public.checklist_timing_mode as enum (
  'none',
  'relative_to_wedding',
  'absolute'
);

-- Closed lifecycle (Constitution §4). No in_progress/blocked/approval states.
create type public.checklist_item_status as enum (
  'pending',
  'done',
  'not_applicable'
);

create table public.checklist_templates (
  id uuid primary key default gen_random_uuid(),
  -- Machine identity, e.g. 'default-wedding-es'. Together with version it
  -- names one immutable release of the template.
  key text not null,
  version integer not null,
  locale text not null,
  name text not null,
  description text,
  -- Only active templates can be applied to a wedding.
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint checklist_templates_key_version_key unique (key, version),
  constraint checklist_templates_key_format check (key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint checklist_templates_version_positive check (version > 0),
  constraint checklist_templates_locale_format check (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  constraint checklist_templates_name_not_blank check (name ~ '[^[:space:]]')
);

comment on table public.checklist_templates is
  'Global, versioned reference data. Applying a template copies its items into a wedding; never a live link.';

alter table public.checklist_templates enable row level security;
revoke all on table public.checklist_templates from anon, authenticated;

create trigger checklist_templates_set_updated_at
  before update on public.checklist_templates
  for each row execute function private.set_updated_at();

create table public.checklist_template_items (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.checklist_templates (id) on delete cascade,
  -- Machine identity within the template (e.g. 'venue.reception_book'),
  -- independent of the Spanish title, which may change between versions.
  stable_key text not null,
  title text not null,
  description text,
  category public.checklist_category not null,
  sort_order integer not null,
  -- Templates can't know a wedding's calendar, so only 'none' or
  -- 'relative_to_wedding' make sense here (no absolute dates).
  timing_mode public.checklist_timing_mode not null default 'none',
  relative_days integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Also serves the template_id FK and "items of a template" lookups.
  constraint checklist_template_items_template_key_key unique (template_id, stable_key),
  constraint checklist_template_items_template_sort_key unique (template_id, sort_order),
  constraint checklist_template_items_sort_order_positive check (sort_order > 0),
  constraint checklist_template_items_stable_key_format
    check (stable_key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'),
  constraint checklist_template_items_title_not_blank check (title ~ '[^[:space:]]'),
  constraint checklist_template_items_title_length check (char_length(title) <= 200),
  constraint checklist_template_items_description_length
    check (description is null or char_length(description) <= 2000),
  constraint checklist_template_items_timing check (
    (timing_mode = 'none' and relative_days is null)
    or (timing_mode = 'relative_to_wedding' and relative_days is not null)
  ),
  constraint checklist_template_items_relative_days_range
    check (relative_days is null or relative_days between -1000 and 1000)
);

comment on table public.checklist_template_items is
  'Suggested items of one template version. Copied into checklist_items on application.';
comment on column public.checklist_template_items.relative_days is
  'Days from the wedding date: negative = before, 0 = wedding day, positive = after.';

alter table public.checklist_template_items enable row level security;
revoke all on table public.checklist_template_items from anon, authenticated;

create trigger checklist_template_items_set_updated_at
  before update on public.checklist_template_items
  for each row execute function private.set_updated_at();
