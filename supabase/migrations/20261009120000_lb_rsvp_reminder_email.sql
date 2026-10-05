-- LB-14: manual RSVP reminder email (Constitution §8 Phase 2 "RSVP reminders";
-- ADR-002 §5, §6; ADR-004; ADR-006; ADR-007).
--
-- An organizer (owner or collaborator) explicitly sends a party a reminder
-- carrying its CURRENT RSVP link, recovered through the LB-13 primitive at
-- the moment of the action. Sending a reminder never generates, rotates,
-- revokes or stores a link: this migration adds no token column and changes
-- no link function.
--
-- Reminder metadata keeps only the LATEST successful reminder email (when,
-- to whom, the provider's message id), on the party, separate from the
-- invitation (LB-11) and confirmation (LB-12) metadata. Clients can read it
-- (members, via RLS) but never write it. Not an activity history; preparing
-- a WhatsApp text (LB-14) is not delivery and is never recorded.

-- ------------------------------------------------------------- columns

alter table public.guest_invitations
  -- Latest successful RSVP reminder email. All three set together or none.
  add column rsvp_reminder_email_sent_at timestamptz,
  -- The recipient of that send: the party's contact email at that moment.
  -- Kept apart from contact_email, which may be edited or removed later.
  add column rsvp_reminder_email_sent_to text,
  -- The provider's message id for that send (opaque, bounded).
  add column rsvp_reminder_email_provider_id text,
  add constraint guest_invitations_reminder_sent_to_valid check (
    rsvp_reminder_email_sent_to is null
    or (
      char_length(rsvp_reminder_email_sent_to) <= 254
      and char_length(split_part(rsvp_reminder_email_sent_to, '@', 1)) <= 64
      and rsvp_reminder_email_sent_to ~ '^[A-Za-z0-9!#$%&''*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&''*+/=?^_`{|}~-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
    )
  ),
  add constraint guest_invitations_reminder_provider_id_valid check (
    rsvp_reminder_email_provider_id is null
    or rsvp_reminder_email_provider_id ~ '^[A-Za-z0-9._:-]{1,200}$'
  ),
  add constraint guest_invitations_reminder_sent_complete check (
    (rsvp_reminder_email_sent_at is null) = (rsvp_reminder_email_sent_to is null)
    and (rsvp_reminder_email_sent_at is null) = (rsvp_reminder_email_provider_id is null)
  );

comment on column public.guest_invitations.rsvp_reminder_email_sent_at is
  'Latest successful RSVP reminder email (database clock). Written only by record_rsvp_reminder_email.';
comment on column public.guest_invitations.rsvp_reminder_email_sent_to is
  'Recipient of the latest successful RSVP reminder email. Written only by record_rsvp_reminder_email.';
comment on column public.guest_invitations.rsvp_reminder_email_provider_id is
  'Email provider message id of the latest successful RSVP reminder. Written only by record_rsvp_reminder_email.';

-- Members read the status (existing member RLS policies); no client writes it.
grant select (rsvp_reminder_email_sent_at, rsvp_reminder_email_sent_to, rsvp_reminder_email_provider_id)
  on table public.guest_invitations to authenticated;

-- ---------------------------------------------- record_rsvp_reminder_email

-- Records a successful RSVP reminder email. The ONLY writer of the reminder
-- metadata, executable ONLY by service_role (ADR-007, same reasoning as
-- ADR-004: a member's session can't vouch for a provider result). Called by
-- the server-only recorder after the member was authorized with their own
-- session, the current link was recovered and the provider accepted.
--
-- Narrow even for that caller:
--   * one party, scoped to the given wedding (a mismatch updates nothing);
--   * the token hash must be the party's CURRENT link, and that link must
--     still be usable (not revoked, not expired): the record claims a live
--     capability was delivered;
--   * the recipient must equal the party's current contact email;
--   * the time is the database clock; the provider id is bounded;
--   * it writes only the three reminder columns: never tokens, envelopes,
--     revocation, guests, RSVPs, invitation or confirmation metadata,
--     publication or wedding data.
-- Anything else changes nothing and raises rsvp_reminder_email_not_recorded.
create function public.record_rsvp_reminder_email(
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
  if record_rsvp_reminder_email.provider_message_id is null
     or record_rsvp_reminder_email.provider_message_id !~ '^[A-Za-z0-9._:-]{1,200}$' then
    raise exception 'rsvp_reminder_email_not_recorded' using errcode = '22023';
  end if;

  update public.guest_invitations i
     set rsvp_reminder_email_sent_at = now(),
         rsvp_reminder_email_sent_to = i.contact_email,
         rsvp_reminder_email_provider_id = record_rsvp_reminder_email.provider_message_id
    from public.weddings w
   where w.id = i.wedding_id
     and i.id = record_rsvp_reminder_email.target_invitation_id
     and i.wedding_id = record_rsvp_reminder_email.target_wedding_id
     and i.token_hash = record_rsvp_reminder_email.invitation_token_hash
     and i.revoked_at is null
     and now() < private.guest_invitation_expires_at(i.token_issued_at, w.wedding_date)
     and i.contact_email is not null
     and i.contact_email = record_rsvp_reminder_email.recipient
  returning i.rsvp_reminder_email_sent_at into v_sent_at;

  if not found then
    raise exception 'rsvp_reminder_email_not_recorded' using errcode = 'P0001';
  end if;
  return v_sent_at;
end;
$$;

comment on function public.record_rsvp_reminder_email(uuid, uuid, text, text, text) is
  'service_role only (ADR-007): records a party''s latest successful RSVP reminder email (database clock). The only writer of the reminder metadata.';

revoke all on function public.record_rsvp_reminder_email(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.record_rsvp_reminder_email(uuid, uuid, text, text, text) to service_role;
