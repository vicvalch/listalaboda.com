-- ACCOUNT-01 (ADR-020): the immutable account type of an authenticated user.
--
-- One authenticated user has exactly ONE account type, `planner` or `couple`,
-- chosen explicitly by that user after signing in, and never changed:
--   * no row = not selected yet (the product's "NULL"). Existing users get no
--     row and no backfill: nothing is inferred from weddings, memberships,
--     invitations, metadata or behavior. They are asked on their next entry;
--   * the only write path is select_account_type(), which acts on auth.uid()
--     only (no user id parameter) and inserts at most once. Choosing the same
--     type again is an idempotent no-op; choosing the other type fails;
--   * a guard trigger keeps the row immutable for EVERY role (also the
--     function's owner and service_role): no UPDATE that changes anything, no
--     DELETE except the auth.users ON DELETE CASCADE (deleting the account).
--     Clients have no INSERT, UPDATE or DELETE privilege at all;
--   * the account type is product routing only. It never grants or restricts
--     access to a wedding: wedding_memberships, RLS and the private
--     is_wedding_member/has_wedding_role helpers are unchanged.
--
-- An emergency correction is a database-level intervention by an operator
-- (disabling the guard inside a reviewed transaction), never product UI or an
-- application API.

create type public.account_type as enum ('planner', 'couple');

comment on type public.account_type is
  'Immutable account type of an authenticated user (ADR-020). Mirrors ACCOUNT_TYPES in src/lib/accounts/account-type.ts.';

create table public.user_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  account_type public.account_type not null,
  -- Database clock, always (the guard overwrites any supplied value).
  selected_at timestamptz not null default now()
);

comment on table public.user_accounts is
  'One row per user who has chosen an account type (ADR-020). No row = not selected yet. Written only by select_account_type; immutable.';
comment on column public.user_accounts.account_type is
  'planner | couple. Product routing only; never wedding authorization.';

alter table public.user_accounts enable row level security;
revoke all on table public.user_accounts from public, anon, authenticated;

-- A user reads only their own row. No client write privilege: the choice is
-- made only through select_account_type.
grant select (user_id, account_type, selected_at) on table public.user_accounts to authenticated;

create policy user_accounts_select_own
  on public.user_accounts for select
  to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------- immutability guard

-- For EVERY role:
--   * INSERT: the time is the database clock (a supplied value is replaced);
--   * UPDATE: refused when it would change any column. Writing the same values
--     again is allowed (a no-op), so planner → planner and couple → couple
--     hold; planner ↔ couple and anything → NULL never do;
--   * DELETE: refused, except the auth.users ON DELETE CASCADE (it runs from
--     the referential trigger, so the trigger depth is at least 2). Deleting
--     the account deletes its account type; nothing else does.
-- (A superuser can still disable triggers; that is the operator-only
-- emergency path, outside the application boundary.)
create function private.guard_user_accounts()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.selected_at := now();
    return new;
  end if;

  if tg_op = 'DELETE' then
    if pg_catalog.pg_trigger_depth() < 2 then
      raise exception 'account_type_immutable'
        using errcode = '55000',
              detail = 'An account type is never removed; only deleting the account removes it.';
    end if;
    return old;
  end if;

  if new.user_id is distinct from old.user_id
     or new.account_type is distinct from old.account_type
     or new.selected_at is distinct from old.selected_at then
    raise exception 'account_type_immutable'
      using errcode = '55000',
            detail = 'An account type is chosen once and never changed.';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_user_accounts() from public;

create trigger user_accounts_guard
  before insert or update or delete on public.user_accounts
  for each row execute function private.guard_user_accounts();

-- ------------------------------------------------------- select_account_type

-- The caller (auth.uid(), never a parameter) chooses their account type:
--   * no row yet → inserts it and returns it;
--   * the same type already chosen → returns it (idempotent, nothing written);
--   * the other type already chosen → account_type_already_selected (55000).
-- Concurrent first choices serialize on the primary key: the loser's
-- ON CONFLICT DO NOTHING waits for the winner, then reads the committed row.
-- SECURITY DEFINER because clients have no INSERT privilege on the table;
-- it writes exactly one row, the caller's own.
create function public.select_account_type(requested public.account_type)
returns public.account_type
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_current public.account_type;
begin
  if v_user_id is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if select_account_type.requested is null then
    raise exception 'account_type_required' using errcode = '22023';
  end if;

  insert into public.user_accounts (user_id, account_type)
  values (v_user_id, select_account_type.requested)
  on conflict (user_id) do nothing;

  select a.account_type into v_current
  from public.user_accounts a
  where a.user_id = v_user_id;

  if v_current is distinct from select_account_type.requested then
    raise exception 'account_type_already_selected' using errcode = '55000';
  end if;
  return v_current;
end;
$$;

comment on function public.select_account_type(public.account_type) is
  'Sets the caller''s (auth.uid()) account type once (ADR-020). Same type again = no-op; the other type = account_type_already_selected.';

revoke all on function public.select_account_type(public.account_type) from public, anon, authenticated;
grant execute on function public.select_account_type(public.account_type) to authenticated;
