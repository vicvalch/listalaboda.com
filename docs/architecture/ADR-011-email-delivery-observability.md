# ADR-011 — Email Delivery Observability

Status: Accepted for staged implementation (LB-18) · Date: 2026-10-06
Implementation: **LB-18.1 = persistence foundation** (migration `20261013120000_lb_email_delivery_ledger`): the
`email_deliveries` ledger and its writes inside the four existing record functions. **LB-18.2 = passive signed webhook
ingestion** (migration `20261014120000_lb_email_delivery_events`): delivery status, `email_delivery_events`, the
service_role-only ingest function and `POST /api/webhooks/resend` (§7). **LB-18.3 = delivery status UI and manual
send guardrails** (migration `20261015120000_lb_email_delivery_status_ui`, §14). **LB-18.4 = automatic reminder
suppression and recipient-aware eligibility** (migrations `20261016120000_lb_automatic_reminder_recipient_reason`,
`20261016120100_lb_automatic_reminder_recipient_suppression`, §10). No production webhook exists yet; that is LB-18.5
(§12).
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
successfully recorded. LB-18.2 adds `public.email_delivery_events` (provider events, deduplicated by the provider's
event id) and the delivery status columns (§7).

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
  service_role. LB-18.2's delivery status columns are the only updatable ones (§7).
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

### 7. Delivery status and signed webhook ingestion (LB-18.2, implemented)

**Status.** `public.email_delivery_status`, declared in rank order; `email_deliveries.status` (`NOT NULL DEFAULT
'accepted'`, a metadata-only column add: every LB-18.1 row reads `accepted`) and `status_event_at` (null while
`accepted`; a CHECK enforces `status = 'accepted'` ⇔ `status_event_at IS NULL`). `accepted_at` keeps its meaning.

| Status | Rank | Meaning | Superseded by |
|---|---|---|---|
| `accepted` | 0 | provider accepted, app recorded (set only by the record; never by a webhook) | any event |
| `delayed` | 10 | temporary delivery trouble | failed, delivered, suppressed, bounced, complained |
| `failed` | 20 | sender-side failure | delivered, suppressed, bounced, complained |
| `delivered` | 30 | reached the recipient's server | suppressed, bounced, complained |
| `suppressed` | 40 | provider refused to send to the address | bounced, complained |
| `bounced` | 50 | recipient's server rejected it | complained |
| `complained` | 60 | marked as spam | nothing (terminal) |

The status only moves to a **strictly higher** rank. A same- or lower-rank event is recorded as history and changes
nothing; the provider's timestamp never decides precedence (events arrive late and out of order). `status_event_at`
is the provider time of the event that last **advanced** the status. The ledger's guard (every role, superuser and
service_role included) keeps identity immutable, refuses a status regression and refuses moving `status_event_at`
without an advance; a new row always starts `accepted`. The guard uses the enum's own order (equal to the rank table,
pinned by a DB test) because it runs with the caller's privileges and service_role has no access to schema `private`.

**Event ledger.** `public.email_delivery_events`: `id`, `delivery_id`, `wedding_id` (same-wedding composite FK
`(delivery_id, wedding_id) → email_deliveries (id, wedding_id)`, `ON DELETE CASCADE`), `provider_event_id`
(**`UNIQUE`**, the `svix-id`, `^[A-Za-z0-9_-]{1,128}$`), `event_type` (`delivered`, `delivery_delayed`, `failed`,
`suppressed`, `bounced`, `complained`), `bounce_type` (`permanent`/`transient`/`undetermined`, required for bounces and
only for bounces), `occurred_at` (the payload's top-level `created_at`), `received_at` (database clock). Append-only
(guard: no updates; deletes only through the cascade). It stores no recipient, subject, sender, payload, failure or
bounce text, link, IP, user agent or tags. RLS on; **no** privileges for anon, authenticated **or** service_role: it
is internal audit, nothing reads it yet.

**One writer.** `public.ingest_email_delivery_event(provider_event_id, provider_message_id, event_type, occurred_at,
bounce_type)`: SECURITY DEFINER, `search_path = ''`, EXECUTE for service_role only. It takes no Wedding, party,
delivery id, recipient or payload. In one transaction: look up `email_deliveries` by `provider_message_id` (none →
`unknown_message`, nothing written) → lock it `FOR UPDATE` → insert the event `ON CONFLICT (provider_event_id) DO
NOTHING` (conflict → `duplicate`, nothing changed) → advance the status if the event outranks it (`applied`) or not
(`no_change`). Malformed input raises `email_delivery_event_invalid` before any write. The result is a closed enum and
carries no ids. Concurrent deliveries of one event serialize on the row lock, and the unique constraint is the final
authority: exactly one row, at most one transition, the others `duplicate`.

**Route.** `POST /api/webhooks/resend` (POST only, dynamic, `no-store`, empty responses, nothing logged; excluded from
the session proxy; no cookies, session, CSRF or redirect: the provider's signature is the only authority):

1. `RESEND_WEBHOOK_SECRET` missing or malformed (not `whsec_<base64>` of ≥ 24 bytes) → **503**;
2. the raw body, read once as received, at most **64 KiB** (declared or streamed) → else **413**;
3. `svix-id`, `svix-timestamp`, `svix-signature` present and well-formed → else **401**; timestamp within the
   library's ± 5 minutes → else **401**; Standard Webhooks HMAC-SHA256 over `<id>.<timestamp>.<raw body>` (any `v1`
   signature of the space-separated list) → else **401**. Verification uses `standardwebhooks` directly with the
   webhook secret only (never a Resend client or `RESEND_API_KEY`), in `src/lib/email/webhook-auth.ts`, the only
   reader of the secret;
4. only then JSON parsing and normalization (`src/lib/email/delivery-events.ts`): `type`, top-level `created_at`,
   `data.email_id` (the correlation key; `data.message_id`, tags and recipients are never read) and, for bounces,
   `data.bounce.type` (case-insensitive: `Permanent` → permanent; `Transient`/`Temporary` → transient; anything else
   or missing → undetermined);
5. one `ingest` call through `src/lib/email/delivery-event-store.ts` (the third service-role module, ADR-002 §6).

| Verified event | Persistence | HTTP |
|---|---|---|
| `email.delivered` / `delivery_delayed` / `failed` / `suppressed` / `bounced` / `complained` | event row + rank rule (`applied`, `no_change`), or nothing (`duplicate`, `unknown_message`) | 200 |
| `email.opened`, `email.clicked` (never read: no link, IP or user agent), `email.sent`, contact/domain/suppression/topic and unknown types | nothing | 200 |
| A supported type with a malformed body (bad JSON, missing/invalid `email_id` or `created_at`) | nothing | 200 |
| Database unreachable or refused | nothing | 500 (the provider retries) |
| Service-role configuration missing | nothing | 503 |

Malformed-but-signed bodies are acknowledged: the provider signed them, so a retry can't make them valid, and refusing
them would only trigger retries and eventually disable the endpoint. `unknown_message` is expected and safe (sends
before LB-18.1, deleted parties, dashboard test events, another environment's webhook): 200, no row, nothing logged.

**Contract check (2026-10-06).** Resend's current documentation and SDK (`resend@6.32.0`, which itself verifies with
`standardwebhooks@1.1.1`) match this ADR: Svix headers, raw-body signing, `data.email_id` = the `emails.send` id,
top-level `created_at`, and retries of one event keep the same `svix-id` (Svix). Resend documents retries (over about a
day) but no ordering guarantee, so none is assumed. One
documentation inconsistency — bounce types listed as `Permanent`/`Transient`/`Undetermined` in the bounce guide and
`Permanent`/`Temporary` in the webhook reference — is absorbed by the normalization above.

**Not in LB-18.2:** member reads of the status (no client grant on `status`/`status_event_at` yet), UI, resend rules
(§9), `recipient_undeliverable`/`recently_reminded` (§10), production webhook or secret (§12). Open tracking stays
disabled and click tracking prohibited (§11).

### 8. Execution vs delivery

LB-17's `automatic_rsvp_reminders.state` remains **execution truth**: whether the provider boundary was crossed and
whether the provider accepted. Delivery status is separate and lives with the ledger. A delivery bounce never
rewrites `sent → failed`, never reactivates a consumed occurrence and never changes `attempt_count`.

### 9. Resend policy (approved product decision; implemented in LB-18.3, §14)

- `delayed` or `failed` → a manual email retry is allowed.
- `bounced`, `suppressed` or `complained` → sending email again to the **same current** `contact_email` is blocked.
- Editing the party's `contact_email` makes email sending eligible again.
- Copying and sharing the party's RSVP link manually ("Mostrar enlace", the WhatsApp text) is always allowed.
- No operator override control.

### 10. Automatic eligibility (LB-18.4; approved product decision, implemented)

- `bounced`, `suppressed` or `complained` for the party's **current** email address in the same wedding skips the
  automatic reminder with the pre-provider reason `recipient_undeliverable` (`skipped`, attempt 0, no provider call,
  remediable). The determination is LB-18.3's `private.email_recipient_block` (§14), so the members' warning, the
  manual guard and the scheduler agree. `delayed`, `failed`, `delivered` and `accepted` never block.
- A genuinely different address reactivates eligibility; a case-only edit is the same address (comparison form) and
  does not; an old address's failures never poison a new one.
- `recently_reminded` is scoped to the **current** recipient address: a recent send to an OLD address no longer
  suppresses the automatic reminder after `contact_email` changes; a case variant of the current address still does.
- Checked at claim and re-checked at prepare and begin (before the provider boundary): a bounce that lands after the
  claim stops the send. Execution and delivery stay separate (§8): a delivery outcome never rewrites an occurrence
  (`sent` stays `sent`); it only informs FUTURE eligibility. Details: ADR-010 §27.

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
| **LB-18.1** (implemented) | ADR-011, `email_deliveries`, one row per recorded send, tests |
| **LB-18.2** (implemented) | Signed Resend webhook ingestion (`POST /api/webhooks/resend`), `email_delivery_events`, status columns and rank rule, a narrow service_role ingest module (ADR-002 §6 justification); production webhook not configured |
| **LB-18.3** (implemented) | Delivery status UI on the party card (owners and collaborators) and the resend rules of §9 for manual sends and the RSVP confirmation (§14) |
| **LB-18.4** (implemented) | `recipient_undeliverable` and the `recently_reminded` refinement for automatic reminders (§10; ADR-010 §27) |
| LB-18.5 | Production webhook activation: a separately approved infrastructure step, after the sending domain is owned and verified |

### 13. Historical sends

No backfill. Sends recorded before this migration have no ledger row and will show delivery status as unavailable.
Ledger rows are never fabricated from the latest-only provider columns.

### 14. Delivery status UI and manual send guardrails (LB-18.3, implemented)

**Member-visible status.** authenticated gains `SELECT (status)` on `email_deliveries`, under the existing member RLS
policy (owners and collaborators of the row's wedding). Nothing else is exposed: `provider_message_id` and
`status_event_at` keep no client grant (the UI shows no event times), `email_delivery_events` keeps no privilege for
any client role, anon has nothing, and no client role can insert, update or delete a delivery.

**Read model.** The guest page's existing single nested query (`listGuestParties`) also embeds each party's
`email_deliveries(kind, recipient, accepted_at, status)`; no event history and no per-party query. In memory
(`src/lib/guests/delivery-status.ts`):

- each "last sent" line shows the status of the latest delivery of its kinds (`accepted_at` desc), only when it is the
  send that line describes (same database clock as its `*_sent_at`, written in one transaction); otherwise, e.g. sends
  before LB-18.1, "Estado de entrega no disponible". It is shown next to, never instead of, "enviada el … a …", whose
  address is the one the status belongs to;
- the reminder line combines both reminder kinds (it already shows the latest reminder of either channel): the latest
  `accepted_at` wins and an automatic one is labelled "(recordatorio automático)", never presented as manual.

| Status | Copy | Manual email to the same current address |
|---|---|---|
| `accepted` | Enviado (never "Entregado") | allowed |
| `delayed` | Entrega retrasada | allowed (no warning) |
| `failed` | No se pudo enviar | allowed (no warning) |
| `delivered` | Entregado | allowed |
| `suppressed` | Bloqueado | blocked, warning |
| `bounced` | Rebotó | blocked, warning |
| `complained` | Marcado como spam | blocked, stronger warning |
| no ledger row | Estado de entrega no disponible | — |

**The current-address rule.** A party's CURRENT `contact_email` is blocked when a delivery of the SAME wedding, of any
kind and any party, has a `recipient` equal to it in the **comparison form** (the whole address trimmed and lowercased:
`private.email_comparison_form` in SQL, `normalizeEmailForComparison` in TypeScript) and status `suppressed`, `bounced` or
`complained`. Comparison only: stored recipients and contact emails keep their casing and are never rewritten, and
nothing provider-specific is applied (dots and `+tags` stay significant; no alias inference). It is one database
determination, `private.email_recipient_block(wedding, recipient)` (no client grant; an expression index on
`(wedding_id, email_comparison_form(recipient))`), returning the closed `email_recipient_block` (`none < suppressed <
bounced < complained`, strongest wins). Consequences: another wedding's history never counts (no cross-tenant
suppression, and the provider's account-wide suppression list is never used as tenant logic); a case-only edit is the
SAME address and stays blocked; a genuinely different address is never blocked by an old one; going back to the bad
address blocks again; a later successful delivery doesn't clear it. Old ledger rows are never rewritten. The page mirrors the rule only to decide
whether to show the warning ("No pudimos entregar correos a esta dirección. Revísala antes de volver a enviar." /
"Esta dirección marcó un correo como spam. Cambia el correo antes de volver a enviar."), next to the existing edit
control, and to disable the email-send controls ("Generar nuevo enlace y enviar", the fresh link's "Enviar invitación
por correo", "Enviar recordatorio", whose hint is replaced by the same warning). "Mostrar enlace", copying a link, the
WhatsApp text, "Generar nuevo enlace" and editing the address stay available. Disabled buttons are a convenience: the
server guard below refuses a forced submission all the same.

**Manual send guard.** `public.get_guest_invitation_email_block(wedding, party, recipient)`: SECURITY DEFINER only so the
private determination needs no client grant; it checks membership itself (`auth.uid()`), returns `null` for a party
that isn't the caller's or a `recipient` that is no longer exactly the party's stored current address (a staleness
check, not the block comparison), and returns nothing else (no
ids, statuses or history). `src/lib/guests/email-block.ts` calls it with the member's own session right after the party
and its recipient are loaded, before the link check, any rotation and the provider: the invitation email (fresh link),
the owner's "Generar nuevo enlace y enviar" and the manual reminder email. Blocked → `recipient_undeliverable` /
`recipient_complained`: no provider call, no rotation, no metadata, activity or ledger row. Any doubt (error, `null`)
fails closed. Not blocked: "Mostrar enlace" and the WhatsApp text. No override exists. "Manual reminders are never
blocked by automation" still holds: this is delivery safety, not automation state.

**RSVP confirmation.** The RSVP is still saved first, unchanged. `get_rsvp_confirmation_email_context` (service_role
only, ADR-005; recreated because its result type changed) also returns `contact_email_block` for the party's current
address. Blocked → the confirmation is skipped (`skipped_undeliverable`): no provider call, metadata or ledger row; the
guest sees no note (as when there is no address), the RSVP save never fails. No new service-role operation.

**Unchanged.** Automatic reminders (LB-17 eligibility, scheduler functions; `recipient_undeliverable` and the
`recently_reminded` refinement came in LB-18.4, §10), the ingest function, status rank rule and webhook route, the
event ledger's privileges, activity history (no delivery outcome rows), the latest-send columns. No production webhook
or secret.

## Consequences

- Every send recorded from LB-18.1 on is correlatable to a future provider event, per send and per kind.
- The record functions do one more insert in the same transaction; a provider-id collision (practically impossible
  with provider UUIDs) turns a send into `sent_but_unrecorded` instead of corrupting correlation.
- Deleting a party now also deletes its delivery rows; activity history is unaffected.
- No user-visible change in LB-18.1.
- LB-18.2: a delivery's status reflects the highest-ranked provider event received for it, with full event history;
  LB-17 execution state, latest-send metadata and activity history are untouched by webhooks (a bounce never turns
  `sent` into anything else).
- LB-18.3: organizers see each recorded email's delivery status and a warning for a bad current address; manual emails
  and RSVP confirmations to that address stop until it is edited. Automatic reminders still go out as before until
  LB-18.4.
- LB-18.4: automatic reminders skip a current address known undeliverable in the wedding (`recipient_undeliverable`,
  no attempt consumed) until a genuinely different address is set, and only recent sends to the current address
  count as `recently_reminded`. The production webhook stays inactive (LB-18.5), so in production no status beyond
  `accepted` exists yet and nothing is suppressed.
