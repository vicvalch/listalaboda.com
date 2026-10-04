-- LB-11: GuestInvitation email delivery (Constitution §8 Phase 2 "GuestInvitation
-- ... emails via Resend"; ADR-002 §5, §7).
--
-- The delivery address belongs to the PARTY (one GuestInvitation = one
-- household = one RSVP capability), never to a Guest: guests still hold no
-- contact data. It is optional (existing parties and manual links keep
-- working) and is PRIVATE wedding data like the rest of the guest list:
-- members read and edit it, anon has no access, and no public or guest
-- function returns it.
--
-- The plaintext link token is still never stored. An email can only carry a
-- link whose plaintext the server holds at that moment: one just created or
-- just rotated. To send for an existing party the server either receives the
-- fresh token back from the organizer who was shown it (checked here against
-- the stored hash, see guest_invitation_link_is_current) or an owner
-- generates a new link (the owner-only rotation of LB-09, unchanged).
--
-- Send metadata keeps only the LATEST successful send (when, to whom, the
-- provider's message id): operational status, not an activity history, and
-- no provider payloads, bounce/open tracking or counters. Clients can read it
-- but never write it, not even through an RPC: only
-- record_guest_invitation_email does, executable by service_role alone and
-- called by the server after the provider accepted the message (ADR-004).

-- ------------------------------------------------------------- columns

alter table public.guest_invitations
  -- Where the party's invitation is sent. Stored normalized by the server:
  -- trimmed, domain lowercased, conservative ASCII syntax, ≤ 254 chars
  -- (local part ≤ 64). Not unique: one address may receive several
  -- invitations (other weddings, other parties). Not hashed or encrypted:
  -- organizers read and edit it and the provider needs it.
  add column contact_email text,
  -- Latest successful invitation email. All three set together or none.
  add column invitation_email_sent_at timestamptz,
  -- The recipient of that send. Kept apart from contact_email, which may be
  -- edited or removed afterwards, so the status never claims a send to an
  -- address that didn't receive it.
  add column invitation_email_sent_to text,
  -- The provider's message id for that send (opaque, bounded). Never a
  -- token, URL or provider response body.
  add column invitation_email_provider_id text,
  add constraint guest_invitations_contact_email_valid check (
    contact_email is null
    or (
      char_length(contact_email) <= 254
      and char_length(split_part(contact_email, '@', 1)) <= 64
      and contact_email ~ '^[A-Za-z0-9!#$%&''*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&''*+/=?^_`{|}~-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
    )
  ),
  add constraint guest_invitations_email_sent_to_valid check (
    invitation_email_sent_to is null
    or (
      char_length(invitation_email_sent_to) <= 254
      and char_length(split_part(invitation_email_sent_to, '@', 1)) <= 64
      and invitation_email_sent_to ~ '^[A-Za-z0-9!#$%&''*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&''*+/=?^_`{|}~-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
    )
  ),
  add constraint guest_invitations_email_provider_id_valid check (
    invitation_email_provider_id is null
    or invitation_email_provider_id ~ '^[A-Za-z0-9._:-]{1,200}$'
  ),
  add constraint guest_invitations_email_sent_complete check (
    (invitation_email_sent_at is null) = (invitation_email_sent_to is null)
    and (invitation_email_sent_at is null) = (invitation_email_provider_id is null)
  );

comment on column public.guest_invitations.contact_email is
  'Optional delivery address of the party''s invitation. PRIVATE (wedding members only); never public, never in guest functions.';
comment on column public.guest_invitations.invitation_email_sent_at is
  'Latest successful invitation email (database clock). Written only by record_guest_invitation_email.';
comment on column public.guest_invitations.invitation_email_sent_to is
  'Recipient of the latest successful invitation email. Written only by record_guest_invitation_email.';
comment on column public.guest_invitations.invitation_email_provider_id is
  'Email provider message id of the latest successful send. Written only by record_guest_invitation_email.';

-- ---------------------------------------------------------- privileges
--
-- Members (owner or collaborator, through the existing member RLS policies)
-- set, change and remove the contact email like any guest-list content.
-- Changing it never touches the link (token_hash/revoked_at stay owner-only
-- through the link guard trigger) or the RSVPs. The send metadata is
-- readable by members and writable by no client.

grant select (contact_email, invitation_email_sent_at, invitation_email_sent_to, invitation_email_provider_id)
  on table public.guest_invitations to authenticated;
grant insert (contact_email) on table public.guest_invitations to authenticated;
grant update (contact_email) on table public.guest_invitations to authenticated;

-- ------------------------------------------------ create_guest_invitation

-- Replaced to take the optional contact email in the same transaction as
-- the party and its first guests. Still SECURITY INVOKER: the caller's own
-- privileges and RLS decide, exactly as before.
drop function public.create_guest_invitation(uuid, text, text, text[]);

create function public.create_guest_invitation(
  target_wedding_id uuid,
  party_label text,
  invitation_token_hash text,
  guest_names text[],
  party_contact_email text default null
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_invitation_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  -- RLS (guest_invitations_insert_member) decides whether the caller may
  -- add a party to this wedding; created_by defaults to auth.uid(). The
  -- contact email arrives normalized; the CHECK rejects anything else.
  insert into public.guest_invitations (wedding_id, label, token_hash, contact_email)
  values (
    create_guest_invitation.target_wedding_id,
    create_guest_invitation.party_label,
    create_guest_invitation.invitation_token_hash,
    create_guest_invitation.party_contact_email
  )
  returning id into v_invitation_id;

  -- Names arrive normalized from the server; the CHECK rejects anything
  -- else. Order is kept: guests.created_at defaults to clock_timestamp(),
  -- which advances row by row. The deferred trigger requires at least one
  -- guest; there is no maximum.
  insert into public.guests (wedding_id, guest_invitation_id, name)
  select create_guest_invitation.target_wedding_id, v_invitation_id, n.name
  from unnest(coalesce(create_guest_invitation.guest_names, '{}'::text[]))
         with ordinality as n (name, position)
  order by n.position;

  return v_invitation_id;
end;
$$;

comment on function public.create_guest_invitation(uuid, text, text, text[], text) is
  'Creates a guest party with its first guests (and optional contact email), atomically, as the caller (RLS applies).';

revoke all on function public.create_guest_invitation(uuid, text, text, text[], text) from public, anon, authenticated;
grant execute on function public.create_guest_invitation(uuid, text, text, text[], text) to authenticated;

-- ---------------------------------------- guest_invitation_link_is_current

-- Before emailing a link the server got back from an organizer's screen, it
-- checks that the token is this party's CURRENT, usable link: same hash, not
-- revoked, not expired. SECURITY DEFINER only because token_hash is not
-- readable by clients; it answers nothing but true/false, and only to a
-- member of the party's wedding (false for everyone else, the same as an
-- unknown party). With 256-bit tokens the answer can't be used to guess one.
create function public.guest_invitation_link_is_current(
  target_wedding_id uuid,
  target_invitation_id uuid,
  invitation_token_hash text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select i.token_hash = guest_invitation_link_is_current.invitation_token_hash
           and i.revoked_at is null
           and now() < private.guest_invitation_expires_at(i.token_issued_at, w.wedding_date)
    from public.guest_invitations i
    join public.weddings w on w.id = i.wedding_id
    where i.id = guest_invitation_link_is_current.target_invitation_id
      and i.wedding_id = guest_invitation_link_is_current.target_wedding_id
      and private.is_wedding_member(i.wedding_id)
  ), false);
$$;

comment on function public.guest_invitation_link_is_current(uuid, uuid, text) is
  'Members only: whether a token hash is the party''s current, usable link. Never returns the hash.';

revoke all on function public.guest_invitation_link_is_current(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.guest_invitation_link_is_current(uuid, uuid, text) to authenticated;

-- ------------------------------------------- record_guest_invitation_email

-- Records a successful invitation email. The ONLY writer of the send
-- metadata, and executable ONLY by service_role (ADR-004).
--
-- Why not `authenticated`: a Server Action calls the database with the
-- user's own session (their JWT and the public publishable key), exactly
-- what that user's browser can send to PostgREST directly. Postgres can't
-- tell "the server just got a provider success" from "a member is calling
-- this RPC by hand", so any authenticated grant lets a member fabricate a
-- send. Only a credential the browser never holds can vouch for the
-- provider's answer: the server-only recorder (src/lib/email/delivery-recorder.ts)
-- calls this with the service-role key, after the user was authorized with
-- their own session and after the provider accepted the message.
--
-- It stays narrow even for that caller:
--   * one party, scoped to the given wedding (a mismatch updates nothing);
--   * the token hash must be the party's current link (the link emailed);
--   * the recipient must equal the party's current contact email, so a
--     recorded recipient is always an address an organizer entered;
--   * the time is the database clock; the provider id is bounded;
--   * it writes only the three send columns: never tokens, guests or RSVPs.
-- Anything else changes nothing and raises guest_invitation_email_not_recorded.
create function public.record_guest_invitation_email(
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
  if record_guest_invitation_email.provider_message_id is null
     or record_guest_invitation_email.provider_message_id !~ '^[A-Za-z0-9._:-]{1,200}$' then
    raise exception 'guest_invitation_email_not_recorded' using errcode = '22023';
  end if;

  update public.guest_invitations i
     set invitation_email_sent_at = now(),
         invitation_email_sent_to = i.contact_email,
         invitation_email_provider_id = record_guest_invitation_email.provider_message_id
   where i.id = record_guest_invitation_email.target_invitation_id
     and i.wedding_id = record_guest_invitation_email.target_wedding_id
     and i.token_hash = record_guest_invitation_email.invitation_token_hash
     and i.contact_email is not null
     and i.contact_email = record_guest_invitation_email.recipient
  returning i.invitation_email_sent_at into v_sent_at;

  if not found then
    raise exception 'guest_invitation_email_not_recorded' using errcode = 'P0001';
  end if;
  return v_sent_at;
end;
$$;

comment on function public.record_guest_invitation_email(uuid, uuid, text, text, text) is
  'service_role only (ADR-004): records a party''s latest successful invitation email (database clock). The only writer of the send metadata.';

revoke all on function public.record_guest_invitation_email(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.record_guest_invitation_email(uuid, uuid, text, text, text) to service_role;
