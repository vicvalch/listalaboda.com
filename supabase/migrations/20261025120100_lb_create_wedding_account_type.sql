-- ACCOUNT-01 (ADR-020 §5): the account type also constrains wedding
-- CREATION, in the database, so the one creation path (create_wedding) and
-- the application enforce the same product rule:
--   * planner → may create any number of weddings (unchanged);
--   * couple  → may create a wedding only while they belong to NO wedding
--               (any membership, owner or collaborator, blocks it):
--               couple_wedding_limit;
--   * untyped (no user_accounts row) → refused: account_type_required. The
--               one-time choice comes first.
-- Both errors are SQLSTATE 55000 (object_not_in_prerequisite_state, as
-- account_type_already_selected), told apart by their message.
--
-- The caller's user_accounts row is locked FOR UPDATE before the rule is
-- checked, so concurrent creations by the same account serialize: the
-- second one sees the first one's committed membership (READ COMMITTED: each
-- statement takes a new snapshot) and is refused.
--
-- This is a creation rule, not wedding access: memberships, RLS, the helpers
-- and every other function are unchanged. Joining a wedding through a
-- membership invite (accept_membership_invite) still works for any account.
-- Legacy couples keep every wedding they belong to; they just can't create
-- more.
--
-- Same signature, SECURITY DEFINER, search_path = '', owner and grants (a
-- CREATE OR REPLACE keeps the function's owner and ACL); the wedding insert
-- and the owner membership are exactly as before (20261003120000).

create or replace function public.create_wedding(
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
  v_account_type public.account_type;
  v_wedding public.weddings;
begin
  if v_user_id is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  -- The caller's own account type, locked until this transaction ends.
  select a.account_type into v_account_type
  from public.user_accounts a
  where a.user_id = v_user_id
  for update;

  if v_account_type is null then
    raise exception 'account_type_required' using errcode = '55000';
  end if;

  if v_account_type = 'couple' and exists (
    select 1 from public.wedding_memberships m where m.user_id = v_user_id
  ) then
    raise exception 'couple_wedding_limit' using errcode = '55000';
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
  'Creates a wedding and makes the caller (auth.uid()) its owner, atomically. ACCOUNT-01: planners any number; couples only with no membership (couple_wedding_limit); untyped accounts never (account_type_required).';
