-- LB-03: RLS helper functions (ADR-001 §4, ADR-002 §4).
--
-- The caller's identity always comes from auth.uid(); no user id parameter.
-- SECURITY DEFINER so a policy on wedding_memberships can consult
-- wedding_memberships without recursing into its own RLS. `search_path = ''`
-- and fully qualified names prevent search-path hijacking. Both return false
-- (never null) when there is no session or no membership: they fail closed.
--
-- These are the extension point for future access rules (e.g. organization
-- assignments); policies call only these.

create function private.is_wedding_member(target_wedding_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.wedding_memberships m
    where m.wedding_id = target_wedding_id
      and m.user_id = auth.uid()
  );
$$;

create function private.has_wedding_role(
  target_wedding_id uuid,
  allowed_roles public.wedding_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.wedding_memberships m
    where m.wedding_id = target_wedding_id
      and m.user_id = auth.uid()
      and m.role = any (allowed_roles)
  );
$$;

-- Policies run as the querying role, so `authenticated` needs to reach these.
-- `private` is not exposed through the Data API, so they are not RPCs.
grant usage on schema private to authenticated;

revoke all on function private.is_wedding_member(uuid) from public;
revoke all on function private.has_wedding_role(uuid, public.wedding_role[]) from public;
grant execute on function private.is_wedding_member(uuid) to authenticated;
grant execute on function private.has_wedding_role(uuid, public.wedding_role[]) to authenticated;
