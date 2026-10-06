-- LB-17: automatic RSVP reminder scheduling (ADR-010; Constitution §8 Phase 2
-- "RSVP reminders"; ADR-002 §6; ADR-006; ADR-007; ADR-008).
--
-- An owner may opt a wedding into ONE automatic reminder per unanswered party,
-- days_before (14/21/30) days before the wedding at 10:00 wedding-local time,
-- sendable for 48 h. A trusted deployment scheduler (an authenticated cron
-- route, ADR-010 §4) drives it through five service_role-only functions:
--
--   claim   → prepare → [app: decrypt, verify, render] → begin → ONE provider
--   call → record (success) | finish (every other outcome)
--
-- Nothing here sends anything, and this migration enables nothing: it creates
-- ZERO policy rows (every wedding stays OFF) and ZERO occurrence rows. There
-- is no backfill and no default-enabled policy.
--
-- Current truth, always: due dates are computed just in time from the CURRENT
-- policy, wedding date and time zone; eligibility is re-evaluated at claim,
-- prepare and begin from current rows. No calendar of future sends is stored.
--
-- What is never stored here: tokens, hashes, envelopes, RSVP URLs, recipients
-- or contact emails, provider message ids, answers, notes, rendered bodies.

-- --------------------------------------------------------------- enums

create type public.automatic_rsvp_reminder_state as enum (
  'claimed',          -- leased to a worker; no provider attempt in progress
  'sending',          -- begin committed: the provider boundary MAY have been crossed
  'retry_wait',       -- a provider attempt failed transiently; replay later, same key
  'sent',             -- provider accepted AND the record committed
  'sent_unrecorded',  -- provider accepted; the record did not commit (terminal)
  'skipped',          -- stopped BEFORE any provider attempt (attempt_count = 0)
  'failed',           -- the provider definitively rejected the recipient (terminal)
  'unknown'           -- cannot prove no email was sent; automatic resend forbidden (terminal)
);

comment on type public.automatic_rsvp_reminder_state is
  'LB-17 (ADR-010 §8): automatic RSVP reminder occurrence state.';

create type public.automatic_rsvp_reminder_outcome_reason as enum (
  -- pre-provider eligibility (state skipped only)
  'answered',
  'no_contact_email',
  'link_unavailable',
  'link_unrecoverable',
  'recently_reminded',
  'policy_disabled',
  'out_of_window',
  -- definite provider failure (state failed only)
  'recipient_rejected',
  -- uncertain, terminal (state unknown only)
  'ineligible_after_attempt',
  'idempotency_conflict',
  'attempts_exhausted',
  'replay_window_expired'
);

comment on type public.automatic_rsvp_reminder_outcome_reason is
  'LB-17 (ADR-010 §8): closed explanation for skipped, failed and unknown occurrences. Never free text.';

-- What the application may report through finish_automatic_rsvp_reminder.
create type public.automatic_rsvp_reminder_finish_outcome as enum (
  'link_unrecoverable',    -- decryption failed before the provider call
  'sent_unrecorded',       -- provider accepted; the record failed or there was no id
  'retry',                 -- transient provider failure (may have been delivered)
  'recipient_rejected',    -- provider definitively rejected the recipient
  'idempotency_conflict'   -- provider refused the reused key for a different payload
);

comment on type public.automatic_rsvp_reminder_finish_outcome is
  'LB-17 (ADR-010 §13): the closed outcomes the scheduler reports after prepare/begin.';

-- -------------------------------------------------------------- policy

create table public.wedding_rsvp_reminder_policies (
  wedding_id uuid primary key references public.weddings (id) on delete cascade,
  enabled boolean not null default false,
  days_before smallint not null default 21,
  -- Database clock at the latest off → on switch. No never-claimed party is
  -- sent a reminder whose due time is before it (no retroactive sends).
  enabled_at timestamptz,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wedding_rsvp_reminder_policies_days_before check (days_before in (14, 21, 30)),
  constraint wedding_rsvp_reminder_policies_enabled_at check (not enabled or enabled_at is not null)
);

comment on table public.wedding_rsvp_reminder_policies is
  'LB-17 (ADR-010 §5): an owner''s opt-in to one automatic RSVP reminder per unanswered party. No row = OFF. Written only by set_rsvp_reminder_policy.';

create trigger wedding_rsvp_reminder_policies_set_updated_at
  before update on public.wedding_rsvp_reminder_policies
  for each row execute function private.set_updated_at();

alter table public.wedding_rsvp_reminder_policies enable row level security;
revoke all on table public.wedding_rsvp_reminder_policies from public, anon, authenticated;

-- Members (owners and collaborators) read it; nobody writes it directly.
grant select on table public.wedding_rsvp_reminder_policies to authenticated;

create policy wedding_rsvp_reminder_policies_select_member
  on public.wedding_rsvp_reminder_policies for select
  to authenticated
  using (private.is_wedding_member(wedding_id));

-- --------------------------------------------------------- occurrences

create table public.automatic_rsvp_reminders (
  -- Also the provider idempotency key's only input (lb-auto-rsvp-reminder:<id>).
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings (id) on delete cascade,
  guest_invitation_id uuid not null,
  state public.automatic_rsvp_reminder_state not null,
  outcome_reason public.automatic_rsvp_reminder_outcome_reason,
  -- The last computed due time (display/audit only; truth is recomputed).
  due_at timestamptz not null,
  claim_token uuid,
  lease_expires_at timestamptz,
  -- Provider send attempts BEGUN (incremented only by a successful begin).
  attempt_count smallint not null default 0,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One occurrence per party, ever: re-entry reuses the row (ADR-010 §8a).
  constraint automatic_rsvp_reminders_one_per_party unique (guest_invitation_id),
  -- Same-wedding invariant (ADR-001 §2). Deleting the party deletes its
  -- occurrence; the activity history keeps the facts.
  constraint automatic_rsvp_reminders_party_same_wedding
    foreign key (guest_invitation_id, wedding_id)
    references public.guest_invitations (id, wedding_id)
    on delete cascade,

  constraint automatic_rsvp_reminders_attempt_range check (attempt_count between 0 and 3),
  -- Which reason each state accepts (null everywhere else).
  constraint automatic_rsvp_reminders_reason_by_state check (
    case state
      when 'skipped' then coalesce(outcome_reason in (
        'answered', 'no_contact_email', 'link_unavailable', 'link_unrecoverable',
        'recently_reminded', 'policy_disabled', 'out_of_window'), false)
      when 'failed' then coalesce(outcome_reason = 'recipient_rejected', false)
      when 'unknown' then coalesce(outcome_reason in (
        'ineligible_after_attempt', 'idempotency_conflict', 'attempts_exhausted',
        'replay_window_expired'), false)
      else outcome_reason is null
    end
  ),
  -- Attempts per state: skipped never crossed the boundary; every
  -- post-boundary state did.
  constraint automatic_rsvp_reminders_attempts_by_state check (
    case state
      when 'claimed' then attempt_count between 0 and 2
      when 'skipped' then attempt_count = 0
      when 'retry_wait' then attempt_count between 1 and 2
      else attempt_count between 1 and 3
    end
  ),
  constraint automatic_rsvp_reminders_first_attempt check (
    (first_attempt_at is null) = (attempt_count = 0)
  ),
  -- A live lease exists exactly while a worker holds the row.
  constraint automatic_rsvp_reminders_lease_by_state check (
    (claim_token is not null) = (state in ('claimed', 'sending'))
    and (lease_expires_at is not null) = (state in ('claimed', 'sending'))
  ),
  constraint automatic_rsvp_reminders_next_attempt_by_state check (
    (next_attempt_at is not null) = (state = 'retry_wait')
  ),
  constraint automatic_rsvp_reminders_sent_at_by_state check (
    (sent_at is not null) = (state = 'sent')
  )
);

comment on table public.automatic_rsvp_reminders is
  'LB-17 (ADR-010 §8): one automatic RSVP reminder occurrence per party (claim, lease and outcome). Written only by the service_role scheduler functions. Stores no token, hash, envelope, recipient, provider id or content.';
comment on column public.automatic_rsvp_reminders.attempt_count is
  'Provider send attempts begun: incremented only by begin_automatic_rsvp_reminder_send, never by claims or prepares.';
comment on column public.automatic_rsvp_reminders.claim_token is
  'The current worker''s lease token. Never readable by clients.';

create index automatic_rsvp_reminders_wedding_idx
  on public.automatic_rsvp_reminders (wedding_id);
create index automatic_rsvp_reminders_party_wedding_idx
  on public.automatic_rsvp_reminders (guest_invitation_id, wedding_id);
create index automatic_rsvp_reminders_in_flight_idx
  on public.automatic_rsvp_reminders (state)
  where state in ('claimed', 'sending', 'retry_wait', 'skipped');

create trigger automatic_rsvp_reminders_set_updated_at
  before update on public.automatic_rsvp_reminders
  for each row execute function private.set_updated_at();

alter table public.automatic_rsvp_reminders enable row level security;
revoke all on table public.automatic_rsvp_reminders from public, anon, authenticated;

-- Members read what the page shows; never the lease token or worker timing.
grant select (id, wedding_id, guest_invitation_id, state, outcome_reason, due_at, attempt_count,
              sent_at, created_at, updated_at)
  on table public.automatic_rsvp_reminders to authenticated;

create policy automatic_rsvp_reminders_select_member
  on public.automatic_rsvp_reminders for select
  to authenticated
  using (private.is_wedding_member(wedding_id));

-- ------------------------------------------------------------- helpers

-- The due time: days_before days before the wedding at 10:00 in the
-- wedding's own IANA time zone. Null without a date or a zone (nothing due).
create function private.automatic_rsvp_reminder_due_at(
  wedding_date date,
  wedding_time_zone text,
  days_before smallint
)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case
    when automatic_rsvp_reminder_due_at.wedding_date is null
      or automatic_rsvp_reminder_due_at.wedding_time_zone is null
      or automatic_rsvp_reminder_due_at.days_before is null
      then null
    else pg_catalog.timezone(
      automatic_rsvp_reminder_due_at.wedding_time_zone,
      (automatic_rsvp_reminder_due_at.wedding_date - automatic_rsvp_reminder_due_at.days_before::integer)
        + time '10:00'
    )
  end;
$$;

revoke all on function private.automatic_rsvp_reminder_due_at(date, text, smallint) from public;

-- The party's CURRENT due time under its wedding's CURRENT policy (null when
-- there is no policy, date or zone).
create function private.automatic_rsvp_reminder_party_due_at(target_invitation_id uuid)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select private.automatic_rsvp_reminder_due_at(w.wedding_date, w.time_zone, p.days_before)
  from public.guest_invitations i
  join public.weddings w on w.id = i.wedding_id
  left join public.wedding_rsvp_reminder_policies p on p.wedding_id = i.wedding_id
  where i.id = automatic_rsvp_reminder_party_due_at.target_invitation_id;
$$;

revoke all on function private.automatic_rsvp_reminder_party_due_at(uuid) from public;

-- Current-truth eligibility (ADR-010 §7, E1–E3 and E5–E9): null = eligible,
-- otherwise the first pre-provider reason that stops it. E4 (due ≥
-- enabled_at) is the claim's entry rule and is applied there.
create function private.automatic_rsvp_reminder_ineligibility(target_invitation_id uuid)
returns public.automatic_rsvp_reminder_outcome_reason
language plpgsql
stable
set search_path = ''
as $$
declare
  v_party record;
  v_due timestamptz;
begin
  select i.id, i.wedding_id, i.token_hash, i.token_issued_at, i.revoked_at, i.contact_email,
         i.invitation_email_sent_at, i.rsvp_reminder_email_sent_at,
         w.wedding_date, w.time_zone, p.enabled, p.days_before
    into v_party
    from public.guest_invitations i
    join public.weddings w on w.id = i.wedding_id
    left join public.wedding_rsvp_reminder_policies p on p.wedding_id = i.wedding_id
   where i.id = automatic_rsvp_reminder_ineligibility.target_invitation_id;
  if not found then
    return 'link_unavailable';
  end if;

  -- E5: any saved answer for a current guest. Answering is the goal.
  if exists (
    select 1
    from public.rsvps r
    join public.guests g on g.id = r.guest_id and g.wedding_id = r.wedding_id
    where g.guest_invitation_id = v_party.id and g.wedding_id = v_party.wedding_id
  ) then
    return 'answered';
  end if;

  -- E1
  if not coalesce(v_party.enabled, false) then
    return 'policy_disabled';
  end if;

  -- E2, E3: a date and a zone, and inside [due, due + 48 h).
  v_due := private.automatic_rsvp_reminder_due_at(v_party.wedding_date, v_party.time_zone, v_party.days_before);
  if v_due is null or now() < v_due or now() >= v_due + interval '48 hours' then
    return 'out_of_window';
  end if;

  -- E7: not revoked, not expired.
  if v_party.revoked_at is not null
     or now() >= private.guest_invitation_expires_at(v_party.token_issued_at, v_party.wedding_date) then
    return 'link_unavailable';
  end if;

  -- E8: an envelope bound to the CURRENT hash (not legacy).
  if not exists (
    select 1
    from private.guest_invitation_capability_secrets s
    where s.guest_invitation_id = v_party.id
      and s.wedding_id = v_party.wedding_id
      and s.token_hash = v_party.token_hash
  ) then
    return 'link_unrecoverable';
  end if;

  -- E6
  if v_party.contact_email is null then
    return 'no_contact_email';
  end if;

  -- E9: a recorded reminder (either channel) or invitation within 7 days.
  if (v_party.rsvp_reminder_email_sent_at is not null
      and v_party.rsvp_reminder_email_sent_at > now() - interval '7 days')
     or (v_party.invitation_email_sent_at is not null
         and v_party.invitation_email_sent_at > now() - interval '7 days') then
    return 'recently_reminded';
  end if;

  return null;
end;
$$;

revoke all on function private.automatic_rsvp_reminder_ineligibility(uuid) from public;

-- ------------------------------------------------- set_rsvp_reminder_policy

-- The ONLY writer of a wedding's policy. Owners only, checked from auth.uid():
-- non-members get false (like a missing wedding); collaborators are refused.
-- Enabling requires the wedding's date and time zone; an off → on switch
-- stamps enabled_at with the database clock.
create function public.set_rsvp_reminder_policy(
  target_wedding_id uuid,
  reminders_enabled boolean,
  reminder_days_before integer
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_wedding public.weddings;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.is_wedding_member(set_rsvp_reminder_policy.target_wedding_id) then
    return false;
  end if;
  if not private.has_wedding_role(
    set_rsvp_reminder_policy.target_wedding_id,
    array['owner']::public.wedding_role[]
  ) then
    raise exception 'rsvp_reminder_policy_owner_only'
      using errcode = '42501',
            detail = 'Only wedding owners can configure automatic reminders.';
  end if;
  if set_rsvp_reminder_policy.reminders_enabled is null
     or set_rsvp_reminder_policy.reminder_days_before is null
     or set_rsvp_reminder_policy.reminder_days_before not in (14, 21, 30) then
    raise exception 'rsvp_reminder_policy_invalid' using errcode = '22023';
  end if;

  select * into v_wedding from public.weddings w where w.id = set_rsvp_reminder_policy.target_wedding_id;
  if set_rsvp_reminder_policy.reminders_enabled
     and (v_wedding.wedding_date is null or v_wedding.time_zone is null) then
    raise exception 'rsvp_reminder_policy_needs_date'
      using errcode = 'P0001',
            detail = 'Automatic reminders need the wedding date and time zone.';
  end if;

  insert into public.wedding_rsvp_reminder_policies as p
    (wedding_id, enabled, days_before, enabled_at, updated_by)
  values (
    set_rsvp_reminder_policy.target_wedding_id,
    set_rsvp_reminder_policy.reminders_enabled,
    set_rsvp_reminder_policy.reminder_days_before::smallint,
    case when set_rsvp_reminder_policy.reminders_enabled then now() end,
    auth.uid()
  )
  on conflict (wedding_id) do update
    set enabled = excluded.enabled,
        days_before = excluded.days_before,
        enabled_at = case when excluded.enabled and not p.enabled then now() else p.enabled_at end,
        updated_by = excluded.updated_by;
  return true;
end;
$$;

comment on function public.set_rsvp_reminder_policy(uuid, boolean, integer) is
  'Owners only (ADR-010 §5): turns a wedding''s automatic RSVP reminder on or off and picks days_before (14, 21, 30). The only writer of the policy.';

revoke all on function public.set_rsvp_reminder_policy(uuid, boolean, integer) from public, anon, authenticated;
grant execute on function public.set_rsvp_reminder_policy(uuid, boolean, integer) to authenticated;

-- ------------------------------------------- claim_automatic_rsvp_reminders

-- service_role only (ADR-010 §9). One transaction:
--   1. sweep rows NOT held by a live lease whose replay window or attempts
--      ran out → unknown;
--   2. record a skipped row (reason, no attempt) for each party that is due
--      now but fails a current pre-provider check, so organizers see why;
--   3. claim, ordered by due time, under the caps (≤ 50 per run, ≤ 25 per
--      wedding): new eligible parties (E1–E9 and due ≥ enabled_at), skipped
--      rows that may be reactivated (attempt_count = 0, remediable reason),
--      expired claims, due retries, and expired sends inside the replay rules;
--      party and occurrence rows are locked FOR UPDATE SKIP LOCKED (a party
--      with an RSVP in flight waits for the next run);
--   4. each claimed row gets a fresh claim token and a 10-minute lease;
--      attempt_count is never changed here.
-- Returns occurrence ids and claim tokens only: no capability material.
create function public.claim_automatic_rsvp_reminders(max_total integer, max_per_wedding integer)
returns table (occurrence_id uuid, occurrence_claim_token uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_total integer := least(greatest(coalesce(claim_automatic_rsvp_reminders.max_total, 0), 0), 50);
  v_per_wedding integer := least(greatest(coalesce(claim_automatic_rsvp_reminders.max_per_wedding, 0), 0), 25);
  v_candidate record;
  v_token uuid;
  v_id uuid;
begin
  -- 1. Sweep. A live lease is never touched: its worker decides it.
  update public.automatic_rsvp_reminders o
     set state = 'unknown',
         outcome_reason = case
           when now() >= o.first_attempt_at + interval '23 hours' then 'replay_window_expired'
           else 'attempts_exhausted'
         end::public.automatic_rsvp_reminder_outcome_reason,
         claim_token = null,
         lease_expires_at = null,
         next_attempt_at = null
   where o.id in (
     select s.id
     from public.automatic_rsvp_reminders s
     where s.attempt_count >= 1
       and (s.state = 'retry_wait'
            or (s.state in ('claimed', 'sending') and s.lease_expires_at <= now()))
       and (now() >= s.first_attempt_at + interval '23 hours'
            or (s.state = 'sending' and s.attempt_count >= 3))
     for update skip locked
   );

  -- 2. Due-time evaluation (ADR-010 §9, §26). A party that is due now
  -- (policy on, date and zone set, window open, due ≥ enabled_at) but fails
  -- a current pre-provider check gets a skipped row with that reason, so
  -- organizers see why nothing went out. No lease, no attempt: nothing is
  -- consumed, and remediable reasons are reactivated below once fixed.
  insert into public.automatic_rsvp_reminders (wedding_id, guest_invitation_id, state, outcome_reason, due_at)
  select i.wedding_id, i.id, 'skipped', e.reason, d.due_at
  from public.wedding_rsvp_reminder_policies p
  join public.weddings w on w.id = p.wedding_id
  cross join lateral (
    select private.automatic_rsvp_reminder_due_at(w.wedding_date, w.time_zone, p.days_before) as due_at
  ) d
  join public.guest_invitations i on i.wedding_id = p.wedding_id
  cross join lateral (
    select private.automatic_rsvp_reminder_ineligibility(i.id) as reason
  ) e
  where p.enabled
    and d.due_at is not null
    and d.due_at <= now()
    and now() < d.due_at + interval '48 hours'
    and d.due_at >= p.enabled_at
    and e.reason is not null
    and not exists (select 1 from public.automatic_rsvp_reminders o where o.guest_invitation_id = i.id)
  on conflict on constraint automatic_rsvp_reminders_one_per_party do nothing;

  if v_total = 0 or v_per_wedding = 0 then
    return;
  end if;

  -- 3. Candidates, by due time, capped per wedding and per run.
  for v_candidate in
    with policy_weddings as (
      select w.id as wedding_id,
             private.automatic_rsvp_reminder_due_at(w.wedding_date, w.time_zone, p.days_before) as due_at,
             p.enabled_at
      from public.wedding_rsvp_reminder_policies p
      join public.weddings w on w.id = p.wedding_id
      where p.enabled
    ),
    candidates as (
      -- In-flight rows whose worker is gone, or retries that are due.
      select o.id as existing_id, o.guest_invitation_id, o.wedding_id, o.due_at as sort_due
      from public.automatic_rsvp_reminders o
      where (o.state = 'claimed' and o.lease_expires_at <= now())
         or (o.state = 'retry_wait' and o.next_attempt_at <= now()
             and now() < o.first_attempt_at + interval '23 hours')
         or (o.state = 'sending' and o.lease_expires_at <= now() and o.attempt_count < 3
             and now() < o.first_attempt_at + interval '23 hours')
      union all
      -- Reactivation (ADR-010 §8b): only before any attempt, only remediable
      -- reasons, only when every current check passes. E4 applies except
      -- for policy_disabled (re-enabling resets enabled_at).
      select o.id, o.guest_invitation_id, o.wedding_id, pw.due_at
      from public.automatic_rsvp_reminders o
      join policy_weddings pw on pw.wedding_id = o.wedding_id
      where o.state = 'skipped'
        and o.attempt_count = 0
        and o.outcome_reason in ('no_contact_email', 'link_unrecoverable', 'link_unavailable',
                                 'policy_disabled', 'out_of_window')
        and pw.due_at is not null
        and (o.outcome_reason = 'policy_disabled' or pw.due_at >= pw.enabled_at)
        and private.automatic_rsvp_reminder_ineligibility(o.guest_invitation_id) is null
      union all
      -- New: parties never claimed, due now, never before the policy was enabled.
      select null::uuid, i.id, i.wedding_id, pw.due_at
      from public.guest_invitations i
      join policy_weddings pw on pw.wedding_id = i.wedding_id
      where pw.due_at is not null
        and pw.due_at <= now()
        and now() < pw.due_at + interval '48 hours'
        and pw.due_at >= pw.enabled_at
        and not exists (
          select 1 from public.automatic_rsvp_reminders o where o.guest_invitation_id = i.id
        )
        and private.automatic_rsvp_reminder_ineligibility(i.id) is null
    ),
    ranked as (
      select c.*,
             row_number() over (partition by c.wedding_id order by c.sort_due, c.guest_invitation_id) as rank_in_wedding
      from candidates c
    )
    select r.existing_id, r.guest_invitation_id, r.wedding_id, r.sort_due
    from ranked r
    where r.rank_in_wedding <= v_per_wedding
    order by r.sort_due, r.guest_invitation_id
    limit v_total
  loop
    v_id := null;

    -- The party first (an in-flight RSVP or another worker holds it → skip).
    perform 1
    from public.guest_invitations i
    where i.id = v_candidate.guest_invitation_id
    for update skip locked;
    if not found then
      continue;
    end if;

    v_token := gen_random_uuid();

    if v_candidate.existing_id is null then
      insert into public.automatic_rsvp_reminders
        (wedding_id, guest_invitation_id, state, due_at, claim_token, lease_expires_at)
      values (
        v_candidate.wedding_id,
        v_candidate.guest_invitation_id,
        'claimed',
        v_candidate.sort_due,
        v_token,
        now() + interval '10 minutes'
      )
      on conflict on constraint automatic_rsvp_reminders_one_per_party do nothing
      returning id into v_id;
    else
      -- Re-check claimability under the row lock: another worker may have
      -- taken or finished it since the candidates were read.
      update public.automatic_rsvp_reminders o
         set state = 'claimed',
             outcome_reason = null,
             claim_token = v_token,
             lease_expires_at = now() + interval '10 minutes',
             next_attempt_at = null,
             due_at = coalesce(v_candidate.sort_due, o.due_at)
       where o.id = (
         select s.id
         from public.automatic_rsvp_reminders s
         where s.id = v_candidate.existing_id
           and (
             (s.state = 'claimed' and s.lease_expires_at <= now())
             or (s.state = 'retry_wait' and s.next_attempt_at <= now()
                 and now() < s.first_attempt_at + interval '23 hours')
             or (s.state = 'sending' and s.lease_expires_at <= now() and s.attempt_count < 3
                 and now() < s.first_attempt_at + interval '23 hours')
             or (s.state = 'skipped' and s.attempt_count = 0
                 and s.outcome_reason in ('no_contact_email', 'link_unrecoverable', 'link_unavailable',
                                          'policy_disabled', 'out_of_window'))
           )
         for update skip locked
       )
      returning o.id into v_id;
    end if;

    if v_id is null then
      continue;
    end if;

    occurrence_id := v_id;
    occurrence_claim_token := v_token;
    return next;
  end loop;
end;
$$;

comment on function public.claim_automatic_rsvp_reminders(integer, integer) is
  'service_role only (ADR-010 §9): sweeps expired uncertain rows, then claims due occurrences under the caps with SKIP LOCKED, a fresh claim token and a 10-minute lease. Returns ids and claim tokens only.';

revoke all on function public.claim_automatic_rsvp_reminders(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_automatic_rsvp_reminders(integer, integer) to service_role;

-- ----------------------------------------- prepare_automatic_rsvp_reminder

-- service_role only (ADR-010 §10.1). Requires the current claim token and a
-- live lease on a claimed row. Re-evaluates current eligibility:
--   * ineligible, no attempt yet       → skipped (reason), lease cleared;
--   * ineligible after an attempt      → unknown (ineligible_after_attempt);
--   * past the 23 h replay window      → unknown (replay_window_expired);
--   * eligible → lease renewed; returns the CURRENT hash, envelope, contact
--     email, party label, wedding name/date/city and published slug.
-- Consumes no attempt and calls no provider. status: ready | skipped |
-- unknown | stale.
create function public.prepare_automatic_rsvp_reminder(
  target_occurrence_id uuid,
  occurrence_claim_token uuid
)
returns table (
  status text,
  current_token_hash text,
  current_token_ciphertext text,
  current_recipient text,
  current_party_label text,
  current_wedding_name text,
  current_wedding_date date,
  current_wedding_city text,
  current_site_slug text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_occurrence public.automatic_rsvp_reminders;
  v_reason public.automatic_rsvp_reminder_outcome_reason;
begin
  select * into v_occurrence
  from public.automatic_rsvp_reminders o
  where o.id = prepare_automatic_rsvp_reminder.target_occurrence_id
  for update;

  if not found
     or v_occurrence.state <> 'claimed'
     or v_occurrence.claim_token is distinct from prepare_automatic_rsvp_reminder.occurrence_claim_token
     or v_occurrence.lease_expires_at <= now() then
    status := 'stale';
    return next;
    return;
  end if;

  if v_occurrence.attempt_count >= 1 and now() >= v_occurrence.first_attempt_at + interval '23 hours' then
    update public.automatic_rsvp_reminders o
       set state = 'unknown', outcome_reason = 'replay_window_expired',
           claim_token = null, lease_expires_at = null
     where o.id = v_occurrence.id;
    status := 'unknown';
    return next;
    return;
  end if;

  v_reason := private.automatic_rsvp_reminder_ineligibility(v_occurrence.guest_invitation_id);
  if v_reason is not null then
    if v_occurrence.attempt_count = 0 then
      update public.automatic_rsvp_reminders o
         set state = 'skipped', outcome_reason = v_reason,
             claim_token = null, lease_expires_at = null
       where o.id = v_occurrence.id;
      status := 'skipped';
    else
      update public.automatic_rsvp_reminders o
         set state = 'unknown', outcome_reason = 'ineligible_after_attempt',
             claim_token = null, lease_expires_at = null
       where o.id = v_occurrence.id;
      status := 'unknown';
    end if;
    return next;
    return;
  end if;

  update public.automatic_rsvp_reminders o
     set lease_expires_at = now() + interval '10 minutes',
         due_at = coalesce(private.automatic_rsvp_reminder_party_due_at(o.guest_invitation_id), o.due_at)
   where o.id = v_occurrence.id;

  select i.token_hash, s.token_ciphertext, i.contact_email, i.label,
         w.name, w.wedding_date, w.city,
         case when pub.published_at is not null then pub.slug end
    into current_token_hash, current_token_ciphertext, current_recipient, current_party_label,
         current_wedding_name, current_wedding_date, current_wedding_city, current_site_slug
    from public.guest_invitations i
    join public.weddings w on w.id = i.wedding_id
    join private.guest_invitation_capability_secrets s
      on s.guest_invitation_id = i.id and s.wedding_id = i.wedding_id and s.token_hash = i.token_hash
    left join public.wedding_publications pub on pub.wedding_id = i.wedding_id
   where i.id = v_occurrence.guest_invitation_id
     and i.wedding_id = v_occurrence.wedding_id;

  status := 'ready';
  return next;
end;
$$;

comment on function public.prepare_automatic_rsvp_reminder(uuid, uuid) is
  'service_role only (ADR-010 §10.1): re-checks current eligibility for one claimed occurrence and returns its CURRENT capability and render context. Consumes no attempt.';

revoke all on function public.prepare_automatic_rsvp_reminder(uuid, uuid) from public, anon, authenticated;
grant execute on function public.prepare_automatic_rsvp_reminder(uuid, uuid) to service_role;

-- ------------------------------------- begin_automatic_rsvp_reminder_send

-- service_role only (ADR-010 §10.3): THE provider boundary. One short
-- transaction; no provider call happens inside it.
--   1. locks the party row (waits for an in-flight RSVP to commit), then the
--      occurrence row;
--   2. requires a claimed row, the current token and a live lease; after an
--      earlier attempt, refuses past the 23 h replay window;
--   3. re-checks current eligibility (E1–E3, E5–E9), and that the hash and
--      recipient the worker is about to use are still current;
--   4. on success: claimed → sending, attempt_count + 1, first_attempt_at on
--      the first attempt, lease renewed. Its return authorizes exactly ONE
--      provider call.
-- status: sending | skipped | unknown | stale | context_changed (the hash or
-- recipient changed since prepare: nothing is consumed, the lease is
-- released, and the next run prepares again from current truth).
create function public.begin_automatic_rsvp_reminder_send(
  target_occurrence_id uuid,
  occurrence_claim_token uuid,
  expected_token_hash text,
  expected_recipient text
)
returns table (status text, attempt_number integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_party_id uuid;
  v_occurrence public.automatic_rsvp_reminders;
  v_party public.guest_invitations;
  v_reason public.automatic_rsvp_reminder_outcome_reason;
begin
  select o.guest_invitation_id into v_party_id
  from public.automatic_rsvp_reminders o
  where o.id = begin_automatic_rsvp_reminder_send.target_occurrence_id;
  if not found then
    status := 'stale';
    return next;
    return;
  end if;

  -- Party first (same order as record): an RSVP save holding it commits first.
  select * into v_party from public.guest_invitations i where i.id = v_party_id for update;

  select * into v_occurrence
  from public.automatic_rsvp_reminders o
  where o.id = begin_automatic_rsvp_reminder_send.target_occurrence_id
  for update;

  if not found
     or v_party.id is null
     or v_occurrence.state <> 'claimed'
     or v_occurrence.claim_token is distinct from begin_automatic_rsvp_reminder_send.occurrence_claim_token
     or v_occurrence.lease_expires_at <= now() then
    status := 'stale';
    return next;
    return;
  end if;

  if v_occurrence.attempt_count >= 1 and now() >= v_occurrence.first_attempt_at + interval '23 hours' then
    update public.automatic_rsvp_reminders o
       set state = 'unknown', outcome_reason = 'replay_window_expired',
           claim_token = null, lease_expires_at = null
     where o.id = v_occurrence.id;
    status := 'unknown';
    return next;
    return;
  end if;

  v_reason := private.automatic_rsvp_reminder_ineligibility(v_occurrence.guest_invitation_id);
  if v_reason is not null then
    if v_occurrence.attempt_count = 0 then
      update public.automatic_rsvp_reminders o
         set state = 'skipped', outcome_reason = v_reason,
             claim_token = null, lease_expires_at = null
       where o.id = v_occurrence.id;
      status := 'skipped';
    else
      update public.automatic_rsvp_reminders o
         set state = 'unknown', outcome_reason = 'ineligible_after_attempt',
             claim_token = null, lease_expires_at = null
       where o.id = v_occurrence.id;
      status := 'unknown';
    end if;
    return next;
    return;
  end if;

  if v_party.token_hash is distinct from begin_automatic_rsvp_reminder_send.expected_token_hash
     or v_party.contact_email is distinct from begin_automatic_rsvp_reminder_send.expected_recipient then
    update public.automatic_rsvp_reminders o
       set lease_expires_at = now()
     where o.id = v_occurrence.id;
    status := 'context_changed';
    return next;
    return;
  end if;

  update public.automatic_rsvp_reminders o
     set state = 'sending',
         attempt_count = o.attempt_count + 1,
         first_attempt_at = coalesce(o.first_attempt_at, now()),
         lease_expires_at = now() + interval '10 minutes',
         due_at = coalesce(private.automatic_rsvp_reminder_party_due_at(o.guest_invitation_id), o.due_at)
   where o.id = v_occurrence.id
  returning o.attempt_count into attempt_number;

  status := 'sending';
  return next;
end;
$$;

comment on function public.begin_automatic_rsvp_reminder_send(uuid, uuid, text, text) is
  'service_role only (ADR-010 §10.3, §11): locks and re-checks current truth, then claimed → sending and attempt_count + 1. The provider boundary; authorizes exactly one provider call.';

revoke all on function public.begin_automatic_rsvp_reminder_send(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.begin_automatic_rsvp_reminder_send(uuid, uuid, text, text) to service_role;

-- ----------------------------------- record_automatic_rsvp_reminder_email

-- service_role only (ADR-010 §13, §19, §20). After the provider accepted, in
-- ONE transaction:
--   * the occurrence must be sending under the current claim token;
--   * the hash must still be the party's CURRENT, usable link and the
--     recipient its CURRENT contact email (same rules as the manual record);
--   * writes the latest-reminder metadata (shared with manual reminders);
--   * appends rsvp_reminder_email_sent with actor system (no user id: no
--     member clicked it);
--   * sending → sent, sent_at = database clock, lease cleared.
-- Anything else raises automatic_rsvp_reminder_not_recorded and changes
-- nothing (the caller then reports sent_unrecorded through finish).
create function public.record_automatic_rsvp_reminder_email(
  target_occurrence_id uuid,
  occurrence_claim_token uuid,
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
  v_party_id uuid;
  v_occurrence public.automatic_rsvp_reminders;
  v_sent_at timestamptz;
begin
  if record_automatic_rsvp_reminder_email.provider_message_id is null
     or record_automatic_rsvp_reminder_email.provider_message_id !~ '^[A-Za-z0-9._:-]{1,200}$' then
    raise exception 'automatic_rsvp_reminder_not_recorded' using errcode = '22023';
  end if;

  select o.guest_invitation_id into v_party_id
  from public.automatic_rsvp_reminders o
  where o.id = record_automatic_rsvp_reminder_email.target_occurrence_id;
  if not found then
    raise exception 'automatic_rsvp_reminder_not_recorded' using errcode = 'P0001';
  end if;

  perform 1 from public.guest_invitations i where i.id = v_party_id for update;

  select * into v_occurrence
  from public.automatic_rsvp_reminders o
  where o.id = record_automatic_rsvp_reminder_email.target_occurrence_id
  for update;

  if not found
     or v_occurrence.state <> 'sending'
     or v_occurrence.claim_token is distinct from record_automatic_rsvp_reminder_email.occurrence_claim_token then
    raise exception 'automatic_rsvp_reminder_not_recorded' using errcode = 'P0001';
  end if;

  update public.guest_invitations i
     set rsvp_reminder_email_sent_at = now(),
         rsvp_reminder_email_sent_to = i.contact_email,
         rsvp_reminder_email_provider_id = record_automatic_rsvp_reminder_email.provider_message_id
    from public.weddings w
   where w.id = i.wedding_id
     and i.id = v_occurrence.guest_invitation_id
     and i.wedding_id = v_occurrence.wedding_id
     and i.token_hash = record_automatic_rsvp_reminder_email.invitation_token_hash
     and i.revoked_at is null
     and now() < private.guest_invitation_expires_at(i.token_issued_at, w.wedding_date)
     and i.contact_email is not null
     and i.contact_email = record_automatic_rsvp_reminder_email.recipient
  returning i.rsvp_reminder_email_sent_at into v_sent_at;

  if not found then
    raise exception 'automatic_rsvp_reminder_not_recorded' using errcode = 'P0001';
  end if;

  insert into public.wedding_activity (wedding_id, event_type, guest_invitation_id, actor_kind, actor_user_id)
  values (v_occurrence.wedding_id, 'rsvp_reminder_email_sent', v_occurrence.guest_invitation_id, 'system', null);

  update public.automatic_rsvp_reminders o
     set state = 'sent', sent_at = v_sent_at, claim_token = null, lease_expires_at = null
   where o.id = v_occurrence.id;

  return v_sent_at;
end;
$$;

comment on function public.record_automatic_rsvp_reminder_email(uuid, uuid, text, text, text) is
  'service_role only (ADR-010): after the provider accepted, atomically writes the latest-reminder metadata, the system activity row and sending → sent. Raises (changing nothing) otherwise.';

revoke all on function public.record_automatic_rsvp_reminder_email(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.record_automatic_rsvp_reminder_email(uuid, uuid, text, text, text) to service_role;

-- ---------------------------------------- finish_automatic_rsvp_reminder

-- service_role only (ADR-010 §13). Every non-success outcome, closed:
--   * link_unrecoverable (claimed; decryption failed before the provider):
--       skipped (link_unrecoverable) with no attempt, else
--       unknown (ineligible_after_attempt);
--   * sent_unrecorded (sending)    → sent_unrecorded (terminal);
--   * retry (sending)              → retry_wait in 1 h while attempts < 3
--       and inside the 23 h window; else unknown (attempts_exhausted /
--       replay_window_expired);
--   * recipient_rejected (sending) → failed (recipient_rejected);
--   * idempotency_conflict (sending) → unknown (idempotency_conflict).
-- Requires the current claim token: a stale worker changes nothing and gets
-- null back. Returns the resulting state.
create function public.finish_automatic_rsvp_reminder(
  target_occurrence_id uuid,
  occurrence_claim_token uuid,
  outcome public.automatic_rsvp_reminder_finish_outcome
)
returns public.automatic_rsvp_reminder_state
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_occurrence public.automatic_rsvp_reminders;
  v_state public.automatic_rsvp_reminder_state;
  v_reason public.automatic_rsvp_reminder_outcome_reason;
  v_next timestamptz;
begin
  select * into v_occurrence
  from public.automatic_rsvp_reminders o
  where o.id = finish_automatic_rsvp_reminder.target_occurrence_id
  for update;

  if not found
     or finish_automatic_rsvp_reminder.outcome is null
     or v_occurrence.claim_token is distinct from finish_automatic_rsvp_reminder.occurrence_claim_token then
    return null;
  end if;

  if finish_automatic_rsvp_reminder.outcome = 'link_unrecoverable' then
    if v_occurrence.state <> 'claimed' then
      return null;
    end if;
    if v_occurrence.attempt_count = 0 then
      v_state := 'skipped';
      v_reason := 'link_unrecoverable';
    else
      v_state := 'unknown';
      v_reason := 'ineligible_after_attempt';
    end if;
  else
    if v_occurrence.state <> 'sending' then
      return null;
    end if;
    case finish_automatic_rsvp_reminder.outcome
      when 'sent_unrecorded' then
        v_state := 'sent_unrecorded';
      when 'recipient_rejected' then
        v_state := 'failed';
        v_reason := 'recipient_rejected';
      when 'idempotency_conflict' then
        v_state := 'unknown';
        v_reason := 'idempotency_conflict';
      else -- retry
        if now() >= v_occurrence.first_attempt_at + interval '23 hours' then
          v_state := 'unknown';
          v_reason := 'replay_window_expired';
        elsif v_occurrence.attempt_count >= 3 then
          v_state := 'unknown';
          v_reason := 'attempts_exhausted';
        else
          v_state := 'retry_wait';
          v_next := now() + interval '1 hour';
        end if;
    end case;
  end if;

  update public.automatic_rsvp_reminders o
     set state = v_state,
         outcome_reason = v_reason,
         next_attempt_at = v_next,
         claim_token = null,
         lease_expires_at = null
   where o.id = v_occurrence.id;
  return v_state;
end;
$$;

comment on function public.finish_automatic_rsvp_reminder(uuid, uuid, public.automatic_rsvp_reminder_finish_outcome) is
  'service_role only (ADR-010 §13): records a closed non-success outcome for the current claim. Stale workers change nothing.';

revoke all on function public.finish_automatic_rsvp_reminder(uuid, uuid, public.automatic_rsvp_reminder_finish_outcome)
  from public, anon, authenticated;
grant execute on function public.finish_automatic_rsvp_reminder(uuid, uuid, public.automatic_rsvp_reminder_finish_outcome)
  to service_role;
