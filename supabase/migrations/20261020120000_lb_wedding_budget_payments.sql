-- LB-22: wedding budget and vendor payments (ADR-015; ADR-014 §11; ADR-001 §2, §7).
--
-- Four tables and one guard on wedding_vendors. The authority model:
--
--   * budget estimate = planning intent: an optional wedding total per
--     currency (wedding_budget_totals) and optional per-category estimates
--     per currency (wedding_budget_allocations, reusing the vendor category
--     enum; `other` is one shared bucket);
--   * committed = a booked WeddingVendor's contracted amount. It stays on
--     wedding_vendors.contracted_amount_minor + currency (LB-21); there is
--     no second committed column anywhere;
--   * obligation = a scheduled part of one vendor's contract
--     (vendor_payment_schedule_items: label, amount, due date);
--   * payment = money actually paid to one vendor (vendor_payments),
--     optionally applied to exactly one of that vendor's schedule items.
--
-- Accounting is out of scope: no ledger, journal, invoice, receipt, tax,
-- reconciliation, payment method or reversal rows. Payments are editable and
-- hard-deletable. Every financial status (pending, partial, paid, overdue,
-- due soon) is DERIVED on read and never stored.
--
-- Child financial rows carry NO currency: it is the vendor's currency, which
-- is locked while any schedule item or payment exists. CRC and USD are never
-- added together or converted.
--
-- Invariants enforced here, under the parent vendor's row lock (FOR UPDATE),
-- never in the application:
--   * a schedule item or payment needs a contracted amount (and currency);
--   * Σ schedule items + Σ unlinked payments ≤ contracted amount;
--   * Σ payments linked to an item ≤ that item's amount (a payment applies to
--     at most one item; an item may have many payments: partial payments);
--   * an item can't drop below what is already paid against it;
--   * with any financial child, the vendor's currency can't change, its
--     contracted amount can't become null nor drop below the recorded floor
--     (Σ items + Σ unlinked payments). Quote and status are untouched.
--
-- Deletion: a vendor with financial children can't be deleted, and an item
-- with payments can't be deleted (NO ACTION foreign keys, never CASCADE).
-- NO ACTION rather than RESTRICT on purpose: the check runs at the end of the
-- statement, so deleting a WEDDING still cascades its vendors, items and
-- payments together (each child also references the wedding directly).
--
-- Private organizer data: any member (owner or collaborator) manages it under
-- member RLS; anon has no privileges; no SECURITY DEFINER, RPC or service
-- role; nothing here is reachable from public, RSVP, guest or email paths.
-- No activity events, checklist links, reminders or storage. No backfill.

-- ------------------------------------------------------ wedding_budget_totals

create table public.wedding_budget_totals (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  currency text not null,
  -- Integer minor units; the LB-21 money range. 0 is a valid estimate.
  amount_minor bigint not null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wedding_budget_totals_currency_valid check (currency in ('CRC', 'USD')),
  constraint wedding_budget_totals_amount_range check (amount_minor between 0 and 99999999999999),
  -- One estimate per wedding and currency; also serves reads and the cascade.
  constraint wedding_budget_totals_wedding_currency_key unique (wedding_id, currency)
);

comment on table public.wedding_budget_totals is
  'Optional total budget estimate of a wedding, one per currency. Planning intent only. ADR-015.';
comment on column public.wedding_budget_totals.created_by is
  'Provenance only; never used for authorization.';

alter table public.wedding_budget_totals enable row level security;
revoke all on table public.wedding_budget_totals from anon, authenticated;

create trigger wedding_budget_totals_set_updated_at
  before update on public.wedding_budget_totals
  for each row execute function private.set_updated_at();

-- ------------------------------------------------- wedding_budget_allocations

create table public.wedding_budget_allocations (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  -- The vendor categories; `other` is ONE bucket for every custom vendor type.
  category public.wedding_vendor_category not null,
  currency text not null,
  amount_minor bigint not null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wedding_budget_allocations_currency_valid check (currency in ('CRC', 'USD')),
  constraint wedding_budget_allocations_amount_range check (amount_minor between 0 and 99999999999999),
  constraint wedding_budget_allocations_wedding_category_currency_key unique (wedding_id, category, currency)
);

comment on table public.wedding_budget_allocations is
  'Optional budget estimate per wedding, vendor category and currency. Never required to sum to the total. ADR-015.';
comment on column public.wedding_budget_allocations.created_by is
  'Provenance only; never used for authorization.';

alter table public.wedding_budget_allocations enable row level security;
revoke all on table public.wedding_budget_allocations from anon, authenticated;

create trigger wedding_budget_allocations_set_updated_at
  before update on public.wedding_budget_allocations
  for each row execute function private.set_updated_at();

-- ---------------------------------------------- vendor_payment_schedule_items

create table public.vendor_payment_schedule_items (
  id uuid primary key default gen_random_uuid(),
  -- Tenancy boundary. Deleting a wedding deletes its schedule items directly
  -- (the vendor reference below is NO ACTION).
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  wedding_vendor_id uuid not null,
  -- "Depósito", "Segundo pago". Not unique.
  label text not null,
  -- In the vendor's currency (no currency column here).
  amount_minor bigint not null,
  -- A calendar date; timing (overdue, due soon) is derived in the wedding's zone.
  due_on date not null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vendor_payment_schedule_items_label_valid check (
    char_length(label) between 1 and 80
    and label !~ '^[[:space:]]|[[:space:]]$'
    and label !~ '[[:cntrl:]]'
  ),
  constraint vendor_payment_schedule_items_amount_range check (amount_minor between 1 and 99999999999999),
  -- Same-wedding vendor. NO ACTION: a vendor with a schedule can't be deleted.
  constraint vendor_payment_schedule_items_vendor_same_wedding
    foreign key (wedding_vendor_id, wedding_id)
    references public.wedding_vendors (id, wedding_id)
    on delete no action,
  -- Target of the payments' same-vendor, same-wedding item reference.
  constraint vendor_payment_schedule_items_id_vendor_wedding_key unique (id, wedding_vendor_id, wedding_id)
);

comment on table public.vendor_payment_schedule_items is
  'A scheduled part of one vendor''s contract (label, amount, due date). Status is derived, never stored. ADR-015.';
comment on column public.vendor_payment_schedule_items.amount_minor is
  'Integer minor units of the VENDOR''s currency (wedding_vendors.currency, locked while children exist).';
comment on column public.vendor_payment_schedule_items.created_by is
  'Provenance only; never used for authorization.';

-- Per-vendor sums and the vendor FK; the wedding's schedule by due date.
create index vendor_payment_schedule_items_vendor_idx
  on public.vendor_payment_schedule_items (wedding_vendor_id);
create index vendor_payment_schedule_items_wedding_due_idx
  on public.vendor_payment_schedule_items (wedding_id, due_on);

alter table public.vendor_payment_schedule_items enable row level security;
revoke all on table public.vendor_payment_schedule_items from anon, authenticated;

create trigger vendor_payment_schedule_items_set_updated_at
  before update on public.vendor_payment_schedule_items
  for each row execute function private.set_updated_at();

-- ------------------------------------------------------------ vendor_payments

create table public.vendor_payments (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  wedding_vendor_id uuid not null,
  -- Optional: the ONE schedule item this payment applies to. Null = "Sin cuota".
  schedule_item_id uuid,
  amount_minor bigint not null,
  paid_on date not null,
  -- One optional line: "SINPE #8842", "Transferencia BAC", "Efectivo".
  note text,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vendor_payments_amount_range check (amount_minor between 1 and 99999999999999),
  -- Single line: no control characters at all (no line breaks or tabs).
  constraint vendor_payments_note_valid check (
    note is null
    or (
      char_length(note) between 1 and 500
      and note !~ '^[[:space:]]|[[:space:]]$'
      and note !~ '[[:cntrl:]]'
    )
  ),
  constraint vendor_payments_vendor_same_wedding
    foreign key (wedding_vendor_id, wedding_id)
    references public.wedding_vendors (id, wedding_id)
    on delete no action,
  -- MATCH SIMPLE (the default): a null schedule_item_id skips the check; a
  -- non-null one must be an item of THIS vendor in THIS wedding. NO ACTION:
  -- an item with payments can't be deleted (never silently unallocated).
  constraint vendor_payments_schedule_item_same_vendor
    foreign key (schedule_item_id, wedding_vendor_id, wedding_id)
    references public.vendor_payment_schedule_items (id, wedding_vendor_id, wedding_id)
    on delete no action
);

comment on table public.vendor_payments is
  'Money actually paid to one vendor, optionally applied to one of its schedule items. Editable, hard-deletable; not a ledger. ADR-015.';
comment on column public.vendor_payments.amount_minor is
  'Integer minor units of the VENDOR''s currency (wedding_vendors.currency, locked while children exist).';
comment on column public.vendor_payments.created_by is
  'Provenance only; never used for authorization.';

create index vendor_payments_vendor_idx
  on public.vendor_payments (wedding_vendor_id);
create index vendor_payments_schedule_item_idx
  on public.vendor_payments (schedule_item_id)
  where schedule_item_id is not null;

alter table public.vendor_payments enable row level security;
revoke all on table public.vendor_payments from anon, authenticated;

create trigger vendor_payments_set_updated_at
  before update on public.vendor_payments
  for each row execute function private.set_updated_at();

-- ------------------------------------------------------- financial invariants
--
-- Every financial write that can move a sum first locks the parent vendor row
-- (FOR UPDATE) and only then computes the sums: the lock serializes every
-- schedule/payment write of that vendor and every change of its contract or
-- currency, so two transactions can never both take the last room (the
-- second waits, then sums again with the first one committed; each statement
-- in a READ COMMITTED transaction reads a fresh snapshot).
--
-- SECURITY INVOKER on purpose (the LB-19 precedent): they run as the caller,
-- under RLS. A member sees every vendor, item and payment of their own
-- wedding — exactly the target's wedding (same-wedding FKs) — so the sums are
-- complete; the lock needs the member's UPDATE privilege and policy on
-- wedding_vendors, which every member has. A non-member sees no vendor
-- (nothing to lock) and is refused by RLS right after. Privileged roles
-- bypass RLS and see everything.

create function private.enforce_vendor_payment_schedule_item()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_contract bigint;
  v_currency text;
  v_scheduled numeric;
  v_unlinked numeric;
  v_paid numeric;
begin
  if tg_op = 'UPDATE'
     and new.amount_minor is not distinct from old.amount_minor
     and new.wedding_vendor_id is not distinct from old.wedding_vendor_id
     and new.wedding_id is not distinct from old.wedding_id then
    return new;
  end if;

  select v.contracted_amount_minor, v.currency
    into v_contract, v_currency
  from public.wedding_vendors v
  where v.id = new.wedding_vendor_id
    and v.wedding_id = new.wedding_id
  for update;

  if not found then
    -- Not a vendor of this wedding (or not visible): the same-wedding
    -- foreign key (or RLS) refuses it.
    return new;
  end if;

  if v_contract is null or v_currency is null then
    raise exception 'vendor_contract_required'
      using errcode = '23514',
            detail = 'Enter the contracted amount before scheduling payments.';
  end if;

  if tg_op = 'UPDATE' then
    select coalesce(sum(p.amount_minor), 0)
      into v_paid
    from public.vendor_payments p
    where p.schedule_item_id = new.id;

    if v_paid > new.amount_minor then
      raise exception 'vendor_schedule_item_below_paid'
        using errcode = '23514',
              detail = 'The item can''t be less than what is already paid against it.';
    end if;
  end if;

  select coalesce(sum(s.amount_minor), 0)
    into v_scheduled
  from public.vendor_payment_schedule_items s
  where s.wedding_vendor_id = new.wedding_vendor_id
    and s.id <> new.id;

  select coalesce(sum(p.amount_minor), 0)
    into v_unlinked
  from public.vendor_payments p
  where p.wedding_vendor_id = new.wedding_vendor_id
    and p.schedule_item_id is null;

  if v_scheduled + new.amount_minor + v_unlinked > v_contract then
    raise exception 'vendor_schedule_exceeds_contract'
      using errcode = '23514',
            detail = 'Scheduled items plus unallocated payments would exceed the contracted amount.';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_vendor_payment_schedule_item() from public;

create trigger vendor_payment_schedule_items_enforce
  before insert or update of amount_minor, wedding_vendor_id, wedding_id
  on public.vendor_payment_schedule_items
  for each row execute function private.enforce_vendor_payment_schedule_item();

-- A payment's proposed state is checked with the payment itself excluded from
-- the sums, so moving it between items or to/from "Sin cuota" is evaluated
-- atomically: only the destination can tighten (leaving an item or the
-- unallocated room only frees space).
create function private.enforce_vendor_payment()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_contract bigint;
  v_currency text;
  v_item_amount bigint;
  v_linked numeric;
  v_scheduled numeric;
  v_unlinked numeric;
begin
  if tg_op = 'UPDATE'
     and new.amount_minor is not distinct from old.amount_minor
     and new.schedule_item_id is not distinct from old.schedule_item_id
     and new.wedding_vendor_id is not distinct from old.wedding_vendor_id
     and new.wedding_id is not distinct from old.wedding_id then
    return new;
  end if;

  select v.contracted_amount_minor, v.currency
    into v_contract, v_currency
  from public.wedding_vendors v
  where v.id = new.wedding_vendor_id
    and v.wedding_id = new.wedding_id
  for update;

  if not found then
    return new;
  end if;

  if v_contract is null or v_currency is null then
    raise exception 'vendor_contract_required'
      using errcode = '23514',
            detail = 'Enter the contracted amount before recording payments.';
  end if;

  if new.schedule_item_id is not null then
    select s.amount_minor
      into v_item_amount
    from public.vendor_payment_schedule_items s
    where s.id = new.schedule_item_id
      and s.wedding_vendor_id = new.wedding_vendor_id
      and s.wedding_id = new.wedding_id;

    if not found then
      -- Another vendor's (or wedding's) item: the composite FK refuses it.
      return new;
    end if;

    select coalesce(sum(p.amount_minor), 0)
      into v_linked
    from public.vendor_payments p
    where p.schedule_item_id = new.schedule_item_id
      and p.id <> new.id;

    if v_linked + new.amount_minor > v_item_amount then
      raise exception 'vendor_payment_exceeds_schedule_item'
        using errcode = '23514',
              detail = 'Payments applied to the item would exceed its amount.';
    end if;
  else
    select coalesce(sum(s.amount_minor), 0)
      into v_scheduled
    from public.vendor_payment_schedule_items s
    where s.wedding_vendor_id = new.wedding_vendor_id;

    select coalesce(sum(p.amount_minor), 0)
      into v_unlinked
    from public.vendor_payments p
    where p.wedding_vendor_id = new.wedding_vendor_id
      and p.schedule_item_id is null
      and p.id <> new.id;

    if v_scheduled + v_unlinked + new.amount_minor > v_contract then
      raise exception 'vendor_payment_exceeds_unscheduled'
        using errcode = '23514',
              detail = 'The payment exceeds the contracted amount not yet scheduled.';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_vendor_payment() from public;

create trigger vendor_payments_enforce
  before insert or update of amount_minor, schedule_item_id, wedding_vendor_id, wedding_id
  on public.vendor_payments
  for each row execute function private.enforce_vendor_payment();

-- The vendor side. The UPDATE already holds the vendor row lock, so these
-- sums are serialized with every schedule/payment write of the vendor.
-- Quote and status are never constrained by finance records.
create function private.enforce_wedding_vendor_finance()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_floor numeric;
begin
  if new.currency is not distinct from old.currency
     and new.contracted_amount_minor is not distinct from old.contracted_amount_minor then
    return new;
  end if;

  if not exists (select 1 from public.vendor_payment_schedule_items s where s.wedding_vendor_id = old.id)
     and not exists (select 1 from public.vendor_payments p where p.wedding_vendor_id = old.id) then
    return new;
  end if;

  if new.currency is distinct from old.currency then
    raise exception 'vendor_currency_locked'
      using errcode = '23514',
            detail = 'The vendor has payments or schedule items in its currency.';
  end if;

  if new.contracted_amount_minor is null then
    raise exception 'vendor_contract_required'
      using errcode = '23514',
            detail = 'The vendor has payments or schedule items: the contracted amount is required.';
  end if;

  select
    (select coalesce(sum(s.amount_minor), 0)
     from public.vendor_payment_schedule_items s
     where s.wedding_vendor_id = old.id)
    + (select coalesce(sum(p.amount_minor), 0)
       from public.vendor_payments p
       where p.wedding_vendor_id = old.id
         and p.schedule_item_id is null)
    into v_floor;

  if new.contracted_amount_minor < v_floor then
    raise exception 'vendor_contract_below_recorded'
      using errcode = '23514',
            detail = 'The contracted amount can''t be less than what is scheduled or paid.';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_wedding_vendor_finance() from public;

create trigger wedding_vendors_enforce_finance
  before update of currency, contracted_amount_minor on public.wedding_vendors
  for each row execute function private.enforce_wedding_vendor_finance();

-- -------------------------------------------- organizer privileges + RLS
--
-- Any member of the wedding (owner or collaborator), identically. Ids, the
-- wedding, the parent vendor, provenance and timestamps are not
-- client-writable after insert; rows never move between weddings or vendors.

grant select on table public.wedding_budget_totals to authenticated;
grant insert (wedding_id, currency, amount_minor) on table public.wedding_budget_totals to authenticated;
grant update (amount_minor) on table public.wedding_budget_totals to authenticated;
grant delete on table public.wedding_budget_totals to authenticated;

create policy wedding_budget_totals_select_member
  on public.wedding_budget_totals for select
  to authenticated
  using (private.is_wedding_member(wedding_id));

create policy wedding_budget_totals_insert_member
  on public.wedding_budget_totals for insert
  to authenticated
  with check (private.is_wedding_member(wedding_id));

create policy wedding_budget_totals_update_member
  on public.wedding_budget_totals for update
  to authenticated
  using (private.is_wedding_member(wedding_id))
  with check (private.is_wedding_member(wedding_id));

create policy wedding_budget_totals_delete_member
  on public.wedding_budget_totals for delete
  to authenticated
  using (private.is_wedding_member(wedding_id));

grant select on table public.wedding_budget_allocations to authenticated;
grant insert (wedding_id, category, currency, amount_minor) on table public.wedding_budget_allocations to authenticated;
grant update (amount_minor) on table public.wedding_budget_allocations to authenticated;
grant delete on table public.wedding_budget_allocations to authenticated;

create policy wedding_budget_allocations_select_member
  on public.wedding_budget_allocations for select
  to authenticated
  using (private.is_wedding_member(wedding_id));

create policy wedding_budget_allocations_insert_member
  on public.wedding_budget_allocations for insert
  to authenticated
  with check (private.is_wedding_member(wedding_id));

create policy wedding_budget_allocations_update_member
  on public.wedding_budget_allocations for update
  to authenticated
  using (private.is_wedding_member(wedding_id))
  with check (private.is_wedding_member(wedding_id));

create policy wedding_budget_allocations_delete_member
  on public.wedding_budget_allocations for delete
  to authenticated
  using (private.is_wedding_member(wedding_id));

grant select on table public.vendor_payment_schedule_items to authenticated;
grant insert (wedding_id, wedding_vendor_id, label, amount_minor, due_on)
  on table public.vendor_payment_schedule_items to authenticated;
grant update (label, amount_minor, due_on) on table public.vendor_payment_schedule_items to authenticated;
grant delete on table public.vendor_payment_schedule_items to authenticated;

create policy vendor_payment_schedule_items_select_member
  on public.vendor_payment_schedule_items for select
  to authenticated
  using (private.is_wedding_member(wedding_id));

create policy vendor_payment_schedule_items_insert_member
  on public.vendor_payment_schedule_items for insert
  to authenticated
  with check (private.is_wedding_member(wedding_id));

create policy vendor_payment_schedule_items_update_member
  on public.vendor_payment_schedule_items for update
  to authenticated
  using (private.is_wedding_member(wedding_id))
  with check (private.is_wedding_member(wedding_id));

create policy vendor_payment_schedule_items_delete_member
  on public.vendor_payment_schedule_items for delete
  to authenticated
  using (private.is_wedding_member(wedding_id));

grant select on table public.vendor_payments to authenticated;
grant insert (wedding_id, wedding_vendor_id, schedule_item_id, amount_minor, paid_on, note)
  on table public.vendor_payments to authenticated;
grant update (schedule_item_id, amount_minor, paid_on, note) on table public.vendor_payments to authenticated;
grant delete on table public.vendor_payments to authenticated;

create policy vendor_payments_select_member
  on public.vendor_payments for select
  to authenticated
  using (private.is_wedding_member(wedding_id));

create policy vendor_payments_insert_member
  on public.vendor_payments for insert
  to authenticated
  with check (private.is_wedding_member(wedding_id));

create policy vendor_payments_update_member
  on public.vendor_payments for update
  to authenticated
  using (private.is_wedding_member(wedding_id))
  with check (private.is_wedding_member(wedding_id));

create policy vendor_payments_delete_member
  on public.vendor_payments for delete
  to authenticated
  using (private.is_wedding_member(wedding_id));
