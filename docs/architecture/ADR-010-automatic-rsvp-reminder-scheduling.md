# ADR-010 — Automatic RSVP Reminder Scheduling

Status: Accepted for implementation design (LB-17) · Date: 2026-10-05 · **Cron activation requires separate
deployment approval** (§24)
Implementation: LB-17 implements this decision (migration `20261012120000_lb_automatic_rsvp_reminders`); the
production cron entry and `CRON_SECRET` are NOT activated by it. Three clarifications made during implementation are
marked *Implementation note* below (§9 step 2, §10.1, §10.3).
Activation (LB-17A.2, zero-send): the hourly `vercel.json` cron entry and a Production `CRON_SECRET` are the scheduler
infrastructure only. Automatic sending stays operationally disabled: every reminder policy is OFF (none may be enabled
in this step), and production email delivery is blocked until the sending domain (`listalaboda.com`) is owned and
verified with the provider.
Related: [ADR-002 §5, §6](ADR-002-auth-and-security-boundaries.md), [ADR-004](ADR-004-invitation-delivery-recorder.md),
[ADR-005](ADR-005-rsvp-confirmation-email.md), [ADR-006](ADR-006-recoverable-rsvp-capability.md),
[ADR-007](ADR-007-manual-rsvp-reminder-delivery.md), [ADR-008](ADR-008-basic-activity-history.md),
[Product Constitution §8, §10](../product/PRODUCT-CONSTITUTION.md)

## Context

Constitution §8 lists "RSVP reminders" in Phase 2. LB-14 (ADR-007) shipped them as explicit organizer actions, and
ADR-007 §7 / ADR-008 §12 deferred scheduling because "nobody's session is present at 3 a.m."

The manual reminder's authority can't be reused for autonomous execution:

- **Authorization is the member's session.** `sendRsvpReminderEmail` starts with `requireWeddingMembership`
  (`auth.getUser()`). A scheduler has no user and no JWT.
- **Recovery is member-scoped in the database.** `get_guest_invitation_recovery_envelope` returns rows only when
  `auth.uid() is not null and private.is_wedding_member(...)`. Without a session it returns nothing, by design
  (ADR-006 §6).
- **The recorder attributes a member.** `record_rsvp_reminder_email` requires `acting_user_id`, a member of the
  wedding (ADR-008 §6). No member clicked an automatic send; passing one would be a lie.
- **Manual sends are at-least-once from the user's side, with no retries.** A human sees `sent_but_unrecorded` and
  decides. An unattended worker that crashes, times out or runs twice needs durable dedupe and an explicit
  uncertainty model instead.

Infrastructure at the time of this decision (verified in the repository): no cron, queue, worker, Edge Function,
`vercel.json` or Postgres extension exists. GitHub Actions is CI only. ADR-002 §1 names Vercel as hosting.

## Goals

- **Exactly one safe automatic reminder opportunity per unanswered party**: at most one automatic reminder per
  GuestInvitation whose execution crossed the email-provider boundary (§11).
- The same capability rules as manual reminders: the party's CURRENT recoverable link, the CURRENT contact email,
  re-checked immediately before the provider call; never generate, rotate, revoke or store a token.
- Nothing is sent unless an owner explicitly opted in and the deployment's scheduler is explicitly activated.
- Every uncertain outcome is terminal for automation and visible to organizers.

## Non-goals

- Recurring reminders, multiple stages, organizer-picked send dates or times.
- WhatsApp automation or any messaging API (ADR-007 §6 stands).
- A generic queue, job, outbox or worker framework.
- Per-party overrides (exclude/include a party).
- Bounce, complaint or delivery webhooks.
- Reminders to parties that already answered.

## Decision

### 1. Authority

Automatic sends rest on two independent, explicit authorizations, and nothing else:

1. **Owner opt-in** for one wedding (§5), recorded with the owner's identity and the database clock.
2. **The trusted deployment scheduler**: a server-side route that only the deployment's cron can call (§4), using
   a narrow service-role store (§21).

Never member impersonation: no minted session, no borrowed JWT, no `acting_user_id`. The owner who enabled the
policy is not the actor of each send; the policy is standing consent, not a click.

### 2. Scheduler identity

**System.** In activity history an automatic send is `actor_kind = 'system'`, `actor_user_id = null` (§20). The
scheduler never claims a human clicked anything.

### 3. Infrastructure

- **Vercel Cron**, **hourly**, **production deployments only**, invoking `GET /api/cron/rsvp-reminders`.
- Vercel Cron issues GET and sends `Authorization: Bearer <CRON_SECRET>` when `CRON_SECRET` is set. These semantics
  and hourly scheduling on the intended Pro deployment are treated as **verified external assumptions**.
- Rejected: database-native scheduling (pg_cron/pg_net, Edge Functions); see Rejected alternatives.

### 4. Scheduler endpoint security

- **Method:** GET only (Vercel Cron's method); every other method → 405. This is the one sanctioned side-effecting
  GET; its effects are idempotent through the database (§9–§12).
- **Authentication:** `Authorization: Bearer <CRON_SECRET>`, compared in constant time (`timingSafeEqual` over
  SHA-256 digests). `CRON_SECRET` must be present, at least 32 bytes and never `NEXT_PUBLIC_*`. Missing or malformed
  → 503 before any database access; mismatch → 401, empty body.
- **Cron auth module: `src/lib/scheduler/cron-auth.ts`**, `import "server-only"`, the ONLY module allowed to read
  `process.env.CRON_SECRET` (ESLint-enforced). Its responsibilities are limited to: parsing the `CRON_SECRET`
  configuration, enforcing the minimum secret requirements, and validating the `Authorization: Bearer` header with a
  timing-safe comparison. It must NOT create a Supabase client, read `SUPABASE_SERVICE_ROLE_KEY`, call scheduler RPCs,
  call `EmailSender`, contain business policy or execute the scheduler. The route calls it first and calls the runner
  only after it accepted the request.
- **No query-string secret.** Query parameters are ignored entirely; they never carry a secret or select work.
- **No browser surface.** No cookies or session are read; `/api/cron` is excluded from the `src/proxy.ts` matcher.
  `dynamic = "force-dynamic"`, `Cache-Control: no-store`.
- **Safe output and logging:** the response and logs carry counts only (`claimed`, `sent`, `skipped`, `retry`,
  `failed`, `unrecorded`, `unknown`). Never ids, labels, addresses, tokens, hashes, envelopes or provider ids.
- **Replay tolerance:** concurrent or repeated invocations are safe; claims (§9) decide who does what.
- **Timeouts:**
  - route `maxDuration = 60` seconds;
  - internal runner budget **45 seconds**: no new claim, prepare or begin starts after it (an already begun provider
    call is allowed to finish within its own timeout);
  - the automatic RSVP reminder runner invokes the provider with a maximum **10-second** timeout (it passes
    `timeoutMs` explicitly). The provider interface only *supports* an optional timeout; LB-17 owns this 10-second
    policy, and other email flows (invitation, RSVP confirmation, manual reminder) pass none and are unchanged;
  - all of them are far inside the 10-minute lease (§9).

  A provider timeout does not prove whether the provider received the request. After the provider boundary (§11) it
  is handled conservatively, as a possibly-delivered attempt, through the stable idempotency key and the
  retry-window rules (§12, §13).

### 5. Policy

`public.wedding_rsvp_reminder_policies`, one row per wedding:

| Column | Meaning |
|---|---|
| `wedding_id` | PK; FK to `weddings`, `on delete cascade` |
| `enabled` | `not null default false` |
| `days_before` | `smallint not null default 21`, `check (days_before in (14, 21, 30))` |
| `enabled_at` | database clock, set on every off → on transition; null while never enabled |
| `updated_by` | FK to `auth.users`, `on delete set null` |
| `updated_at` | database clock |

- **Default OFF.** No row = disabled. The migration inserts zero rows.
- **Owner-only.** The only writer is `set_rsvp_reminder_policy(wedding, enabled, days_before)`: SECURITY DEFINER,
  `search_path = ''`, owner-checked from `auth.uid()` (`has_wedding_role(owner)`; non-member → no effect), reached
  through a service that also calls `requireWeddingRole`. Clients have no INSERT/UPDATE/DELETE grant; members SELECT
  through RLS (enabled in the same migration). Collaborators see the policy and statuses, read-only.
- Enabling requires a wedding date and a wedding time zone (refused otherwise, with an explanation). Disabling is
  immediate; in-flight occurrences are stopped by the begin re-check (§10).
- Why owner-only: it causes outbound email in the couple's name with no click, wedding-wide; that is like settings
  and publishing (owner-only), not like a per-click manual reminder (any member).

### 6. Timing and time zone

- One reminder stage: **`days_before` days before the wedding, at 10:00 wedding-local time.**
- `due_at = ((weddings.wedding_date − days_before) + time '10:00') AT TIME ZONE weddings.time_zone`, computed by
  PostgreSQL from CURRENT rows whenever eligibility is evaluated (just in time; never pre-generated).
- **Window:** sendable while `due_at ≤ now() < due_at + 48 h`.
- **No retroactive sends:** a party that has never been claimed is claimable only if `due_at ≥ policy.enabled_at`.
  (One narrow exception for reactivation, §8b.)
- **Time zone source of truth:** `weddings.time_zone` (IANA, database-validated, LB-08). Null zone or null date →
  nothing is due. Never server, browser, UTC or IP time. A pure TypeScript mirror (like `@/lib/guests/link` for link
  expiry) only labels "programado para …" in the UI.

### 7. Eligibility (current truth)

Evaluated at claim, at prepare and again at begin, always from current rows. A party is eligible only if ALL hold:

| # | Condition | Read from |
|---|---|---|
| E1 | Policy row exists and `enabled` | `wedding_rsvp_reminder_policies` |
| E2 | Wedding has `wedding_date` and `time_zone` | `weddings` |
| E3 | Window open: `due_at ≤ now() < due_at + 48 h` | computed |
| E4 | New claims only: `due_at ≥ enabled_at` (waived only per §8b) | computed |
| E5 | No saved RSVP for any current guest of the party | `rsvps` ⋈ `guests` |
| E6 | `contact_email` is not null | `guest_invitations` |
| E7 | Link not revoked and not expired (`private.guest_invitation_expires_at`) | `guest_invitations`, `weddings` |
| E8 | An envelope bound to the CURRENT `token_hash` exists (not legacy) | `private.guest_invitation_capability_secrets` |
| E9 | No `rsvp_reminder_email_sent_at` and no `invitation_email_sent_at` within the last 7 days | `guest_invitations` |
| E10 | The occurrence is absent, or in a claimable state (§9) | `automatic_rsvp_reminders` |

The wedding site need not be published; the email links the site only while it is (existing renderer rule).
At begin, two more checks bind the send to what the worker is about to use: the hash it decrypted is still the
current `token_hash`, and the recipient it rendered is still the current `contact_email`.

### 8. Data model: occurrences

`public.automatic_rsvp_reminders`, the occurrence, claim and outcome record:

| Column | Meaning |
|---|---|
| `id` | uuid PK; basis of the provider idempotency key (§12) |
| `wedding_id`, `guest_invitation_id` | not null; composite FK `(guest_invitation_id, wedding_id)` → `guest_invitations`, `on delete cascade` |
| `state` | enum `automatic_rsvp_reminder_state` (below) |
| `outcome_reason` | closed enum `automatic_rsvp_reminder_outcome_reason`; non-null exactly in `skipped`, `failed` and `unknown` (below); never free text |
| `due_at` | the last computed `due_at` (display/audit only; truth is always recomputed) |
| `claim_token` | uuid, fresh on every claim; null in non-leased states |
| `lease_expires_at` | null in non-leased states |
| `attempt_count` | `smallint not null default 0`, `check (attempt_count between 0 and 3)` (§11) |
| `first_attempt_at` | database clock at the first provider attempt; null while `attempt_count = 0` |
| `next_attempt_at` | only in `retry_wait` |
| `sent_at` | only in `sent`; database clock |
| `created_at`, `updated_at` | database clock |

**`UNIQUE (guest_invitation_id)`**: one occurrence row per GuestInvitation, ever. A second row is never created;
re-entry reuses the row (§8a).

**States** (`automatic_rsvp_reminder_state`):

| State | Meaning | Terminal for automation? |
|---|---|---|
| `claimed` | leased to a worker; no provider attempt in progress | no |
| `sending` | begin succeeded; the provider boundary **may** have been crossed (§11) | no |
| `retry_wait` | a provider attempt failed transiently; replay later with the same key | no |
| `sent` | provider accepted AND the record committed (metadata + activity) | yes |
| `sent_unrecorded` | provider accepted; the record did not commit | yes |
| `skipped` | stopped BEFORE any provider attempt (`attempt_count = 0`) | only if not reactivatable (§8b) |
| `failed` | the provider definitively rejected the message after an actual attempt | yes |
| `unknown` | the application cannot prove that no email was sent (§15) | yes |

**Outcome reasons** (`automatic_rsvp_reminder_outcome_reason`), closed, twelve values:

| Reason | Class | Allowed only with |
|---|---|---|
| `answered` | pre-provider eligibility | `skipped` |
| `no_contact_email` | pre-provider eligibility | `skipped` |
| `link_unavailable` | pre-provider eligibility (revoked or expired) | `skipped` |
| `link_unrecoverable` | pre-provider eligibility (legacy, no envelope for the current hash, or decryption failed) | `skipped` |
| `recently_reminded` | pre-provider eligibility (§18) | `skipped` |
| `policy_disabled` | pre-provider eligibility | `skipped` |
| `out_of_window` | pre-provider eligibility (date, zone, `days_before` change, or no date/zone any more) | `skipped` |
| `recipient_rejected` | definite provider failure | `failed` |
| `ineligible_after_attempt` | uncertain: an eligibility check failed after an earlier attempt | `unknown` |
| `idempotency_conflict` | uncertain: the provider refused the reused key for a different payload | `unknown` |
| `attempts_exhausted` | uncertain: the third attempt did not end in a definite outcome | `unknown` |
| `replay_window_expired` | uncertain: 23 h after `first_attempt_at` without a definite outcome | `unknown` |

`claimed`, `sending`, `retry_wait`, `sent` and `sent_unrecorded` carry no reason: the state itself is the
explanation. No other condition needs its own value (configuration problems never touch a row; §13).

**Structural CHECKs** tying `state`, `outcome_reason` and `attempt_count` (see "Safety guarantees, by layer"):

| State | `outcome_reason` | `attempt_count` | `first_attempt_at` | Leased (`claim_token`, `lease_expires_at`) | Other |
|---|---|---|---|---|---|
| `claimed` | null | `0..2` (≥ 1 only on a reclaim after an attempt) | null ⇔ `attempt_count = 0` | non-null | — |
| `sending` | null | `1..3` | non-null | non-null | — |
| `retry_wait` | null | `1..2` | non-null | null | `next_attempt_at` non-null |
| `sent` | null | `1..3` | non-null | null | `sent_at` non-null |
| `sent_unrecorded` | null | `1..3` | non-null | null | — |
| `skipped` | one of the seven pre-provider reasons | **`= 0`** | null | null | — |
| `failed` | `recipient_rejected` | `1..3` | non-null | null | — |
| `unknown` | one of the four uncertainty reasons | `1..3` | non-null | null | — |

Consequences enforced by the database: a row that ever began a provider attempt can never be `skipped` (so never
reactivated); `failed` and `unknown` can only exist after the boundary; `next_attempt_at` exists only in
`retry_wait` and `sent_at` only in `sent`.

**Access:** RLS enabled in the creating migration. Members SELECT display columns only (column grants exclude
`claim_token`). No client INSERT/UPDATE/DELETE; every write is one of the service_role-only functions (§21).

**Privacy:** the row never stores a token, hash, envelope/ciphertext, recipient or contact email, provider message
id, RSVP answers, notes or guest names.

#### 8a. Occurrence semantics: row existence ≠ opportunity consumed

A row exists from the first claim. The automatic opportunity is **consumed** only once `attempt_count ≥ 1`, i.e.
once execution reached the provider boundary. Formally:

> A party may receive at most ONE automatic reminder whose execution crossed the email-provider boundary.

A `skipped` row (`attempt_count = 0`, guaranteed by CHECK) has consumed nothing. If its `outcome_reason` is remediable and the
party becomes eligible again, the claim function **reactivates the same row**: `skipped → claimed`, fresh
`claim_token`, fresh lease, current truth re-evaluated by prepare and begin. Rows in `sent`, `sent_unrecorded`,
`failed` and `unknown` are never reactivated.

#### 8b. Reactivation matrix (`skipped`, `attempt_count = 0`)

Reactivation always additionally requires: policy enabled (E1), wedding date and zone (E2), window open (E3) and
every current eligibility check (E5–E9).

| `outcome_reason` | Reactivatable | Conditions / rationale |
|---|---|---|
| `no_contact_email` | **YES** | a contact email is now set; E4 (`due_at ≥ enabled_at`) applies |
| `link_unrecoverable` | **YES** | an envelope is now bound to the current hash (an owner's explicit "Generar nuevo enlace", or the correct key restored); E4 applies |
| `link_unavailable` | **YES** | the link is usable again through an explicit owner action ("Generar nuevo enlace" clears `revoked_at` and resets `token_issued_at`), or a date change un-expired it; E4 applies |
| `policy_disabled` | **YES** | the policy is enabled again and the window is still open. **E4 is waived** for this reason only: the row was claimed while the policy was enabled and before the disable, and re-enabling resets `enabled_at`; the 48 h window still bounds it |
| `out_of_window` | **YES** | a later date or `days_before` change reopens the window; E4 applies |
| `recently_reminded` | **NO** | a manual reminder or invitation within 7 days already did the nudge near the automatic date; re-entering could produce two reminders within a week |
| `answered` | **NO** | answering is the success condition. The product has no RSVP deletion; LB-17 invents none. The row stays `skipped` |

### 9. Claim protocol

`claim_automatic_rsvp_reminders(max_total, max_per_wedding)` (service_role only), one transaction:

1. **Sweep** (no provider call). Only rows not currently held by a worker are touched: `retry_wait`, or `claimed` /
   `sending` with `lease_expires_at ≤ now()`. A live lease is never swept (its worker's begin, record or finish
   decides it).
   - such a row with `attempt_count ≥ 1` and `now() ≥ first_attempt_at + 23 h` → `unknown (replay_window_expired)`;
   - such a `sending` row with `attempt_count = 3` → `unknown (attempts_exhausted)`.
2. **Due-time evaluation.** A party that is due now (E1–E4 hold: policy on, date and zone, window open,
   `due_at ≥ enabled_at`) but fails a current pre-provider check (E5–E9) gets a `skipped` row with that reason (no
   lease, `attempt_count = 0`), unless it already has a row. *Implementation note:* without it, a legacy link, a
   missing email or a revoked link would never produce a row, and organizers couldn't see why nothing went out
   (§26). Nothing is consumed; remediable reasons are reactivated by step 3 once fixed (§8b), and
   `recently_reminded` / `answered` stay final as the matrix says.
3. **Select claimable rows and parties**, ordered by `due_at, id`, under the caps (§16):
   - **new**: no occurrence row, E1–E9 hold → `INSERT … ON CONFLICT (guest_invitation_id) DO NOTHING`;
   - **reactivation**: `skipped` with a reactivatable `outcome_reason` and §8b conditions;
   - **expired claim**: `claimed` with `lease_expires_at ≤ now()` (no attempt in progress);
   - **retry**: `retry_wait` with `next_attempt_at ≤ now()` and `now() < first_attempt_at + 23 h`;
   - **expired send**: `sending` with `lease_expires_at ≤ now()`, `attempt_count < 3`, `now() < first_attempt_at + 23 h`
     (the worker may have crashed during or after the provider call; the replay uses the same key, §12).
   Party rows are locked `FOR UPDATE SKIP LOCKED` (a party with an RSVP submission in flight is skipped this run);
   occurrence rows likewise.
4. Each claimed row: `state = claimed`, new `claim_token`, `lease_expires_at = now() + 10 min`. `attempt_count` is
   **unchanged** by claiming. Returns `(id, claim_token)` only.

A worker whose `claim_token` was superseded can change nothing: every later function requires the current token.

### 10. Prepare and begin protocol

Each claimed row goes through three steps. Prepare and begin are two separate store operations (two RPCs, two
short transactions) so that decryption and rendering happen **before** the provider boundary.

**1. Prepare: `prepare_automatic_rsvp_reminder(id, claim_token)`** (service_role only).

- Requires `state = claimed` and the current token.
- Performs the current-truth eligibility checks E1–E3 and E5–E9 from current rows. *Implementation note:* E4
  (`due_at ≥ enabled_at`) is the claim's entry rule (§9 step 3, with the §8b waiver for `policy_disabled`); prepare
  and begin don't re-apply it, so a disable/re-enable between claim and prepare behaves like the §8b waiver.
- Fails with `attempt_count = 0` → `skipped (outcome_reason)`, lease cleared; returns nothing.
- Fails with `attempt_count ≥ 1` → `unknown (ineligible_after_attempt)` (an earlier attempt may have delivered).
- Passes → renews the lease and returns the current capability and render context: the current `token_hash`, the
  envelope, the current `contact_email`, the party label, the wedding's name/date/city and the published site slug
  (or null). Nothing else.
- **Consumes no attempt** (`attempt_count` unchanged) and **makes no provider call.**

**2. Application** (the runner, outside any transaction, holding no database lock):

- decrypts the envelope (`decryptRsvpCapability`) and verifies the token against the returned hash;
- builds `guestRsvpUrl(token, APP_ORIGIN)`;
- renders `renderRsvpReminderEmail` from the prepared context.

A decryption failure is reported through finish: `skipped (link_unrecoverable)` if `attempt_count = 0`, else
`unknown (ineligible_after_attempt)`. A rendering failure (a programming error; the renderer is pure) is not
recorded: the row stays `claimed`, its lease expires and it is reclaimed with no new attempt consumed. If it never
succeeds, prepare ends it as `skipped (out_of_window)` once the window closes (`attempt_count = 0`), or the sweep
ends it as `unknown (replay_window_expired)` at the cutoff (`attempt_count ≥ 1`).

**3. Begin: `begin_automatic_rsvp_reminder_send(id, claim_token, token_hash, recipient)`** (service_role only), one
short transaction:

1. Locks the party row `FOR UPDATE` (waits for an in-flight `submit_guest_rsvp` to commit) and the occurrence row.
2. Requires `state = claimed`, the current token, and, if `attempt_count ≥ 1`, `now() < first_attempt_at + 23 h`
   (else `unknown (replay_window_expired)`).
3. Re-checks the authority-critical current state, E1–E3 and E5–E9: failure → `skipped (outcome_reason)` if
   `attempt_count = 0`, else `unknown (ineligible_after_attempt)`. Then verifies that the expected `token_hash` is
   still the current `token_hash` and the expected `recipient` is still the current `contact_email`.
   *Implementation note:* a mismatch here is not a pre-provider ineligibility (the party may still qualify, with its
   new link or address), so it returns `context_changed`: no state change, no attempt consumed, the lease is released
   (`lease_expires_at = now()`), and the next run prepares again from current truth. After an earlier attempt, that
   new payload then meets the provider's idempotency conflict (§12).
4. On success: `claimed → sending`, `attempt_count = attempt_count + 1`, `first_attempt_at = coalesce(first_attempt_at,
   now())`, lease renewed. Commit.
5. Its successful return is the authorization to make **exactly one** provider call.

The transaction ends (and every lock is released) when begin returns. **No database lock remains open across the
provider HTTP request.** Only after begin commits does the runner call the provider, once.

### 11. Provider boundary

- **`attempt_count` = the number of provider send attempts begun.** Not claims, runner passes, prepare calls or
  begin calls that failed. It increments exactly once per successful begin, in the same transaction as
  `claimed → sending`, immediately before the single provider call.
- **`sending` is conservative.** From the moment begin commits, the system assumes the provider boundary may have
  been crossed, whether or not the process reached the network: it cannot distinguish "crashed just before the
  call" from "crashed after Resend accepted". A `sending` row is therefore never treated as unsent.
- **Before the boundary of the current attempt** (`attempt_count` unchanged): a crash while `claimed`, a prepare or
  begin re-check failure, a decryption or rendering failure, a scheduler configuration failure discovered before
  claiming. For a row with `attempt_count = 0` these are retried, reclaimed or skipped with no duplicate-send risk.
  For a row with an earlier attempt they add no new risk, but the earlier attempt keeps the row on the
  post-boundary rules below (a re-check failure there is `unknown (ineligible_after_attempt)`, never `skipped`).
- **After the boundary may have been crossed** (`sending`, `retry_wait`, any row with `attempt_count ≥ 1`): network
  timeouts, a crash during the send, provider accepted but the record failed. Recovery only ever replays with the
  SAME idempotency key, at most 3 attempts in total, and only before `first_attempt_at + 23 h`. Past that: `unknown`,
  never an automatic resend.

### 12. Idempotency

- **Key:** `Idempotency-Key = "lb-auto-rsvp-reminder:" + occurrence id`, identical on every attempt of that
  occurrence. `EmailSender.send` gains optional, per-call `idempotencyKey` and `timeoutMs` options, used only by
  the automatic runner; the Resend adapter passes the key through and installs a deadline only when `timeoutMs` is
  given; the local outbox honours the key (one file per key) so tests can prove replays.
- **Provider semantics (treated as verified):** Resend retains a key for 24 h; same key + same payload returns the
  original send result without sending again; same key + different payload → `invalid_idempotent_request`; a
  concurrent request with the same key may return `concurrent_idempotent_requests`, which is retryable.
- **Application cutoff: 23 h** after `first_attempt_at`, enforced by begin (no provider call after it) and by the
  sweep. The 1 h margin covers clock skew between the database and the provider and in-flight calls.
- The adapter must map `invalid_idempotent_request` and `concurrent_idempotent_requests` to distinct categories
  (today the second maps to `provider_failure` and the first to `unknown`).

**Replay payload semantics.** The renderer is deterministic for a given input, but the authoritative input may
change between provider attempts: the party label, the contact email, the wedding's name, date or city, the
published-site state or slug, or the current RSVP capability. Every attempt recomputes from current truth (prepare
and begin); nothing from an earlier attempt is reused. Therefore:

- same occurrence id → same provider idempotency key, always;
- current truth produces the **same** payload → Resend's replay semantics suppress a duplicate (the original result is
  returned and no second email is sent);
- current truth produces a **different** payload → Resend rejects the reused key (`invalid_idempotent_request`), and
  the occurrence becomes terminal `unknown (idempotency_conflict)`;
- a **timeout** proves nothing about receipt: the attempt is treated as possibly delivered and replayed only under
  the same key, attempt cap and 23 h cutoff;
- a **crash** after begin leaves the row `sending`; after its lease it is replayed under the same rules.

The email body, recipient, capability and other private render context are **never snapshotted** to force a replay
to match: that would store private data and a bearer capability (§23) for the sake of retries. The conservative
conflict outcome is intentional.

**What is and isn't guaranteed.** The design provides database-level single occurrence identity and
provider-assisted duplicate suppression within Resend's idempotency window. It does not claim distributed
exactly-once delivery. Activity history is never used as a lock or dedupe key.

### 13. Retry matrix

| Situation | Boundary | Outcome |
|---|---|---|
| Scheduler configuration missing (`CRON_SECRET`, service role, email config, link key, `APP_ORIGIN`) | before claim | 503/no-op; nothing is claimed or changed |
| Eligibility fails at prepare/begin, `attempt_count = 0` | before | `skipped (outcome_reason)`; reactivatable per §8b |
| Eligibility fails at prepare/begin, `attempt_count ≥ 1` | after (earlier attempt) | `unknown (ineligible_after_attempt)` |
| Decryption failure | before this attempt | `skipped (link_unrecoverable)` if `attempt_count = 0`; else `unknown (ineligible_after_attempt)` |
| Rendering failure (programming error) | before this attempt | nothing recorded; the row stays `claimed`, lease expires, reclaimed with no attempt consumed |
| Worker crash while `claimed` | before | lease expires → reclaimed; no attempt consumed |
| Provider accepted, record committed | crossed | `sent` |
| Provider accepted, record failed or no storable id | crossed | `sent_unrecorded` (terminal) |
| Provider `invalid_recipient` | crossed, definitive | `failed (recipient_rejected)` (terminal) |
| Provider transient: rate limit, 5xx, network error, 10 s timeout, unclassified provider error, `concurrent_idempotent_requests` | may be crossed | `retry_wait`, `next_attempt_at = now() + 1 h`, if `attempt_count < 3` and before the cutoff; else `unknown (attempts_exhausted)` / `unknown (replay_window_expired)` |
| Provider `configuration` (key or sender refused) | may be crossed | as transient; additionally the runner **aborts the run**; remaining `claimed` rows lease-expire |
| Provider `invalid_idempotent_request` (payload changed since an earlier attempt: rotated link, new contact email, edited wedding name) | an earlier attempt may have delivered | `unknown (idempotency_conflict)` |
| Worker crash during or after the provider call | may be crossed | stays `sending`; lease expires → replay with the same key if `attempt_count < 3` and before the cutoff; else `unknown (attempts_exhausted)` or `unknown (replay_window_expired)` (sweep) |
| `finish` or `record` call itself fails (database unreachable) | crossed | stays `sending`; as the row above. If current truth renders the same payload, the replay returns Resend's original acceptance (no second email) and is then recorded; if not, `unknown (idempotency_conflict)` |

Outcomes are written by `record_automatic_rsvp_reminder_email` (success) or
`finish_automatic_rsvp_reminder(id, claim_token, outcome)` (closed outcome enum); both require the current token and
`state = sending` (finish also accepts `claimed` for pre-boundary failures).

### 14. `sent_unrecorded`

Terminal. The provider accepted, so the opportunity is consumed. No automatic resend, ever; no reactivation. The
party's latest-reminder metadata and activity are NOT written (nothing is fabricated). Organizers see "Se envió,
pero no pudimos registrarlo. No lo reenvíes todavía." and may still send a manual reminder deliberately.

### 15. `unknown`

**Definition: the application cannot prove that no email was sent; automatic resend is therefore forbidden.**

Terminal, never reactivated, never swept back. It arises only after the provider boundary (`attempt_count ≥ 1`,
CHECK-enforced). Organizers see "No podemos confirmar si se envió el recordatorio automático"; a manual reminder
remains their explicit choice.

### 16. Rate limits

| Limit | Value |
|---|---|
| Automatic reminders crossing the provider boundary, per party | 1 (§8a) |
| Provider attempts per occurrence | 3, all within 23 h of the first |
| Claims per run, global | 50 |
| Claims per wedding per run | 25 |
| Run time budget | 45 s, then no new claim, prepare or begin starts |
| Sending | sequential, at most 2 per second (500 ms spacing), under the Resend account rate limit |
| Lease | 10 min |
| Retry spacing | `next_attempt_at = now() + 1 h` (next hourly run) |
| Suppression after a manual reminder or invitation email | 7 days (§18) |

These are constants in the claim function and runner, changed only by a reviewed migration or code change.

### 17. Race conditions

| Race | Behaviour |
|---|---|
| **Manual reminder** | Auto yields to manual: E9 (7 days) at claim, prepare and begin → `skipped (recently_reminded)`. Manual is never blocked by automation. Residual: a manual click between begin and the provider accepting can yield two emails; accepted and documented |
| **RSVP** | Claim skips locked parties; begin waits on the party lock and re-checks E5 → `skipped (answered)`. Residual: an RSVP committing after begin and before provider acceptance yields one unneeded reminder; no lock is ever held across the provider call |
| **Contact email change** | The recipient is read at prepare and re-checked at begin. A change after begin makes the record fail → `sent_unrecorded`. A change before a replay changes the payload → `unknown (idempotency_conflict)` |
| **Capability rotation** | Prepare returns the CURRENT hash and envelope; begin re-checks the hash. Rotation after begin: the email carries the just-replaced link, the record's current-hash check fails → `sent_unrecorded`. Never a stale token from a claim or the browser |
| **Revocation** | Begin refuses → `skipped (link_unavailable)` (reactivatable after an owner's new link). After begin: record fails → `sent_unrecorded`; the guest holds a dead link |
| **Expiration** | Same as revocation, via `private.guest_invitation_expires_at` |
| **Wedding date / time zone / `days_before` change** | `due_at` is recomputed at every evaluation. Before the boundary, a closed window → `skipped (out_of_window)`, reactivatable if it reopens. After `sent`, nothing is re-sent |
| **Policy disable** | Begin refuses → `skipped (policy_disabled)` if `attempt_count = 0` (reactivatable within the window), else `unknown (ineligible_after_attempt)`. Re-enabling never reaches back past `due_at ≥ enabled_at` for never-claimed parties |

### 18. Manual vs automatic suppression

- E9: an automatic reminder is not begun within **7 days** after a recorded manual reminder or invitation email
  (`rsvp_reminder_email_sent_at`, `invitation_email_sent_at`). `recently_reminded` is not reactivatable (§8b).
- An automatic send writes `rsvp_reminder_email_sent_at` too, but manual reminders are explicit human intent and are
  never suppressed; the UI shows the automatic status next to the button.

### 19. Reminder metadata

`guest_invitations.rsvp_reminder_email_sent_at / _sent_to / _provider_id` become **"the latest successful reminder
email, either channel"**, written by `record_rsvp_reminder_email` (manual) or `record_automatic_rsvp_reminder_email`
(automatic). Same rules: all-or-none, recipient = current contact email, current usable hash, bounded provider id,
database clock. No duplicate latest-automatic columns. The channel is visible through the activity actor and the
occurrence's `sent_at`.

### 20. Activity History

Reuse **`rsvp_reminder_email_sent`** with `actor_kind = 'system'`, `actor_user_id = null`, written only inside
`record_automatic_rsvp_reminder_email`, in the same transaction as the metadata and `sending → sent`. No new event
type. No rows for claims, skips, retries, failures, `sent_unrecorded`, `unknown` or policy changes (worker state, not
wedding facts; policy changes are on the policy row). ADR-008 §4 is amended at implementation: "`system` — no
person: an automatic send under an owner-enabled policy (LB-17), or privileged maintenance." The page labels this
actor "Automático" for this event. Still, only the two member recorders take a user id.

### 21. Service-role exception

A new, separate server-only module, **`src/lib/scheduler/rsvp-reminder-store.ts`**, accepted under ADR-002 §6:

- Justification: there is no session (see Context), and the scheduler must read capability envelopes and drive a state
  machine. That is materially different from `delivery-recorder.ts` (record-only plus one confirmation read), which
  stays unchanged and is not widened.
- It is the second and only other file ESLint allows to read `SUPABASE_SERVICE_ROLE_KEY`. It builds its client
  privately and exposes exactly five named operations, each one fixed RPC: `claim`, `prepare`, `begin`, `record`,
  `finish`. No exported client, no `from()`, no generic `rpc(name)`, no query helper, no authorization.
- Database: `claim_automatic_rsvp_reminders`, `prepare_automatic_rsvp_reminder`,
  `begin_automatic_rsvp_reminder_send`, `record_automatic_rsvp_reminder_email`, `finish_automatic_rsvp_reminder`:
  SECURITY DEFINER, `search_path = ''`, EXECUTE revoked from PUBLIC, anon and authenticated, granted to
  `service_role` only. None takes a user id or an event type.
- The envelope read is narrow: one occurrence at a time, behind a valid `claim_token`, only while eligible. Without
  `RSVP_CAPABILITY_ENCRYPTION_KEY` (app-side only) it is useless.
- Orchestration lives in `src/lib/scheduler/rsvp-reminder-runner.ts`, which receives the store, an `EmailSender`,
  `APP_ORIGIN`, encryption settings and a clock/budget as parameters (fakes in tests). It reuses
  `renderRsvpReminderEmail`, `decryptRsvpCapability` and `guestRsvpUrl`; it never generates, rotates or revokes.
- As ADR-005 notes, `service_role` is globally privileged in Supabase; the guarantee is the application boundary
  plus the functions' grants, not a restriction of the role itself.

### 22. Secrets

- **New:** `CRON_SECRET` (server-only, ≥ 32 bytes, read only in `src/lib/scheduler/cron-auth.ts` (§4),
  ESLint-restricted everywhere else, never logged or returned). Its absence is the global stop.
- **Required existing:** `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RSVP_CAPABILITY_ENCRYPTION_KEY`,
  `APP_ORIGIN`, `EMAIL_FROM`, `RESEND_API_KEY` (or `EMAIL_TRANSPORT=outbox` + `EMAIL_OUTBOX_DIR` locally and in E2E).
  Any missing → the route does nothing.
- No feature-flag variable.

### 23. Privacy

The occurrence table, the route's responses and logs never contain tokens, hashes, envelopes/ciphertext, RSVP URLs,
recipients or contact emails, provider ids, RSVP answers or notes. The plaintext token exists only in the runner's
memory and the email body. Activity rows follow ADR-008 §9 unchanged.

### 24. Deployment safety

**Invariant: applying the migration or deploying the code cannot send any email.** Sending requires all of:

1. An owner's explicit opt-in for that wedding (zero policy rows after migration; default `false`).
2. `CRON_SECRET` provisioned **and** the cron entry deployed. The `vercel.json` cron entry ships **last**, as a
   separately approved deployment step; until then nothing invokes the route. (Shipped in LB-17A.2 as an hourly
   entry, `0 * * * *`, with every policy still OFF and production email still blocked; see the header.)
3. `due_at ≥ enabled_at` for never-claimed parties and the 48 h window.
4. Per-run caps and one boundary-crossing reminder per party.

### 25. Backfill

None. Zero policy rows, zero occurrence rows, zero activity rows. Every existing wedding starts OFF. No retroactive
or synthetic sends.

### 26. Organizer visibility

- Invitados: an owner panel (toggle, `days_before`, preview "Se enviará el {fecha} a {n} grupos sin respuesta con
  correo"; disabled with an explanation without date or zone). Collaborators see it read-only.
- Per party: "Recordatorio automático: programado para … / enviado el … / no se enviará: {motivo}" from fixed copy
  (ya respondió, sin correo, enlace no recuperable — un dueño debe generar uno nuevo, enlace vencido o revocado,
  recordatorio reciente, fecha ya pasada), plus the `sent_unrecorded` and `unknown` notices (§14, §15).
- A wedding-level notice when any occurrence is `failed`, `sent_unrecorded` or `unknown`.
- Never provider codes, ids, secrets or worker logs. Configuration problems are operator-only (route counts, logs).

## Safety guarantees, by layer

**Database guarantees**
- One occurrence per party (`UNIQUE (guest_invitation_id)`).
- `skipped ⇒ attempt_count = 0`; post-boundary states ⇒ `attempt_count ≥ 1`; `attempt_count ≤ 3`; `outcome_reason`
  non-null only in `skipped` (pre-provider reasons), `failed` (`recipient_rejected`) and `unknown` (uncertainty reasons).
- Only the current `claim_token` can advance a row; claims use `SKIP LOCKED`; begin locks the party row.
- Begin refuses after `first_attempt_at + 23 h`; terminal states are never selected by claim; the sweep never
  touches a row under a live lease.
- Metadata, activity and `sent` commit together or not at all.
- All scheduler functions are executable only by `service_role`; the policy writer is owner-checked; clients write
  neither table.

**Application guarantees**
- The route refuses without the bearer secret; no work without full configuration.
- One provider call per begin; no provider call while a transaction or lock is held.
- The idempotency key is derived only from the occurrence id. The renderer is deterministic for a given input; every
  attempt renders from current truth, never from a snapshot (§12).
- The service-role key is read in two named modules only; the scheduler store exposes five fixed operations.
  `CRON_SECRET` is read only in `cron-auth.ts`, which holds no privileged client and no business logic.
- The automatic runner's provider calls time out after 10 s (explicit `timeoutMs`); the runner starts no new work
  after 45 s; the route's `maxDuration` is 60 s. Manual email flows get no new timeout.
- No token, hash, envelope or recipient is persisted or logged by the scheduler.

**Provider guarantees (Resend, within 24 h of a key's first use)**
- Same key + same payload does not send twice.
- Same key + different payload is refused (→ `unknown`, never a second send).

**Not guaranteed**
- Distributed exactly-once delivery. Residual windows: an RSVP, a manual send or a contact/link change landing
  between begin and provider acceptance.
- Inbox delivery (no bounce handling).

## Testing requirements

- **Unit:** due-date mirror (DST, zones, null date/zone, window edges, `enabled_at`); runner with fake store and
  sender for every row of §13, the 45 s budget, the 10 s provider timeout treated as possibly delivered, run abort
  on `configuration`, a stable idempotency key across attempts, the same payload for unchanged input and a changed
  payload (→ `unknown (idempotency_conflict)`) after an input change; `cron-auth.ts` (missing/short/wrong secret,
  timing-safe comparison, query-string secret ignored) and the route (non-GET 405, no work without configuration);
  Resend error mapping for both idempotency errors; the email still carries the current link and nothing private.
- **DB (`tests/db`):** catalog grants (five functions service_role-only, policy writer owner-only, no client writes,
  no `claim_token` select, RLS cross-wedding); every structural CHECK (each state with each allowed and forbidden
  `outcome_reason` and `attempt_count`); the eligibility matrix E1–E10; the
  reactivation matrix (each reason YES/NO, the `policy_disabled` E4 waiver); `SKIP LOCKED` with two concurrent
  connections; stale `claim_token` refused everywhere; the sweep; begin's cutoff; `record` atomicity (metadata +
  `system` activity + `sent`, or nothing); migration inserts zero rows.
- **Real-stack service:** the store against local Supabase with a fake sender: two concurrent runners send exactly
  once per party; a crash after begin replays with the same key; a crash past the cutoff ends `unknown` with no
  second call; record failure → `sent_unrecorded`.
- **E2E:** an owner enables the policy; the route is called with the secret against the outbox; exactly one message
  with the current link; the party shows "enviado" and Actividad shows "Automático"; a second call sends nothing; an
  answered party gets nothing; a party without email is skipped, then reactivated after an email is added; a
  collaborator sees no toggle.
- **Scheduler integration:** without the secret nothing happens; with the secret and no policies, zero claims.

## Mutation requirements

Each mutation must turn at least one test red:

1. Drop `UNIQUE (guest_invitation_id)`.
2. Remove the RSVP re-check in begin.
3. Use a hash/envelope captured at claim instead of the current one at prepare/begin (stale capability).
4. Skip the bearer check, or accept the secret from a query string.
5. Remove `SKIP LOCKED`, or keep the old `claim_token` on reclaim (duplicate claim).
6. Remove the 7-day manual/invitation suppression.
7. Let `sent_unrecorded` re-enter `retry_wait` or `claimed`.
8. Derive the idempotency key from anything other than the occurrence id (per attempt, per claim, timestamped).
9. Allow a provider call or reclaim after `first_attempt_at + 23 h`.
10. Reactivate a `skipped` row whose `outcome_reason` is `answered` or `recently_reminded`.
11. Fail to reactivate a remediable `skipped` row with `attempt_count = 0` (e.g. `no_contact_email` after an email
    is added).
12. Reactivate `sent`, `sent_unrecorded`, `failed` or `unknown`.
13. Increment `attempt_count` at claim or prepare, or after the provider call instead of at begin.
14. Write `skipped` for a row with `attempt_count ≥ 1` (drop the CHECK or the `unknown` mapping).
15. Make two provider calls for one begin.
16. Grant EXECUTE on any scheduler function to `authenticated` (or anon).
17. Let a collaborator call `set_rsvp_reminder_policy`.
18. Drop `due_at ≥ enabled_at` for never-claimed parties.
19. Write the automatic activity row as `member`, or with a user id.
20. Insert a default-enabled policy row (or default `enabled` to true) in the migration.
21. Allow an `outcome_reason` outside its state (e.g. `sent` with a reason, `failed` with a pre-provider reason,
    `unknown` with `attempt_count = 0`).
22. Snapshot the rendered body, recipient or capability on the occurrence to reuse on a retry.
23. Read `CRON_SECRET` outside `cron-auth.ts`, or give `cron-auth.ts` a Supabase client or the service-role key.
24. Hold a database transaction or lock open across the provider call.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Database cron (pg_cron + pg_net) | Needs the cron secret or service credentials stored in the database, and still calls back into the app; decryption in the database is rejected by ADR-006 |
| Supabase Edge Function worker | Duplicates crypto, rendering and the sender in a second runtime (Deno) and puts the link key in a second secret store |
| External scheduler (e.g. GitHub Actions) as the primary runtime | Turns CI into runtime infrastructure with delayed/dropped schedules; kept only as a fallback that would hit the same route |
| A fake member (owner who enabled the policy as actor, a minted session) | False attribution; ADR-008 forbids fabricated actors |
| Reusing `delivery-recorder.ts` | Widens a record-only module into a capability reader and state machine; ADR-004 scopes it narrowly |
| Activity history as the lock or dedupe key | Successful-only facts, no claims or leases (ADR-008 §12) |
| A generic job/queue/outbox table | One occurrence per party is the whole requirement |
| Pre-generated scheduled sends | Go stale on date, zone, policy, email or link changes; just-in-time evaluation reads current truth |
| A new occurrence row per attempt or re-entry | Loses the single-identity guarantee; re-entry reuses the row |
| Unbounded or provider-uncapped retries | Duplicate risk beyond the 24 h key window; capped at 3 within 23 h |
| Automatic resend after `unknown` or `sent_unrecorded` | Cannot prove no email was sent; a duplicate is worse than a missing automatic nudge |
| Holding a database lock across the provider call | Not possible through PostgREST transactions, and would block RSVPs on provider latency |

## Consequences

- Organizers get one automatic nudge per unanswered party, opt-in per wedding, with visible status and no hidden
  retries.
- The privileged surface grows: a second service-role module with five fixed operations, including a session-less
  envelope read. ADR-002 §6, ADR-007 §7, ADR-008 §4/§12 and CLAUDE.md are amended when LB-17 is implemented.
- A new deployment secret (`CRON_SECRET`) and a scheduled production invocation; Vercel Cron becomes runtime
  infrastructure. Observability is the route's counts plus the organizer-facing statuses.
- The email sender gains optional per-call idempotency keys and timeouts (only the automatic runner uses them, with a
  10 s deadline) and two new failure categories; the reminder renderer must stay deterministic for a given input.
- An edit to a party, its contact email, its link or the wedding between attempts turns a pending replay into
  `unknown (idempotency_conflict)` instead of a second email; this is intentional.
- `rsvp_reminder_email_*` now means "latest reminder, either channel".
- Some parties will end `unknown` or `sent_unrecorded` and get no automatic reminder; that is the deliberate price of
  never sending twice automatically.
- Cron activation stays a separate, explicitly approved step after implementation and review.
