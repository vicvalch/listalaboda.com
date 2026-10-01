-- LB-03: controlled MembershipInvite acceptance (ADR-002 §5).
--
-- The server hashes the plaintext token and passes only the hash. Clients
-- cannot read invites by token_hash (no column privilege, owner-only RLS);
-- this function is the only lookup by hash, and it acts only for auth.uid().
--
-- Every reason an invite can't be used (unknown, expired, revoked, already
-- accepted, email mismatch) raises the same error, so the function can't be
-- used to probe invite state.
--
-- Outcomes:
--   * new member     -> membership with the invite's intended_role is
--                       created and the invite is marked accepted.
--   * already member -> nothing changes: the existing role is returned with
--                       already_member = true and the invite stays pending
--                       (it may be meant for someone else; owners can revoke).

create function public.accept_membership_invite(invite_token_hash text)
returns table (wedding_id uuid, role public.wedding_role, already_member boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user_id uuid := auth.uid();
  v_invite public.membership_invites;
  v_user_email text;
  v_user_email_confirmed_at timestamptz;
  v_existing_role public.wedding_role;
begin
  if v_user_id is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  -- Row lock: concurrent acceptances of the same invite serialize, and the
  -- second sees accepted_at set.
  select i.* into v_invite
  from public.membership_invites i
  where i.token_hash = accept_membership_invite.invite_token_hash
  for update;

  if not found
     or v_invite.revoked_at is not null
     or v_invite.accepted_at is not null
     or v_invite.expires_at <= now() then
    raise exception 'membership_invite_invalid' using errcode = 'P0001';
  end if;

  -- Email binding uses the authenticated identity, never client input.
  if v_invite.email is not null then
    select u.email, u.email_confirmed_at
      into v_user_email, v_user_email_confirmed_at
    from auth.users u
    where u.id = v_user_id;

    if v_user_email_confirmed_at is null
       or lower(v_user_email) is distinct from v_invite.email then
      raise exception 'membership_invite_invalid' using errcode = 'P0001';
    end if;
  end if;

  select m.role into v_existing_role
  from public.wedding_memberships m
  where m.wedding_id = v_invite.wedding_id
    and m.user_id = v_user_id;

  if found then
    return query select v_invite.wedding_id, v_existing_role, true;
    return;
  end if;

  insert into public.wedding_memberships (wedding_id, user_id, role)
  values (v_invite.wedding_id, v_user_id, v_invite.intended_role);

  update public.membership_invites i
  set accepted_at = now(),
      accepted_by = v_user_id
  where i.id = v_invite.id;

  return query select v_invite.wedding_id, v_invite.intended_role, false;
end;
$$;

comment on function public.accept_membership_invite(text) is
  'Accepts a membership invite (by token hash) for auth.uid(). Single-use; same error for every invalid case.';

revoke all on function public.accept_membership_invite(text) from public, anon, authenticated;
grant execute on function public.accept_membership_invite(text) to authenticated;
