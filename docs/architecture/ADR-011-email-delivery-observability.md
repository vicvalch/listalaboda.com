# ADR-011 — Email Delivery Observability

Status: Accepted for staged implementation (LB-18) · Date: 2026-10-06
Implementation: **LB-18.1 = persistence foundation only** (migration `20261013120000_lb_email_delivery_ledger`): the
`email_deliveries` ledger and its writes inside the four existing record functions. No webhook, provider event table,
delivery status, UI, suppression or eligibility change exists yet; those are the later slices in §12.
Related: [ADR-001 §2](ADR-001-product-domain-and-tenancy.md), [ADR-002 §6, §7](ADR-002-auth-and-security-boundaries.md),
[ADR-004](ADR-004-invitation-delivery-recorder.md), [ADR-005](ADR-005-rsvp-confirmation-email.md),
[ADR-007](ADR-007-manual-rsvp-reminder-delivery.md), [ADR-008](ADR-008-basic-activity-history.md),
[ADR-010](ADR-010-automatic-rsvp-reminder-scheduling.md)

## Context

The app sends four kinds of email through `EmailSender.send` (Resend in production, a local file outbox in tests):
the guest invitation (LB-11), the RSVP confirmation (LB-12), the manual RSVP reminder (LB-14) and the automatic RSVP
reminder (LB-17). A send counts as "sent" once the **provider accepted** it and the server **recorded** it through a
service_role-only record function; there is no signal after that.

## Problem

Provider acceptance is not delivery. An accepted email can still be delayed, bounce, be suppressed by the provider or
be reported as spam, and organizers can't tell.

Resend reports those outcomes as signed webhook events keyed by its email id (`data.email_id`, the same id
`emails.send` returns). The current schema can't map such an event back to the send it is about:

- each flow keeps only its **latest** send on the party (`invitation_email_*`, `rsvp_confirmation_email_*`,
  `rsvp_reminder_email_*`), so every new send of a channel overwrites the previous provider id;
- manual and automatic reminders **share** `rsvp_reminder_email_provider_id`;
- confirmations go out on every RSVP save, so their id turns over constantly;
- the `*_provider_id` columns are neither unique nor indexed;
- activity rows (ADR-008) and automatic occurrences (ADR-010) deliberately store no provider id.

A late bounce for an earlier invitation would therefore be lost, or worse, guessed.

## Decision

### 1. Hybrid persistence model

Existing business metadata stays **unchanged**: the latest-send columns on `guest_invitations` keep their meaning,
writers and readers (the party card, LB-17's `recently_reminded` check). They are not removed, repurposed or
backfilled.

Added: **`public.email_deliveries`**, one immutable identity row per provider-accepted application email that was
successfully recorded. LB-18.2 will add `public.email_delivery_events` (provider events, deduplicated by the
provider's event id) and the delivery status columns. The events table does **not** exist yet.

Rejected: replacing the per-flow columns with the shared table (rewrites four shipped flows and LB-17's eligibility
for no gain), and more per-flow columns (still latest-only, or four copies of one history table).

### 2. Delivery kinds

`public.email_delivery_kind`, closed, one value per record function:

| Kind | Record function |
|---|---|
| `guest_invitation` | `record_guest_invitation_email` |
| `rsvp_confirmation` | `record_rsvp_confirmation_email` |
| `rsvp_reminder_manual` | `record_rsvp_reminder_email` |
| `rsvp_reminder_automatic` | `record_automatic_rsvp_reminder_email` |

Manual and automatic reminders already have separate record functions, so the kind is fixed by which function runs,
never inferred.

### 3. The ledger (LB-18.1)

Columns: `id`, `wedding_id`, `guest_invitation_id`, `kind`, `provider_message_id`, `recipient`, `accepted_at`.

- **Written only inside the four record functions**, in the same transaction as their metadata update and activity
  row, through one private helper (`private.record_email_delivery`, not executable by any client role). Signatures,
  grants and checks of the record functions are unchanged; the application code is unchanged.
- `provider_message_id`: the provider id `EmailSender.send` returned, the same value the latest-send column receives.
  **`UNIQUE`**, and checked against the same storable-id contract (`^[A-Za-z0-9._:-]{1,200}$`).
- `recipient`: the address the provider accepted (the party's contact email at record time, which the record functions
  already require to equal the current one). Same CHECK as the `*_sent_to` columns.
- `accepted_at`: the database clock of the record transaction (a guard trigger overwrites any supplied value), so it
  equals the `*_sent_at` the same call wrote.
- **Same-wedding** composite FK `(guest_invitation_id, wedding_id) → guest_invitations (id, wedding_id)`.
- **Identity is immutable** for every role (guard trigger): no identity column ever changes after insert. Rows are
  deleted only by the foreign keys' `ON DELETE CASCADE` (party or wedding); a direct delete is refused, even for
  service_role. LB-18.2's delivery status columns will be the only updatable ones.
- Indexes: `(guest_invitation_id, kind, accepted_at desc)` for "latest delivery per party and kind" (and the party FK);
  `(wedding_id)` for a guest page's member read and the wedding FK cascade.

**Delivery status columns are deliberately not created in LB-18.1.** Adding them in LB-18.2 is a metadata-only
`ALTER TABLE … ADD COLUMN … NOT NULL DEFAULT 'accepted'` (no table rewrite), while creating them now would ship
states that no code can set, with their update grant and guard rules decided before the transitions that need them.

### 4. Correlation and tenant boundary

The correlation key is `provider_message_id`, the provider's email id. No tenant identifier supplied by a provider
(tags, metadata, addresses) is ever trusted or sent. The future mapping is strictly local:

provider email id → `email_deliveries` → `guest_invitations` → Wedding.

An event whose id matches no row (sends before LB-18.1, deleted parties, the provider's test events, other
environments) is acknowledged and ignored.

### 5. Recording and failure semantics

- One successful record = exactly one ledger row. A record that fails (the existing checks, or a reused provider id)
  rolls back the **whole** transaction: no metadata, no activity, no ledger row. The caller reports
  `sent_but_unrecorded` (manual flows) or `sent_unrecorded` (LB-17) exactly as before.
- A reused provider id raises the uniform `email_delivery_not_recorded` and never echoes the id.
- Sends the provider accepted without a storable id are never recorded and have no ledger row (unchanged).
- The outbox's ids (`outbox-<uuid>`) satisfy the same contract; persistence has no test special case.

### 6. Privileges

- RLS on. anon: nothing. authenticated: no INSERT, UPDATE or DELETE.
- Members (owners and collaborators) may SELECT `id, wedding_id, guest_invitation_id, kind, recipient, accepted_at`
  of their own weddings' rows (member RLS policy), the same audience and data class as the latest-send metadata they
  already read. **`provider_message_id` has no client grant**: provider ids never need to reach the browser.
- Repository style: column grants plus member RLS for display data (as for `automatic_rsvp_reminders`); a read RPC is
  added only when a page needs joins or aggregation (LB-18.3 may add one for "latest per party and kind").

### 7. Future delivery statuses (LB-18.2; documented, not implemented)

`accepted` (set only by the application's record, never by a webhook) · `delayed` · `failed` · `delivered` ·
`suppressed` · `bounced` · `complained`.

They will be rank-monotonic (out-of-order and duplicate events never move the status backwards):
`accepted 0 < delayed 10 < failed 20 < delivered 30 < suppressed 40 < bounced 50 < complained 60`. A later
recipient-negative signal outranks `delivered`; a sender-side `failed` doesn't. Events are deduplicated by the
provider's event id (`svix-id`). Only `delivered`, `delivery_delayed`, `bounced`, `complained`, `failed` and
`suppressed` will be subscribed.

### 8. Execution vs delivery

LB-17's `automatic_rsvp_reminders.state` remains **execution truth**: whether the provider boundary was crossed and
whether the provider accepted. Delivery status is separate and lives with the ledger. A delivery bounce never
rewrites `sent → failed`, never reactivates a consumed occurrence and never changes `attempt_count`.

### 9. Future resend policy (approved product decision; implemented in a later LB-18 slice)

- `delayed` or `failed` → a manual email retry is allowed.
- `bounced`, `suppressed` or `complained` → sending email again to the **same current** `contact_email` is blocked.
- Editing the party's `contact_email` makes email sending eligible again.
- Copying and sharing the party's RSVP link manually ("Mostrar enlace", the WhatsApp text) is always allowed.
- No operator override control.

### 10. Future automatic eligibility (LB-18.4; approved product decision)

- `bounced`, `suppressed` or `complained` for the party's **current** email address will skip the automatic reminder
  with a new pre-provider reason `recipient_undeliverable` (attempt 0, remediable).
- Editing the address reactivates eligibility.
- `recently_reminded` will be scoped to the **current** recipient address: a recent send to an OLD address no longer
  suppresses the automatic reminder after `contact_email` changes.

### 11. Privacy

- No email body, subject, provider payload, token, hash, envelope or RSVP URL is stored in the ledger; the recipient
  is the only personal data, and it goes away with its party.
- **Open tracking: deferred / disabled.** No consent from guests, unreliable signal (image proxies, privacy features),
  no product need.
- **Click tracking: prohibited** for RSVP invitation and reminder mail: it would rewrite capability URLs
  (`/rsvp/<token>`) through the provider's tracking redirect and echo them back in events. Tracking stays disabled on
  the sending domain.
- Ledger rows are not activity history (ADR-008): no events are appended for deliveries in LB-18.

### 12. Staged implementation

| Slice | Scope |
|---|---|
| **LB-18.1** (this) | ADR-011, `email_deliveries`, one row per recorded send, tests |
| LB-18.2 | Signed Resend webhook ingestion (`POST /api/webhooks/resend`), `email_delivery_events`, status columns and rank rule, a narrow service_role ingest module (ADR-002 §6 justification) |
| LB-18.3 | Delivery status UI on the party card (owners and collaborators) and the resend rules of §9 |
| LB-18.4 | `recipient_undeliverable` and the `recently_reminded` refinement (§10) |
| LB-18.5 | Production webhook activation: a separately approved infrastructure step, after the sending domain is owned and verified |

### 13. Historical sends

No backfill. Sends recorded before this migration have no ledger row and will show delivery status as unavailable.
Ledger rows are never fabricated from the latest-only provider columns.

## Consequences

- Every send recorded from LB-18.1 on is correlatable to a future provider event, per send and per kind.
- The record functions do one more insert in the same transaction; a provider-id collision (practically impossible
  with provider UUIDs) turns a send into `sent_but_unrecorded` instead of corrupting correlation.
- Deleting a party now also deletes its delivery rows; activity history is unaffected.
- No user-visible change in LB-18.1.
