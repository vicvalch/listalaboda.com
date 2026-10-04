-- LB-12: RSVP confirmation email (Constitution §8 Phase 2 "GuestInvitation and
-- RSVP confirmation emails via Resend"; ADR-002 §5, §6; ADR-005).
--
-- After a party saves its RSVP through its link (submit_guest_rsvp, the guest
-- capability, unchanged), the server emails a confirmation of the party's
-- CURRENT answers to the party's contact email, when it has one. The RSVP is
-- primary: it is saved and committed first, and nothing about the email can
-- undo it. The confirmation never carries the RSVP link (no capability is
-- redistributed) and never stores or rebuilds a token.
--
-- Two narrow service_role-only functions (ADR-005), because the guest has no
-- account and guest functions must never reveal the party's private contact
-- email or the wedding's private fields:
--   * get_rsvp_confirmation_email_context — by token hash (the capability the
--     server already holds), only while the link is usable: the party's ids,
--     its contact email and the wedding's name, date and city. Nothing else.
--   * record_rsvp_confirmation_email — the ONLY writer of the confirmation
--     send metadata, called only after the provider accepted the message.
--
-- Confirmation metadata keeps only the LATEST successful confirmation (when,
-- to whom, the provider's message id), on the party (one submission answers
-- the whole party), separate from the invitation-email metadata. Clients can
-- read it (members, via RLS) but never write it. Not an activity history.

-- ------------------------------------------------------------- columns

alter table public.guest_invitations
  -- Latest successful RSVP confirmation email. All three set together or none.
  add column rsvp_confirmation_email_sent_at timestamptz,
  -- The recipient of that send: the party's contact email at that moment.
  -- Kept apart from contact_email, which may be edited or removed later.
  add column rsvp_confirmation_email_sent_to text,
  -- The provider's message id for that send (opaque, bounded).
  add column rsvp_confirmation_email_provider_id text,
  add constraint guest_invitations_confirmation_sent_to_valid check (
    rsvp_confirmation_email_sent_to is null
    or (
      char_length(rsvp_confirmation_email_sent_to) <= 254
      and char_length(split_part(rsvp_confirmation_email_sent_to, '@', 1)) <= 64
      and rsvp_confirmation_email_sent_to ~ '^[A-Za-z0-9!#$%&''*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&''*+/=?^_`{|}~-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
    )
  ),
  add constraint guest_invitations_confirmation_provider_id_valid check (
    rsvp_confirmation_email_provider_id is null
    or rsvp_confirmation_email_provider_id ~ '^[A-Za-z0-9._:-]{1,200}$'
  ),
  add constraint guest_invitations_confirmation_sent_complete check (
    (rsvp_confirmation_email_sent_at is null) = (rsvp_confirmation_email_sent_to is null)
    and (rsvp_confirmation_email_sent_at is null) = (rsvp_confirmation_email_provider_id is null)
  );

comment on column public.guest_invitations.rsvp_confirmation_email_sent_at is
  'Latest successful RSVP confirmation email (database clock). Written only by record_rsvp_confirmation_email.';
comment on column public.guest_invitations.rsvp_confirmation_email_sent_to is
  'Recipient of the latest successful RSVP confirmation email. Written only by record_rsvp_confirmation_email.';
comment on column public.guest_invitations.rsvp_confirmation_email_provider_id is
  'Email provider message id of the latest successful RSVP confirmation. Written only by record_rsvp_confirmation_email.';

-- Members read the status (existing member RLS policies); no client writes it.
grant select (rsvp_confirmation_email_sent_at, rsvp_confirmation_email_sent_to, rsvp_confirmation_email_provider_id)
  on table public.guest_invitations to authenticated;

-- ------------------------------------- get_rsvp_confirmation_email_context

-- What the confirmation needs beyond what the guest capability already
-- returns: the party's ids (to scope the record), its contact email and the
-- wedding's name, date and city. Executable ONLY by service_role (ADR-005):
-- the guest who holds the link must never read the contact email or the
-- wedding's private fields (guest functions don't return them), and anon is
-- exactly what the guest's browser is.
--
-- It is not authorization: the server calls it only after submit_guest_rsvp
-- (the capability boundary, as anon) succeeded with the same hash. It still
-- applies the same usability rule (unknown, revoked or expired = no row), so
-- even service_role reads one party per call, only through its live link.
-- No guests, answers, notes, members, other parties or hashes.
create function public.get_rsvp_confirmation_email_context(invitation_token_hash text)
returns table (
  wedding_id uuid,
  guest_invitation_id uuid,
  contact_email text,
  wedding_name text,
  wedding_date date,
  wedding_city text
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.wedding_id, i.id, i.contact_email, w.name, w.wedding_date, w.city
  from public.guest_invitations i
  join public.weddings w on w.id = i.wedding_id
  where i.token_hash = get_rsvp_confirmation_email_context.invitation_token_hash
    and i.revoked_at is null
    and now() < private.guest_invitation_expires_at(i.token_issued_at, w.wedding_date);
$$;

comment on function public.get_rsvp_confirmation_email_context(text) is
  'service_role only (ADR-005): by a usable link''s hash, the party''s ids, contact email and wedding name/date/city for its RSVP confirmation email.';

revoke all on function public.get_rsvp_confirmation_email_context(text) from public, anon, authenticated;
grant execute on function public.get_rsvp_confirmation_email_context(text) to service_role;

-- ------------------------------------------ record_rsvp_confirmation_email

-- Records a successful RSVP confirmation email. The ONLY writer of the
-- confirmation metadata, executable ONLY by service_role (ADR-005, same
-- reasoning as ADR-004: no client credential can vouch for a provider result).
--
-- Narrow even for that caller:
--   * one party, scoped to the given wedding (a mismatch updates nothing);
--   * the token hash must still be the party's link (the capability whose
--     submission is being confirmed);
--   * the recipient must equal the party's current contact email;
--   * the time is the database clock; the provider id is bounded;
--   * it writes only the three confirmation columns: never tokens, guests,
--     RSVPs, invitation-email metadata, publication or wedding data.
-- Anything else changes nothing and raises rsvp_confirmation_email_not_recorded.
create function public.record_rsvp_confirmation_email(
  target_wedding_id uuid,
  target_invitation_id uuid,
  invitation_token_hash text,
  recipient text,
  provider_message_id text
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sent_at timestamptz;
begin
  if record_rsvp_confirmation_email.provider_message_id is null
     or record_rsvp_confirmation_email.provider_message_id !~ '^[A-Za-z0-9._:-]{1,200}$' then
    raise exception 'rsvp_confirmation_email_not_recorded' using errcode = '22023';
  end if;

  update public.guest_invitations i
     set rsvp_confirmation_email_sent_at = now(),
         rsvp_confirmation_email_sent_to = i.contact_email,
         rsvp_confirmation_email_provider_id = record_rsvp_confirmation_email.provider_message_id
   where i.id = record_rsvp_confirmation_email.target_invitation_id
     and i.wedding_id = record_rsvp_confirmation_email.target_wedding_id
     and i.token_hash = record_rsvp_confirmation_email.invitation_token_hash
     and i.contact_email is not null
     and i.contact_email = record_rsvp_confirmation_email.recipient
  returning i.rsvp_confirmation_email_sent_at into v_sent_at;

  if not found then
    raise exception 'rsvp_confirmation_email_not_recorded' using errcode = 'P0001';
  end if;
  return v_sent_at;
end;
$$;

comment on function public.record_rsvp_confirmation_email(uuid, uuid, text, text, text) is
  'service_role only (ADR-005): records a party''s latest successful RSVP confirmation email (database clock). The only writer of the confirmation metadata.';

revoke all on function public.record_rsvp_confirmation_email(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.record_rsvp_confirmation_email(uuid, uuid, text, text, text) to service_role;
