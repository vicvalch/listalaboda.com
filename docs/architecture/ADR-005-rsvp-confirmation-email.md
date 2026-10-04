# ADR-005 — Service-role exception: RSVP confirmation email

Status: Accepted (LB-12) · Date: 2026-10-04
Related: [ADR-002 §5, §6](ADR-002-auth-and-security-boundaries.md), [ADR-004](ADR-004-invitation-delivery-recorder.md), [Product Constitution §8](../product/PRODUCT-CONSTITUTION.md)

## Context

LB-12 emails a party a confirmation of its answers after it saves its RSVP through its link
("GuestInvitation and RSVP confirmation emails via Resend", Constitution §8), and shows organizers
the latest successful confirmation (`guest_invitations.rsvp_confirmation_email_sent_at`, `_sent_to`,
`_provider_id`).

ADR-004 is deliberately narrow: it accepts one service-role use, recording provider-accepted
**invitation** emails, with one RPC and no reads, and says any other use needs its own justification.
The confirmation needs two privileged steps ADR-004 doesn't cover, so this ADR records them instead of
stretching ADR-004.

1. **Recording the send.** Same problem as ADR-004: a client credential can't vouch for a provider
   result. Here the caller is a guest without an account, so the only client credential is anon, which
   anyone has.
2. **Reading the recipient and the wedding context.** The RSVP request carries only the guest's
   capability (the token in the httpOnly handoff cookie) and anon. The recipient is the party's
   `contact_email` (PRIVATE, members only), and the wedding's name, date and city are private unless
   published. Guest functions must never return these: the token holder would read them straight from
   PostgREST with the public key (CLAUDE.md LB-11, LB-10; ADR-002 §7). Postgres can't tell "the server
   after a successful RSVP" from "the guest calling the same function with the same hash". So any
   function that returns the contact email and that anon can execute leaks it to every link holder.

So only a credential the guest never holds can read the confirmation context, and only the same kind of
credential can record the send.

## Decision

Extend the existing single service-role module with two more named operations. Don't add a new module or
a generic client.

- **Database** (both SECURITY DEFINER, `search_path = ''`, EXECUTE revoked from PUBLIC, anon and
  authenticated, granted to `service_role` only):
  - `get_rsvp_confirmation_email_context(invitation_token_hash)`: one row, only while that link is
    usable (same unknown/revoked/expired rule as the guest functions). It returns the party's wedding
    id and id, its contact email (or null), and the wedding's name, date and city. It returns no guests,
    answers, notes, members, other parties or hashes. It is keyed by the capability the server already
    holds, so this function can't be used to browse parties.
  - `record_rsvp_confirmation_email(wedding, party, token_hash, recipient, provider_id)`: the only
    writer of the three confirmation columns. Scope: one party in its wedding, behind its current link.
    The recipient must equal the party's current contact email. The provider id is bounded and the time
    comes from the database clock. It writes nothing else: no tokens, guests, RSVPs, invitation-email
    metadata, publication or wedding data.
- **Application:** `src/lib/email/delivery-recorder.ts` stays the one module that reads
  `SUPABASE_SERVICE_ROLE_KEY`. It never exposes the privileged client. Its surface is exactly
  `recordInvitation` (ADR-004), `readRsvpConfirmationContext` and `recordRsvpConfirmation`, each calling one
  fixed RPC. No generic `from()`, `rpc(name, …)`, query, raw client or privileged helper reaches the rest of
  the application.
- **What this does and doesn't guarantee:** `service_role` is globally privileged by design in Supabase
  (it bypasses RLS and holds broad grants); this ADR doesn't change that. The guarantees here are at the
  application boundary (the key is used only in that module, through those three operations) and, in the
  database, that the two LB-12 functions are executable only by `service_role`. They are not a claim that
  the role itself is limited to these functions.
- **Order** (`@/lib/rsvp/confirmation`):
  1. The guest capability and the RSVP write stay exactly as in LB-09: `submit_guest_rsvp`, as anon, by
     token hash.
  2. Only after that commits does the server read the email configuration, then the privileged context.
  3. The public-site address comes from the existing guest helper.
  4. The email is rendered from the database's post-save result, never the form.
  5. One provider call.
  6. The recorder runs only after the provider accepted, with the provider's own id.

  The application never uses the service role to submit, update or authorize an RSVP, or to validate a
  token on its own. If the RSVP fails, nothing privileged runs.
- **RSVP is primary.** No email outcome can roll back or hide a saved RSVP. A missing configuration
  (including the key) means `not_configured`. A provider failure is `provider_failed`. A successful send
  that couldn't be recorded is `sent_but_unrecorded`, which is never "not sent" and is never retried.

## Consequences

- Guests confirm without an account. A guest never learns the stored contact email, and nobody can forge
  confirmation status.
- The service-role key now also enables confirmations. Without it, RSVPs work exactly as before and
  simply send no confirmation.
- The application's privileged surface grows from one fixed operation to three. It is still one module,
  every operation is named and scoped, and the tests pin each LB-12 function's grants (catalog and live calls).
- Any further service-role use still needs its own ADR.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| A guest (anon) function returning the contact email for the confirmation | Every link holder could read the party's private contact email directly from PostgREST. |
| Taking the recipient from the RSVP form | The browser is not authoritative, and it would turn the RSVP page into a send-anything relay. |
| Running the RSVP write as service_role | Replaces the capability boundary with a privileged bypass (ADR-002 §5). |
| A combined service-role "submit and get email" function | Same: the privileged path would be doing the guest's write. |
| Putting the RSVP link in the confirmation ("Modificar respuesta") | Redistributes the bearer capability in a second, more forwardable email; also needs the plaintext token, which is never stored. |
| Stretching ADR-004's text to cover this | ADR-004 explicitly scopes itself to one write with no reads; widening it silently would hide the new read. |
