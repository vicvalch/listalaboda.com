-- LB-03: RLS policies and table privileges for the wedding foundation.
--
-- Two layers, both deny-by-default:
--   1. Privileges: `anon` gets nothing; `authenticated` gets only the
--      operations and columns listed here.
--   2. Policies: row access requires membership/ownership of the wedding.
--
-- There is no INSERT path into weddings or wedding_memberships for clients:
-- weddings are created by public.create_wedding and memberships by
-- public.create_wedding / public.accept_membership_invite.

-- ---------------------------------------------------------------- weddings

grant select, delete on table public.weddings to authenticated;
grant update (name, wedding_date) on table public.weddings to authenticated;

create policy weddings_select_member
  on public.weddings for select
  to authenticated
  using (private.is_wedding_member(id));

create policy weddings_update_owner
  on public.weddings for update
  to authenticated
  using (private.has_wedding_role(id, array['owner']::public.wedding_role[]))
  with check (private.has_wedding_role(id, array['owner']::public.wedding_role[]));

-- Deleting a wedding cascades to its memberships and invites.
create policy weddings_delete_owner
  on public.weddings for delete
  to authenticated
  using (private.has_wedding_role(id, array['owner']::public.wedding_role[]));

-- ------------------------------------------------------ wedding_memberships

grant select, delete on table public.wedding_memberships to authenticated;
-- Only the role can change; rows never move between weddings or users.
grant update (role) on table public.wedding_memberships to authenticated;

create policy wedding_memberships_select_member
  on public.wedding_memberships for select
  to authenticated
  using (private.is_wedding_member(wedding_id));

-- The final-owner trigger additionally keeps at least one owner.
create policy wedding_memberships_update_owner
  on public.wedding_memberships for update
  to authenticated
  using (private.has_wedding_role(wedding_id, array['owner']::public.wedding_role[]))
  with check (private.has_wedding_role(wedding_id, array['owner']::public.wedding_role[]));

create policy wedding_memberships_delete_owner
  on public.wedding_memberships for delete
  to authenticated
  using (private.has_wedding_role(wedding_id, array['owner']::public.wedding_role[]));

-- ------------------------------------------------------- membership_invites

-- token_hash is insertable but never readable through the API, so a read of
-- the invite list can't be replayed as an acceptance credential.
grant select (
  id, wedding_id, email, intended_role, expires_at, revoked_at,
  accepted_at, accepted_by, created_by, created_at, updated_at
) on table public.membership_invites to authenticated;
-- created_by defaults to auth.uid(); acceptance and revocation state are not
-- insertable.
grant insert (wedding_id, email, intended_role, token_hash, expires_at)
  on table public.membership_invites to authenticated;
-- Owners may only revoke. Acceptance goes through accept_membership_invite.
grant update (revoked_at) on table public.membership_invites to authenticated;
-- No DELETE: revoke instead, keeping the history.

create policy membership_invites_select_owner
  on public.membership_invites for select
  to authenticated
  using (private.has_wedding_role(wedding_id, array['owner']::public.wedding_role[]));

create policy membership_invites_insert_owner
  on public.membership_invites for insert
  to authenticated
  with check (
    private.has_wedding_role(wedding_id, array['owner']::public.wedding_role[])
    and created_by = auth.uid()
  );

create policy membership_invites_update_owner
  on public.membership_invites for update
  to authenticated
  using (private.has_wedding_role(wedding_id, array['owner']::public.wedding_role[]))
  with check (private.has_wedding_role(wedding_id, array['owner']::public.wedding_role[]));
