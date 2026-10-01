-- LB-03: Wedding — the aggregate root and tenancy boundary (ADR-001 §1–2).
--
-- Authority over a wedding comes only from public.wedding_memberships.
-- `created_by` is provenance, never an authorization input.

-- Internal helpers (RLS helpers, trigger functions) live in `private`, which
-- is not exposed through the Data API, so they are not callable as RPCs.
create schema if not exists private;
revoke all on schema private from public;

-- Reusable updated_at maintenance. Deliberately minimal: no audit/event model.
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.set_updated_at() from public;

create table public.weddings (
  id uuid primary key default gen_random_uuid(),
  -- Provenance only. Kept (set null) if the creator's account is removed so
  -- that co-owners don't lose the wedding.
  created_by uuid references auth.users (id) on delete set null,
  name text not null,
  wedding_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Must contain at least one non-whitespace character. The 200-char cap is
  -- an abuse guard, far above any real couple's wedding name.
  constraint weddings_name_not_blank check (name ~ '[^[:space:]]'),
  constraint weddings_name_length check (char_length(name) <= 200)
);

comment on table public.weddings is
  'Aggregate root and tenancy boundary. Authority comes only from wedding_memberships.';
comment on column public.weddings.created_by is
  'Provenance only; never used for authorization.';

-- RLS on from the first migration. With no policies yet, the table is closed;
-- policies are added in the RLS migration once the helpers exist.
alter table public.weddings enable row level security;

-- Supabase grants every new public table to anon/authenticated by default.
-- Start from nothing; explicit grants are added with the policies.
revoke all on table public.weddings from anon, authenticated;

create trigger weddings_set_updated_at
  before update on public.weddings
  for each row execute function private.set_updated_at();
