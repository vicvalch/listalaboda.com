-- LB-18.4 (part 2 of 2): automatic reminder suppression for undeliverable
-- recipients, and a recipient-aware recently_reminded (ADR-010 §7, §8b, §18;
-- ADR-011 §8, §10).
--
-- Two changes to ONE function, private.automatic_rsvp_reminder_ineligibility,
-- the current-truth check that claim, prepare and begin already share (so the
-- new rule is evaluated at claim, re-checked at prepare and again at begin,
-- the provider boundary, with no new call site):
--
-- 1. E11 recipient_undeliverable: the party's CURRENT contact email has a
--    suppressed, bounced or complained delivery in the SAME wedding, decided by
--    LB-18.3's private.email_recipient_block (the very determination behind
--    the members' warning and the manual send guard; email_deliveries.status
--    only, never the event history or a provider-wide list; addresses compared
--    in their comparison form: trim + lowercase of the whole address).
--    accepted / delayed / failed / delivered never block.
--
-- 2. E9 recently_reminded, scoped to the CURRENT address: only a recorded
--    invitation or reminder (either channel; the same three sends as LB-17,
--    never the RSVP confirmation) sent within 7 days TO the current contact
--    email (comparison form) counts. Evidence: the latest-send metadata
--    (*_sent_at + *_sent_to, as before) and the party's own ledger rows of
--    those kinds (accepted_at + recipient), so an interleaved send to another
--    address can't hide a recent send to this one. Every send counted here
--    was already counted by the LB-17 rule (a ledger row inside 7 days implies
--    its *_sent_at is too): the rule only narrows, by recipient.
--
-- Precedence (first match wins; unchanged, plus E11 between E6 and E9):
--   answered → policy_disabled → out_of_window → link_unavailable →
--   link_unrecoverable → no_contact_email → recipient_undeliverable →
--   recently_reminded.
--
-- recipient_undeliverable is a PRE-PROVIDER reason: state skipped,
-- attempt_count = 0, no begin, no provider call, no metadata, activity or
-- ledger row. It is remediable (ADR-010 §8b): a genuinely different, clean
-- current address reactivates the same row; a case-only edit is the same
-- address and does not. After an attempt the existing rule applies unchanged
-- (unknown, ineligible_after_attempt). Delivery status never rewrites an
-- occurrence (sent stays sent): it only informs FUTURE eligibility.
--
-- Unchanged: states, attempts, leases, the provider boundary, idempotency
-- keys, replay window, sent_unrecorded, prepare/begin/record/finish, grants,
-- the manual send guard, the RSVP confirmation and the webhook. No row is
-- rewritten by this migration.

-- ------------------------------------------------------------ the CHECK

alter table public.automatic_rsvp_reminders
  drop constraint automatic_rsvp_reminders_reason_by_state;

alter table public.automatic_rsvp_reminders
  add constraint automatic_rsvp_reminders_reason_by_state check (
    case state
      when 'skipped' then coalesce(outcome_reason in (
        'answered', 'no_contact_email', 'link_unavailable', 'link_unrecoverable',
        'recently_reminded', 'policy_disabled', 'out_of_window', 'recipient_undeliverable'), false)
      when 'failed' then coalesce(outcome_reason = 'recipient_rejected', false)
      when 'unknown' then coalesce(outcome_reason in (
        'ineligible_after_attempt', 'idempotency_conflict', 'attempts_exhausted',
        'replay_window_expired'), false)
      else outcome_reason is null
    end
  );

-- ------------------------------------------------------- the eligibility

-- Current-truth eligibility (ADR-010 §7, E1–E3, E5–E9 and E11): null = eligible,
-- otherwise the first pre-provider reason that stops it. E4 (due ≥
-- enabled_at) is the claim's entry rule and is applied there.
create or replace function private.automatic_rsvp_reminder_ineligibility(target_invitation_id uuid)
returns public.automatic_rsvp_reminder_outcome_reason
language plpgsql
stable
set search_path = ''
as $$
declare
  v_party record;
  v_due timestamptz;
  v_recipient text;
begin
  select i.id, i.wedding_id, i.token_hash, i.token_issued_at, i.revoked_at, i.contact_email,
         i.invitation_email_sent_at, i.invitation_email_sent_to,
         i.rsvp_reminder_email_sent_at, i.rsvp_reminder_email_sent_to,
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

  -- E11 (LB-18.4): the current address is locally known as undeliverable in
  -- this wedding: the same determination as the members' warning and the
  -- manual send guard (LB-18.3).
  if private.email_recipient_block(v_party.wedding_id, v_party.contact_email) <> 'none' then
    return 'recipient_undeliverable';
  end if;

  -- E9 (recipient-aware since LB-18.4): a recorded reminder (either channel)
  -- or invitation sent to the CURRENT address within 7 days.
  v_recipient := private.email_comparison_form(v_party.contact_email);
  if (v_party.rsvp_reminder_email_sent_at > now() - interval '7 days'
      and private.email_comparison_form(v_party.rsvp_reminder_email_sent_to) = v_recipient)
     or (v_party.invitation_email_sent_at > now() - interval '7 days'
         and private.email_comparison_form(v_party.invitation_email_sent_to) = v_recipient)
     or exists (
       select 1
       from public.email_deliveries d
       where d.guest_invitation_id = v_party.id
         and d.wedding_id = v_party.wedding_id
         and d.kind in ('guest_invitation', 'rsvp_reminder_manual', 'rsvp_reminder_automatic')
         and d.accepted_at > now() - interval '7 days'
         and private.email_comparison_form(d.recipient) = v_recipient
     ) then
    return 'recently_reminded';
  end if;

  return null;
end;
$$;

revoke all on function private.automatic_rsvp_reminder_ineligibility(uuid) from public;

-- --------------------------------------------- claim (reactivation list)

-- Unchanged except that recipient_undeliverable joins the remediable skip
-- reasons (ADR-010 §8b): reactivated only before any attempt and only when
-- every current check passes, i.e. the current address is genuinely
-- different (comparison form) and not itself blocked. E4 applies.
create or replace function public.claim_automatic_rsvp_reminders(max_total integer, max_per_wedding integer)
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
                                 'policy_disabled', 'out_of_window', 'recipient_undeliverable')
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
                                          'policy_disabled', 'out_of_window', 'recipient_undeliverable'))
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
