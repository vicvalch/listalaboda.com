-- LB-03: atomic wedding creation.
--
-- An explicit RPC rather than an INSERT trigger: the intent is visible at the
-- call site, the caller's identity is checked in one place, and clients keep
-- no INSERT privilege on weddings at all. The wedding row and the creator's
-- owner membership are written in one transaction, so an ownerless wedding
-- can never be observed or survive a failure.
--
-- The creator is always auth.uid(); the function accepts no user id.

create function public.create_wedding(
  wedding_name text,
  wedding_date date default null
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

  insert into public.weddings (created_by, name, wedding_date)
  values (v_user_id, btrim(create_wedding.wedding_name), create_wedding.wedding_date)
  returning * into v_wedding;

  insert into public.wedding_memberships (wedding_id, user_id, role)
  values (v_wedding.id, v_user_id, 'owner');

  return v_wedding;
end;
$$;

comment on function public.create_wedding(text, date) is
  'Creates a wedding and makes the caller (auth.uid()) its owner, atomically.';

revoke all on function public.create_wedding(text, date) from public, anon, authenticated;
grant execute on function public.create_wedding(text, date) to authenticated;
