-- LB-09: controlled entry points for the guest list (ADR-002 §5).
--
--   * public.create_guest_invitation — organizers: a party and its first
--     guests in one transaction (a party is never empty). SECURITY INVOKER:
--     it runs with the caller's own privileges and RLS, exactly like the
--     equivalent table writes; it only adds atomicity.
--   * public.get_guest_invitation / public.submit_guest_rsvp — the guest
--     capability. SECURITY DEFINER, because guests have no account and anon
--     has no table privileges. They take only the token hash (the server
--     hashes the plaintext), find exactly one party by it, and read or write
--     only that party's guests and responses. Nothing about the caller's
--     session matters: an authenticated user without the token gets nothing
--     more than anon.
--
-- Unknown, revoked and expired links (and deleted parties) all look the
-- same: get returns no rows; submit raises guest_invitation_unavailable.

-- ------------------------------------------------ create_guest_invitation

create function public.create_guest_invitation(
  target_wedding_id uuid,
  party_label text,
  invitation_token_hash text,
  guest_names text[]
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
  -- add a party to this wedding; created_by defaults to auth.uid().
  insert into public.guest_invitations (wedding_id, label, token_hash)
  values (
    create_guest_invitation.target_wedding_id,
    create_guest_invitation.party_label,
    create_guest_invitation.invitation_token_hash
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

comment on function public.create_guest_invitation(uuid, text, text, text[]) is
  'Creates a guest party with its first guests, atomically, as the caller (RLS applies).';

revoke all on function public.create_guest_invitation(uuid, text, text, text[]) from public, anon, authenticated;
grant execute on function public.create_guest_invitation(uuid, text, text, text[]) to authenticated;

-- ------------------------------------------------- get_guest_invitation

-- One row per guest of the party behind the token, in party order, with the
-- guest's current response (null attending = "Sin responder"). Only what the
-- RSVP page shows: no wedding fields (private until explicitly published,
-- Constitution §10.9), no ids other than the party's own guests, no members,
-- checklist, other parties or hashes.
create function public.get_guest_invitation(invitation_token_hash text)
returns table (
  party_label text,
  guest_id uuid,
  guest_name text,
  attending boolean,
  dietary_note text
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.label, g.id, g.name, r.attending, r.dietary_note
  from public.guest_invitations i
  join public.weddings w on w.id = i.wedding_id
  join public.guests g
    on g.guest_invitation_id = i.id and g.wedding_id = i.wedding_id
  left join public.rsvps r
    on r.guest_id = g.id and r.wedding_id = g.wedding_id
  where i.token_hash = get_guest_invitation.invitation_token_hash
    and i.revoked_at is null
    and now() < private.guest_invitation_expires_at(i.token_issued_at, w.wedding_date)
  order by g.created_at, g.id;
$$;

comment on function public.get_guest_invitation(text) is
  'Guest capability (by token hash): the party''s guests and their current RSVP. No rows when the link is unknown, revoked or expired.';

revoke all on function public.get_guest_invitation(text) from public, anon, authenticated;
grant execute on function public.get_guest_invitation(text) to anon, authenticated;

-- ---------------------------------------------------- submit_guest_rsvp

-- The party answers for EVERY current guest at once, each explicitly:
--   responses = [{"guest_id": uuid, "attending": true|false,
--                 "dietary_note": text|null}, ...]
-- All-or-nothing (one transaction): if the link is unusable, the payload is
-- malformed, or the set of guest ids is not exactly this party's guests (a
-- forged id from another party or wedding, a missing guest, a duplicate),
-- nothing is written. Answering again updates each guest's single row.
create function public.submit_guest_rsvp(invitation_token_hash text, responses jsonb)
returns table (
  party_label text,
  guest_id uuid,
  guest_name text,
  attending boolean,
  dietary_note text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_invitation public.guest_invitations;
  v_wedding_date date;
  v_response jsonb;
  v_party_size integer;
  v_answered integer;
begin
  -- Row lock: concurrent submissions (double clicks, two devices) and
  -- organizer edits of the same party serialize.
  select i.* into v_invitation
  from public.guest_invitations i
  where i.token_hash = submit_guest_rsvp.invitation_token_hash
  for update;

  if not found then
    raise exception 'guest_invitation_unavailable' using errcode = 'P0001';
  end if;

  select w.wedding_date into v_wedding_date
  from public.weddings w where w.id = v_invitation.wedding_id;

  if v_invitation.revoked_at is not null
     or now() >= private.guest_invitation_expires_at(v_invitation.token_issued_at, v_wedding_date) then
    raise exception 'guest_invitation_unavailable' using errcode = 'P0001';
  end if;

  -- Exactly this party's guests, each once: the payload must be a non-empty
  -- array with one entry per current guest (checked before anything else
  -- is looked at, so the work is bounded by the party's size).
  if submit_guest_rsvp.responses is null
     or jsonb_typeof(submit_guest_rsvp.responses) <> 'array'
     or jsonb_array_length(submit_guest_rsvp.responses) = 0 then
    raise exception 'guest_rsvp_invalid' using errcode = '22023';
  end if;

  select count(*) into v_party_size
  from public.guests g
  where g.guest_invitation_id = v_invitation.id and g.wedding_id = v_invitation.wedding_id;

  if jsonb_array_length(submit_guest_rsvp.responses) <> v_party_size then
    raise exception 'guest_rsvp_mismatch' using errcode = 'P0001';
  end if;

  -- Shape: objects with a uuid guest_id, a JSON boolean attending and an
  -- optional string (or null) dietary_note.
  for v_response in select value from jsonb_array_elements(submit_guest_rsvp.responses)
  loop
    if jsonb_typeof(v_response) <> 'object'
       or jsonb_typeof(v_response -> 'guest_id') is distinct from 'string'
       or (v_response ->> 'guest_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(v_response -> 'attending') is distinct from 'boolean'
       or (v_response ? 'dietary_note'
           and jsonb_typeof(v_response -> 'dietary_note') not in ('string', 'null')) then
      raise exception 'guest_rsvp_invalid' using errcode = '22023';
    end if;
  end loop;

  -- Every entry names a different guest of THIS party (a forged id from
  -- another party or wedding, or a duplicate, leaves one unmatched).
  select count(distinct g.id) into v_answered
  from jsonb_array_elements(submit_guest_rsvp.responses) e
  join public.guests g
    on g.id = (e.value ->> 'guest_id')::uuid
   and g.guest_invitation_id = v_invitation.id
   and g.wedding_id = v_invitation.wedding_id;

  if v_answered <> v_party_size then
    raise exception 'guest_rsvp_mismatch' using errcode = 'P0001';
  end if;

  -- One row per guest: insert, or update the existing one. The wedding id
  -- comes from the party, never from the caller. The note is trimmed and
  -- blank becomes null; the CHECK rejects over-long or control characters.
  insert into public.rsvps as r (guest_id, wedding_id, attending, dietary_note)
  select
    (e.value ->> 'guest_id')::uuid,
    v_invitation.wedding_id,
    (e.value ->> 'attending')::boolean,
    nullif(
      regexp_replace(coalesce(e.value ->> 'dietary_note', ''),
                     '^[[:space:]]+|[[:space:]]+$', '', 'g'),
      ''
    )
  from jsonb_array_elements(submit_guest_rsvp.responses) e
  on conflict on constraint rsvps_pkey do update
    set attending = excluded.attending,
        dietary_note = excluded.dietary_note;

  return query
    select v_invitation.label, g.id, g.name, rv.attending, rv.dietary_note
    from public.guests g
    left join public.rsvps rv on rv.guest_id = g.id and rv.wedding_id = g.wedding_id
    where g.guest_invitation_id = v_invitation.id and g.wedding_id = v_invitation.wedding_id
    order by g.created_at, g.id;
end;
$$;

comment on function public.submit_guest_rsvp(text, jsonb) is
  'Guest capability (by token hash): saves one RSVP per guest for the whole party, atomically. Same error for every unusable link.';

revoke all on function public.submit_guest_rsvp(text, jsonb) from public, anon, authenticated;
grant execute on function public.submit_guest_rsvp(text, jsonb) to anon, authenticated;
