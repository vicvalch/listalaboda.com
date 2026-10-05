# ADR-007 — Manual RSVP reminder delivery

Status: Accepted (LB-14) · Date: 2026-10-04
Related: [ADR-002 §5, §6](ADR-002-auth-and-security-boundaries.md), [ADR-004](ADR-004-invitation-delivery-recorder.md), [ADR-005](ADR-005-rsvp-confirmation-email.md), [ADR-006](ADR-006-recoverable-rsvp-capability.md), [Product Constitution §8](../product/PRODUCT-CONSTITUTION.md)

> Later note (LB-15): [ADR-008](ADR-008-basic-activity-history.md): `record_rsvp_reminder_email` also appends
> `rsvp_reminder_email_sent` in the same transaction and takes the acting member (`acting_user_id`, from the action's
> own session check, re-checked as a member) for attribution only. §7's "activity history" is no longer deferred.

## Context

Constitution §8 lists "RSVP reminders" in Phase 2. LB-13 (ADR-006) made each party's current RSVP link
recoverable precisely so it could be shared again without rotating it: rotation kills the link the party
already holds, which is the opposite of what a reminder is for.

Organizers want two manual ways to nudge a party that hasn't answered (or to re-send its link):

1. an email to the party's contact email, carrying its personal RSVP link;
2. a ready-made message they paste into WhatsApp themselves.

Neither needs a schedule. Automatic reminders (cron, queues, policies, retries) are a separate and much
larger decision, and so is any messaging API (WhatsApp Business, Twilio, Meta Cloud API, SMS).

## Decision

### 1. Same capability, never a new one

A reminder carries the party's **current** RSVP link, recovered at the moment of the action through the
LB-13 primitive (`@/lib/guests/link-recovery`, `get_guest_invitation_recovery_envelope`, decrypt, re-check
the hash). Building a reminder never generates a token, never rotates, never revokes and never stores
anything about the link. Every absolute link is `guestRsvpUrl(token, APP_ORIGIN)`.

The link is recovered inside the Server Action, never taken from the browser: if an owner rotated the link
after the page loaded, the reminder carries the new one; if the link is revoked or expired, nothing is
sent.

When there is no recoverable link (a pre-LB-13 hash-only party, a lost or changed key, a tampered
envelope), no reminder is possible. The organizer is told so. Only an owner's explicit "Generar nuevo
enlace" (LB-09/LB-13) repairs it. A reminder never rotates silently, and a collaborator can't rotate
through one.

### 2. The reminder email carries the capability on purpose

The RSVP confirmation email (ADR-005) deliberately contains no RSVP link: it confirms an answer and must be
safe to forward. A reminder's whole purpose is to re-deliver the capability, like the invitation email
(LB-11). The reminder therefore contains `/rsvp/<token>`, and the confirmation still doesn't. Tests pin
both.

Content (fresh Spanish copy, `es.rsvpReminderEmail`, rendered by the pure `@/lib/email/rsvp-reminder`):

- the party's label;
- the wedding's name, date and city (each only if set);
- the current RSVP link (button and raw fallback);
- a "personal link" note;
- the public website only while it is published.

It never includes RSVP answers, food notes, members, ids, provider data, the hash or the envelope. Every
user value is escaped in HTML, and the subject is one bounded line.

### 3. Explicit, member-scoped, one attempt

- **Who:** owners and collaborators, the same as recovery. Outsiders get the usual 404. Anonymous callers
  and guest-link holders have no organizer operation at all.
- **When:** only on "Enviar recordatorio". There is no send on page load, recovery, RSVP, contact-email
  edits, guest edits, publication or rotation.
- **Recipient:** the party's `contact_email`, read from the database inside the action. A changed email
  is honoured at click time, and the browser never names a recipient. Without one, the email is
  unavailable; the WhatsApp text still works.
- **Order** (`@/lib/guests/rsvp-reminder`): authorize (the user's own session) → validate → email
  configuration and link key → party and current recipient (scoped to the authorized wedding) → recover
  the current link → wedding context → render → ONE provider call → only after the provider accepted,
  the privileged recorder. The provider is never reached before every check passes. The recorder is never
  reached before the provider accepted, and never authorizes.
- **Failures** never touch the link:
  - provider failure: nothing is recorded; no retry and no queue;
  - provider accepted but the record failed (or there was no provider id): `sent_but_unrecorded`, "don't
    send it again yet", never "not sent".

### 4. Metadata: latest successful email reminder only

`guest_invitations.rsvp_reminder_email_sent_at`, `_sent_to` and `_provider_id` sit next to, and are
separate from, `invitation_email_*` (LB-11) and `rsvp_confirmation_email_*` (LB-12). They follow the same
pattern:

- all three are set or none;
- the recipient and provider id are validated;
- members can read them, and no client can write them.

The organizer UI shows the three statuses separately ("Invitación", "Confirmación", "Recordatorio").
There is no activity history and no counter.

### 5. Recording stays in the ADR-004/005 module

Same problem as ADR-004: a member's session can't vouch for a provider result. `record_rsvp_reminder_email`
is SECURITY DEFINER, `search_path = ''` and executable **only by `service_role`**. It is reached only through
a fourth named operation, `recordRsvpReminder`, in `src/lib/email/delivery-recorder.ts`. That module still
exposes no client, `from()`, generic `rpc(name)` or query.

The function is narrow even for that caller:

- one party in its wedding;
- the given hash must be the party's current link, and it must still be usable (not revoked, not
  expired);
- the recipient must equal the current contact email;
- the provider id is bounded, and the time comes from the database clock;
- it writes only the three reminder columns.

This is a third named record operation in the existing exception, not a new privileged module. Recovery
and authorization still use the member's own session (ADR-006 §6).

### 6. WhatsApp: a prepared message, not a delivery

"Preparar mensaje para WhatsApp" is an explicit organizer action. It runs the same authorization and
recovery as above and returns plain text from the pure `@/lib/guests/rsvp-reminder-message`:

- a greeting to the party;
- a short reminder with the wedding's name and date (if set);
- the current link.

The organizer copies it and sends it themselves.

- No phone numbers are modelled, and no WhatsApp/Meta/Twilio/SMS API is used. Preparing the text makes no
  network request beyond the action itself.
- Preparing or copying it is not delivery. Nothing is recorded (no `whatsapp_sent_at`), and the UI never
  says "sent".
- No share URL is built. A `wa.me/?text=…` link would put the bearer token in a query string, which the
  project forbids (ADR-002 §5). Copying is the whole flow.
- The text exists only in that action's response and the component's state. It is never stored on the
  server, in the browser's storage or in a URL.

### 7. Still deferred

Automatic or scheduled reminders, reminder policies, background workers, queues, retries, messaging APIs,
phone numbers, delivery webhooks and activity history are deferred. A future scheduler must reuse this same
order and capability rule (recover, never rotate). It will also need its own decision on authority, because
nobody's session is present at 3 a.m.

## Consequences

- Organizers can nudge a party by email or WhatsApp any number of times, and the party's link never
  changes. The status of each channel stays distinct.
- The privileged surface grows by one named, scoped write (four operations in total, one module).
- Every reminder email re-distributes a bearer capability, as the invitation email already does. The
  confirmation email stays capability-free.
- Legacy and unrecoverable links need an owner's explicit new link before reminders work.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Rotate on every reminder | Kills the link the party already has; the product wants one stable personal link (ADR-006). |
| Accept the link (or token) from the page | Stale after a rotation, and the browser isn't authoritative; the server recovers it at action time. |
| Accept the recipient from the form | Turns the button into a send-anything relay; the recipient is the stored contact email. |
| An `authenticated`-executable record RPC | Any member could forge "reminder sent" (ADR-004). |
| Reusing `invitation_email_*` for reminders | Conflates two different emails; organizers need to tell them apart. |
| Recording WhatsApp "sent" | Copying text is not delivery; the app can't know whether it was sent. |
| `wa.me/?text=` share link | Puts the token in a query string (history, logs, referrers). |
| A scheduler/cron now | Needs its own authority model, rate limits and failure semantics; out of scope. |
