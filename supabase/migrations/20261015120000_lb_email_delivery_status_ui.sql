-- LB-18.3: delivery status for members and the same-address send guard
-- (ADR-011 §9, §14).
--
-- 1. Members (owners and collaborators) may now read email_deliveries.status
--    of their own weddings' rows (the existing member RLS policy), next to the
--    identity columns they already read. Nothing else is exposed:
--    provider_message_id and status_event_at stay without a client grant,
--    email_delivery_events stays without any privilege, and no client role
--    gains a write.
--
-- 2. One closed answer to "has this wedding already seen this exact address
--    bounce, be suppressed or complain?" (private.email_recipient_block),
--    reached through two doors only:
--      * get_guest_invitation_email_block — members, before a MANUAL send
--        (invitation, reminder), for the party's CURRENT contact email;
--      * get_rsvp_confirmation_email_context — service_role only (ADR-005),
--        which now also returns the block for the party's current address,
--        so the RSVP confirmation is skipped (the RSVP itself is untouched).
--    Scoped to ONE wedding and to the address in its comparison form (trimmed,
--    lowercased; private.email_comparison_form): a case-only edit is the SAME
--    address and stays blocked, a genuinely different address is never
--    blocked by an old one, and another wedding's history never counts.
--    delayed / failed / delivered / accepted never block.
--
-- Not here (LB-18.4): automatic reminder eligibility (recipient_undeliverable,
-- recently_reminded per address). The LB-17 scheduler functions are untouched.
-- No activity rows for delivery outcomes; no override.

-- ----------------------------------------------------------------- type

-- Declared weakest → strongest so max() picks the strongest block.
create type public.email_recipient_block as enum (
  'none',        -- sendable: no bounced / suppressed / complained send to this address
  'suppressed',
  'bounced',
  'complained'
);

comment on type public.email_recipient_block is
  'LB-18.3 (ADR-011 §9): whether a wedding already saw this exact address be suppressed, bounce or complain. none = sendable.';

-- --------------------------------------------------- the comparison form

-- How two addresses are COMPARED for delivery safety: trimmed and lowercased
-- as a whole (the app's twin: normalizeEmailForComparison). Comparison only:
-- stored values (ledger recipients, contact emails) and what members see keep
-- their casing. Nothing provider-specific: dots and +tags stay significant.
create function private.email_comparison_form(email text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.lower(pg_catalog.btrim(email));
$$;

comment on function private.email_comparison_form(text) is
  'LB-18.3 (ADR-011 §14): trim + lowercase, for comparing addresses only. Never stored.';

revoke all on function private.email_comparison_form(text) from public, anon, authenticated, service_role;

-- --------------------------------------------------- the one determination

-- Equality in the comparison form, within ONE wedding. Reads the status column
-- only: never the event history, never a provider-wide suppression list.
create function private.email_recipient_block(target_wedding_id uuid, target_recipient text)
returns public.email_recipient_block
language sql
stable
set search_path = ''
as $$
  select coalesce(max(d.status)::text, 'none')::public.email_recipient_block
  from public.email_deliveries d
  where d.wedding_id = email_recipient_block.target_wedding_id
    and private.email_comparison_form(d.recipient)
        = private.email_comparison_form(email_recipient_block.target_recipient)
    and d.status in ('suppressed', 'bounced', 'complained');
$$;

comment on function private.email_recipient_block(uuid, text) is
  'LB-18.3 (ADR-011 §9): the strongest suppressed/bounced/complained status of this exact address in this wedding, or none.';

revoke all on function private.email_recipient_block(uuid, text) from public, anon, authenticated, service_role;

-- The guard's lookup: one wedding, one address (in its comparison form).
create index email_deliveries_wedding_recipient_idx
  on public.email_deliveries (wedding_id, private.email_comparison_form(recipient));

-- ------------------------------------------------- member read of status

grant select (status) on table public.email_deliveries to authenticated;

-- ------------------------------------------ get_guest_invitation_email_block

-- Before a MANUAL email (invitation, reminder): is the address about to be
-- used this party's CURRENT contact email, and is it blocked in this wedding?
-- SECURITY DEFINER only so the private determination needs no client grant;
-- it checks membership itself (auth.uid()) and reads nothing but one party of
-- that wedding. null = not a party of a wedding the caller belongs to, or
-- target_recipient isn't the party's current contact email (changed in
-- between): the caller sends nothing. Returns no ids, statuses or history.
create function public.get_guest_invitation_email_block(
  target_wedding_id uuid,
  target_invitation_id uuid,
  target_recipient text
)
returns public.email_recipient_block
language sql
stable
security definer
set search_path = ''
as $$
  select private.email_recipient_block(i.wedding_id, i.contact_email)
  from public.guest_invitations i
  where i.id = get_guest_invitation_email_block.target_invitation_id
    and i.wedding_id = get_guest_invitation_email_block.target_wedding_id
    -- Staleness, not the block rule: the exact address about to be used must
    -- still be the stored one (the block itself compares case-insensitively).
    and i.contact_email = get_guest_invitation_email_block.target_recipient
    and private.is_wedding_member(i.wedding_id);
$$;

comment on function public.get_guest_invitation_email_block(uuid, uuid, text) is
  'LB-18.3 (ADR-011 §9): members; the send block of a party''s CURRENT contact email in its wedding. null = not visible or not current.';

revoke all on function public.get_guest_invitation_email_block(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.get_guest_invitation_email_block(uuid, uuid, text) to authenticated;

-- -------------------------------------- get_rsvp_confirmation_email_context

-- Same function, same rules and grants (service_role only, ADR-005), plus the
-- block of the party's CURRENT contact email. Its return type changes, so it
-- is recreated.
drop function public.get_rsvp_confirmation_email_context(text);

create function public.get_rsvp_confirmation_email_context(invitation_token_hash text)
returns table (
  wedding_id uuid,
  guest_invitation_id uuid,
  contact_email text,
  wedding_name text,
  wedding_date date,
  wedding_city text,
  contact_email_block public.email_recipient_block
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.wedding_id, i.id, i.contact_email, w.name, w.wedding_date, w.city,
         private.email_recipient_block(i.wedding_id, i.contact_email)
  from public.guest_invitations i
  join public.weddings w on w.id = i.wedding_id
  where i.token_hash = get_rsvp_confirmation_email_context.invitation_token_hash
    and i.revoked_at is null
    and now() < private.guest_invitation_expires_at(i.token_issued_at, w.wedding_date);
$$;

comment on function public.get_rsvp_confirmation_email_context(text) is
  'service_role only (ADR-005): by a usable link''s hash, the party''s ids, contact email (and its LB-18.3 send block) and wedding name/date/city for its RSVP confirmation email.';

revoke all on function public.get_rsvp_confirmation_email_context(text) from public, anon, authenticated;
grant execute on function public.get_rsvp_confirmation_email_context(text) to service_role;
