# ADR-004 — Service-role exception: recording invitation-email delivery

Status: Accepted (LB-11) · Date: 2026-10-03
Related: [ADR-002 §6 — Service-role policy](ADR-002-auth-and-security-boundaries.md), [Product Constitution §8](../product/PRODUCT-CONSTITUTION.md), [ADR-005](ADR-005-rsvp-confirmation-email.md)

> Later note (LB-12): this decision is unchanged. [ADR-005](ADR-005-rsvp-confirmation-email.md) separately
> accepts two more named operations in the same module, for RSVP confirmation emails. Since then, this ADR's
> `record(...)` is named `recordInvitation(...)`.
> LB-14: [ADR-007](ADR-007-manual-rsvp-reminder-delivery.md) adds a fourth, `recordRsvpReminder(...)`, for manual
> RSVP reminder emails; same module, same rules.
> LB-15: [ADR-008](ADR-008-basic-activity-history.md): `record_guest_invitation_email` also appends the send's activity
> row in the same transaction, and takes the acting member (`acting_user_id`, from the action's own session check,
> re-checked as a member of the wedding) for attribution only. Still service_role-only; no new operation.

## Context

LB-11 sends a party's invitation email through Resend and shows organizers the latest successful send
(`guest_invitations.invitation_email_sent_at`, `_sent_to`, `_provider_id`). That status must reflect
something the provider actually accepted, so clients must not be able to write it.

Server Actions reach Postgres with the **user's own session**: their JWT plus the public publishable key.
That is exactly the request the user's browser can send to PostgREST itself. Inside Postgres, "the Server
Action just got a provider success" and "a member is calling the RPC directly" are indistinguishable:
same role (`authenticated`), same `auth.uid()`, same claims. Any function executable by `authenticated`
therefore lets a member fabricate a send (a made-up provider id for a party whose link they hold), no
matter what else it checks.

Only a credential the browser never holds can vouch for the provider's answer.

## Decision

One narrow service-role exception, per ADR-002 §6:

- **Database:** `public.record_guest_invitation_email` is the only writer of the send metadata and is
  executable **only by `service_role`** (EXECUTE revoked from PUBLIC, anon and authenticated). Even for
  that caller it is narrow: one party, scoped to its wedding, the current link's hash, the party's current
  contact email as recipient, a bounded provider id, the database clock; it touches nothing else.
- **Application:** one server-only module, `src/lib/email/delivery-recorder.ts`, reads
  `SUPABASE_SERVICE_ROLE_KEY` (the only read allowed by ESLint), builds a client privately and exposes
  only `record(...)`, which calls that one function. No exported client, no generic privileged helper,
  no reads, no other writes. Missing/wrong configuration (including a publishable key) fails closed: email
  sending is then reported as not configured, before anything is sent.
- **Order:** authorization, party scope, recipient, current-link validation and token rotation all use the
  user's normal session first (`@/lib/authz/wedding`, RLS). The recorder runs only after the provider
  accepted the message, with the provider's own message id. It never participates in authorization.

## Consequences

- Members can't forge delivery status; the browser keeps every ordinary capability (contact email,
  parties, guests) through RLS.
- The service-role key becomes a deployment secret for email sending. It never reaches the browser
  (`NEXT_PUBLIC_*` is refused for it, and only server-only code reads it).
- Any other service-role use still needs its own justification and review; this ADR does not make the
  key a general tool.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Keep an `authenticated`-executable record RPC with extra checks | Still forgeable by any member holding the link (the problem above). |
| Provider webhook (signed Resend events) | A public endpoint, signature verification, event correlation and async status: much larger than LB-11 needs. Possible later for delivery/bounce events. |
| No persisted send status | Drops the operational "Última invitación enviada" status LB-11 calls for. |
