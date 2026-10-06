# ADR-008 — Basic wedding activity history

Status: Accepted (LB-15) · Date: 2026-10-04
Related: [ADR-001 §2, §8](ADR-001-product-domain-and-tenancy.md), [ADR-002 §4, §6](ADR-002-auth-and-security-boundaries.md), [ADR-004](ADR-004-invitation-delivery-recorder.md), [ADR-005](ADR-005-rsvp-confirmation-email.md), [ADR-006](ADR-006-recoverable-rsvp-capability.md), [ADR-007](ADR-007-manual-rsvp-reminder-delivery.md), [Product Constitution §8](../product/PRODUCT-CONSTITUTION.md)

## Context

Constitution §8 lists "basic wedding activity history" in Phase 2, and ADR-001 §8 sketches it: a simple
`wedding_activity` log (actor, action, entity reference, timestamp, small metadata), with no governance event
model and no event sourcing.

Until LB-15, organizers only saw the *latest* state of each party: the last invitation, confirmation and
reminder email (`*_email_sent_at/_sent_to`), whether the link is revoked, and the current answers. They couldn't
tell when a party was created, when its link was replaced, or whether it answered once or changed its answer
three times. A future automatic reminder (LB-16) also needs durable facts such as "a reminder was successfully
recorded for this party", not just the latest send overwritten in place.

## Decision

### 1. What it is, and what it isn't

`public.wedding_activity` is a Wedding-scoped, chronological, **append-only** record of important, durable
GuestInvitation / RSVP facts. It answers organizer questions ("when did this party answer?", "who replaced the
link?") and nothing else.

It is not application logging, debugging output, analytics, browser telemetry, an event bus, an outbox or an
audit JSON dump. Nothing reads it to make decisions today.

### 2. Shape

| Column | Meaning |
|---|---|
| `id` | uuid, database default |
| `wedding_id` | the tenant; `not null`, FK to `weddings`, `on delete cascade` |
| `event_type` | closed enum `wedding_activity_event` (§3) |
| `guest_invitation_id` | the party the event is about; composite same-wedding FK, `on delete set null (guest_invitation_id)` |
| `actor_kind` | closed enum `wedding_activity_actor` (§4) |
| `actor_user_id` | member actors only; FK to `auth.users`, `on delete set null` |
| `occurred_at` | database clock, always |

There is **no payload column**: no JSON, no free text, no snapshot. Every field is typed, and copy lives in the
app's catalog (`es.activity`), so wording can change without rewriting history. ADR-001 §8's "small metadata"
turned out not to be needed by any LB-15 event; adding one later is a new decision, with whitelisted keys.

### 3. Event taxonomy (closed)

| Event | Written by (same transaction) | Actor |
|---|---|---|
| `guest_invitation_created` | `create_guest_invitation` | member (`auth.uid()`) |
| `guest_invitation_link_rotated` | `rotate_guest_invitation_link` | member (owner) |
| `guest_invitation_revoked` | `revoke_guest_invitation_link` (new, §5) | member (owner) |
| `guest_invitation_contact_email_changed` | trigger on the contact-email `UPDATE` | member (or system, §4) |
| `guest_invitation_email_sent` | `record_guest_invitation_email` (service_role) | member (attributed, §6) |
| `guest_rsvp_submitted` | `submit_guest_rsvp`, party had no saved answer | guest_capability |
| `guest_rsvp_updated` | `submit_guest_rsvp`, party had answers | guest_capability |
| `rsvp_confirmation_email_sent` | `record_rsvp_confirmation_email` (service_role) | guest_capability |
| `rsvp_reminder_email_sent` | `record_rsvp_reminder_email` (service_role) | member (attributed, §6) |

Not recorded: label or guest-name edits, guest additions/removals, party deletion itself (the party's rows stay,
§8), recovering a link ("Mostrar enlace": reading isn't a fact about the party), preparing a WhatsApp text (not
delivery, ADR-007), failed or unrecorded sends. No scheduler events exist.

**RSVP submitted vs updated.** Decided inside `submit_guest_rsvp`, under the party's row lock, from the stored
`rsvps` rows, never from the payload: no saved answer for any current guest → `submitted`, otherwise `updated`.
Every successful save is one row: the product treats each save as a new answer (it already sends a fresh
confirmation for each, LB-12), so an unchanged re-save is still `updated`. A refused submission (unknown,
revoked or expired link, malformed or mismatched payload) raises before anything is written: no answers and no
history.

**Contact email changed.** Members keep editing it with the plain, RLS-checked `UPDATE` of LB-11. An
`AFTER UPDATE OF contact_email` trigger (only when the value actually changes) appends the row in the same
statement. It records *that* the address was set, changed or removed, never the old or new address.

### 4. Actor taxonomy

- `member` — a signed-in member of that wedding. `actor_user_id` is required at insert (guard trigger).
- `guest_capability` — the holder of a party's RSVP link. No user id, and the token is never stored as an
  identity.
- `system` — no person: an automatic RSVP reminder sent under an owner-enabled policy (LB-17,
  [ADR-010](ADR-010-automatic-rsvp-reminder-scheduling.md); `rsvp_reminder_email_sent`, shown as "Automático"), or
  privileged maintenance outside the app's member flows (e.g. a contact-email change with no member session). It is
  never shown as `service_role`, and it never carries a user id: nobody clicked it.

`CHECK (actor_kind = 'member' or actor_user_id is null)`: guests and the system never carry a user id.

**Why the confirmation is `guest_capability`.** It exists because the party saved its RSVP through its link; no
member sent it, and pretending one did would be false. The server's service-role recorder is plumbing, not an
actor.

The page labels members the way the rest of the app does (`@/lib/weddings/members`: "Tú", the display name, or
the role fallback), from the membership the read function resolves. A member who has left the wedding (or whose
account was deleted) reads as "Por alguien que ya no está en la boda". Never an email or id.

### 5. Atomicity: the history row is written by the business function

Every row is inserted **inside the PostgreSQL function that performs the fact**, after its business write, in
the same transaction. If the insert fails, the business write rolls back, and the other way round. The app (and
React) never writes history, and there is no "append event" API anywhere.

Revocation used to be a plain client `UPDATE (revoked_at)` (LB-09). An `UPDATE` can't append a row atomically
with the app's cooperation alone, so LB-15 adds `revoke_guest_invitation_link(wedding, party)`: SECURITY DEFINER,
the same authorization as before checked from `auth.uid()` (non-member → `false`, collaborator →
`guest_link_owner_only`), stamps the database clock, appends `guest_invitation_revoked` only when it actually
revoked (an already revoked link is a no-op success with no new row). The client `UPDATE (revoked_at)` grant is
revoked, so it is the only door, like rotation (ADR-006 §5). The link guard trigger stays as a backstop.

### 6. Email events: only after the provider accepted AND the record committed

The three recorder RPCs (ADR-004/005/007) now write their metadata **and** the history row in one transaction.
So:

- provider refused → the recorder is never called: no metadata, no history;
- provider accepted, record failed (wrong recipient, stale link, revoked/expired for reminders, bad id,
  unverifiable actor) → **neither** metadata **nor** history, and the outcome stays `sent_but_unrecorded`. No
  history row is fabricated for a send the system couldn't durably record, and nothing is retried.

**Member attribution through the service-role recorder.** `service_role` is not the human actor. The invitation
and reminder emails are explicit member actions, so their records take `acting_user_id`.

The application derives the initiating member from the authenticated `WeddingAccess` context. The service-role
recorder verifies that the attributed user is a member of the target Wedding before recording the event. The user
id is used only for attribution and never as authorization. Precisely:

- the Server Action's service derives `acting_user_id` from `WeddingAccess.userId` (the authenticated
  `auth.getUser()` identity of its own membership check); it is never accepted from browser or form input;
- the actual authorization to send happens there, in the authenticated application flow, before the provider call;
- `delivery-recorder.ts` passes that identity through its narrow named operation (`recordInvitation`,
  `recordRsvpReminder`), unchanged;
- the service-role RPC independently verifies only that `acting_user_id` is currently a member of the target
  Wedding (otherwise nothing is recorded, metadata included). It does not, and can't, prove which person clicked:
  it trusts the server that holds the service-role key to pass the identity it authenticated;
- `acting_user_id` grants no authority; no client-executable function accepts an actor user id (a schema test
  pins that only these two service_role-only functions take one).

The recorder module still exposes only its four named operations; it gained a parameter, not a generic writer.

### 7. Append-only enforcement

- Clients (anon, authenticated) have no `INSERT`, `UPDATE` or `DELETE` privilege; members have `SELECT` through
  the `wedding_activity_select_member` RLS policy.
- A guard trigger applies to **every** role, including the functions' owner and `service_role`:
  - `INSERT`: member actors must name their user; every LB-15 event must name its party; `occurred_at` is
    overwritten with the database clock;
  - `UPDATE` / `DELETE`: refused (`wedding_activity_append_only`) unless they come from a foreign key's own
    referential action (trigger depth ≥ 2), and an `UPDATE` may then only null `guest_invitation_id` or
    `actor_user_id`.
- What this does and doesn't guarantee: `service_role` is globally privileged in Supabase by design, and a
  superuser can disable triggers. The guarantee is the app boundary (no client grant, no app code path that
  writes history except the named business functions) plus a trigger that refuses ordinary edits from every
  role. It is not a claim that PostgreSQL superusers are restricted.

### 8. Deletion and retention

- **Wedding deleted** → its history is deleted (`on delete cascade`): the tenant no longer exists.
- **Party deleted** → its rows stay, with `guest_invitation_id` nulled (`on delete set null (guest_invitation_id)`;
  the column list keeps `wedding_id`). The page shows "Grupo eliminado". No label snapshot is stored, so the
  deleted party's name is gone with it (no PII duplication).
- **Member removed** → rows keep `actor_user_id`; the page shows the former-member fallback.
- **Account deleted** → `actor_user_id` is nulled; the row still says a member did it.

Labels are the party's **current** label, joined at read time.

### 9. Excluded data

Never stored in or returned by activity: plaintext tokens, `token_hash`, envelopes, RSVP URLs, attendance answers,
dietary or other notes, contact or recipient email addresses (latest-send columns already keep the latest
recipient; history doesn't duplicate that PII), provider message ids, provider payloads, IP addresses, user
agents, cookies and request headers.

### 10. Read model

`get_wedding_activity(target_wedding_id, max_events default 50)`: SECURITY INVOKER (RLS decides), newest first
(`occurred_at desc, id desc`), at most 50 rows whatever is asked. It returns `id, event_type, occurred_at,
guest_invitation_id, party_label` (current, null when deleted)`, actor_kind, actor_membership_id` (only while that
member is still in the wedding). Index `(wedding_id, occurred_at desc, id desc)` serves it; `(guest_invitation_id,
wedding_id)` serves the party FK's `SET NULL`. No pagination yet.

The page `/app/weddings/[weddingId]/activity` ("Actividad") is member-only (same 404 for non-members), secondary
to the checklist, and shows event, party, actor and time (wedding time zone, else UTC, like the rest of the app).

### 11. No backfill

The migration inserts **zero** rows. Earlier facts can't be reconstructed reliably (latest-send columns are
overwritten, revocation times say nothing about who), so inventing them would be fabricated history.
**Activity history begins when LB-15 is deployed.** The empty state says so.

### 12. Future scheduler (LB-16) compatibility — and what this is not

*Later note (LB-17):* the scheduler is [ADR-010](ADR-010-automatic-rsvp-reminder-scheduling.md). As this section
required, it brings its own policy, due calculation, identity (`system`), dedupe key (`UNIQUE` occurrence per party),
claims and leases in `public.automatic_rsvp_reminders`; activity history is still never read as a lock or dedupe key.
An automatic send appends the existing `rsvp_reminder_email_sent` event with actor `system`, written only by
`record_automatic_rsvp_reminder_email` in the same transaction as the metadata. Claims, skips, retries, failures and
uncertain outcomes write no history. No new event type was added.

*Later note (LB-16):* LB-16 became checklist ↔ guest work ([ADR-009](ADR-009-checklist-guest-work.md)), which adds
no events. The scheduler below is still deferred, to a later prompt.

History gives a future scheduler durable, successful-only facts such as "an `rsvp_reminder_email_sent` row exists
for this party after time T" (indexable by party). It is **not** the scheduler: no policy, no due calculation, no
scheduler identity (a `system` or dedicated actor would need its own authority decision; ADR-007 §7), no
idempotency or dedupe key, no claim/lock for in-flight sends. A scheduler decision must add those itself, and may
add an index such as `(guest_invitation_id, event_type, occurred_at desc)` when a real query needs it.

## Consequences

- Organizers get a trustworthy timeline of the guest-list lifecycle, attributed to a member, the party's link or
  (rarely) the system.
- Every business function on the guest path now writes one more row; failure of either rolls back both.
- Revocation moved from a column grant to an RPC (no permission change: still owner-only).
- The invitation and reminder recorders take one more argument (the attributed member, membership-checked).
- History is lost with the wedding, and party names are not retained after the party is deleted, by design.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Writing history from the app after the business call | Not atomic: the app can crash between the two, leaving facts without history (or history without facts). |
| A generic `append_activity(type, payload)` function or service-role helper | Any caller could write arbitrary history; the point is that only the fact's own function writes it. |
| A JSON payload / snapshot column | Unbounded, invites PII and capability leaks; nothing needs it yet. |
| Recording the recipient address on email events | Duplicates PII already kept (latest) on the party; history needs "when" and "who", not "to whom". |
| Attributing recorder events to `service_role`/`system` | False: a member initiated the send. Attribution uses the application's authenticated identity, membership-checked by the recorder; it grants nothing. |
| Trusting a browser-sent actor id | Forgeable; the id comes from the server's own `auth.getUser()` and is re-checked. |
| Keeping the client `UPDATE (revoked_at)` grant plus a trigger | Workable, but rotation already has one door (ADR-006); revocation follows the same shape. |
| `ON DELETE CASCADE` from the party | Deleting a party would erase the wedding's record of what happened to it. |
| Backfilling from latest-send columns | Not reliable (overwritten, no actor), so it would be fabricated history. |
| Event bus / outbox / domain-event framework | A table and nine inserts are the whole requirement. |
