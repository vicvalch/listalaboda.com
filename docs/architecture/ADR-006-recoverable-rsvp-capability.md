# ADR-006 — Recoverable RSVP capability encryption

Status: Accepted (LB-13) · Date: 2026-10-04
Related: [ADR-002 §5, §6](ADR-002-auth-and-security-boundaries.md), [ADR-004](ADR-004-invitation-delivery-recorder.md), [ADR-005](ADR-005-rsvp-confirmation-email.md), [Product Constitution §8, §10](../product/PRODUCT-CONSTITUTION.md)

## Context

Each GuestInvitation (party) has one RSVP link, `/rsvp/<token>`: a 256-bit bearer capability. Until LB-12
only its SHA-256 hash was stored (ADR-002 §5), so the plaintext existed once, in the create/rotate result.
After a reload nobody could see the link again. Sharing it again meant **rotating** it, which kills the copy
the party already has.

The product wants the opposite. A party's link should stay the same personal link for its whole life, and
organizers should be able to share it again later: by copying it now, and through reminders, WhatsApp or
other channels later (Constitution §8, "RSVP reminders"). Rotating on every reminder would break the
links guests already hold, so it isn't an option.

That needs the server to get the same plaintext back later. The plaintext itself still must never be
stored: a database read (backup, dump, leaked replica, SQL access) would then hand out every party's
capability (ADR-002 rejected alternatives: "Plaintext tokens").

## Decision

### 1. Two stored forms, two jobs

- **`guest_invitations.token_hash`** (unchanged) is the **only validator**. A guest request hashes the
  incoming token and looks it up (`get_guest_invitation`, `submit_guest_rsvp`). That path never decrypts
  anything and doesn't know encryption exists.
- **An encrypted envelope** of the token is used **only for recovery**. It lives in
  `private.guest_invitation_capability_secrets` (one row per party). The server reads it only when an
  organizer explicitly asks for the link.

### 2. Cryptography

- AES-256-GCM from Node's built-in `crypto`. No new dependency and no hand-rolled primitives.
- A 256-bit key, a fresh random 96-bit IV for every encryption (the same token encrypted twice gives two
  different envelopes), and the 128-bit GCM tag.
- Associated data `listalaboda:rsvp-capability:v1:<tokenHash>` binds each envelope to the hash it belongs
  to.
- Envelope `v1.<iv>.<ciphertext>.<tag>`, each part base64url without padding. It is versioned so a future
  key migration can add `v2`. The parser is strict: exactly four parts, a known version, canonical
  base64url, exact IV, ciphertext and tag lengths, and a length cap. Anything else is refused before
  decryption.
- Recovery decrypts with the party's **current** hash as associated data. It then checks that the
  plaintext is a well-formed token and that its SHA-256 equals that hash (constant-time comparison).
  Wrong key, tampering, an envelope from another party, a stale envelope and malformed input all fail
  closed. They produce one generic result, with no detail.
- `src/lib/security/rsvp-capability-encryption.ts` is server-only and pure: settings parsing, encrypt,
  decrypt and envelope validation. It has no database access, no React and no logging.

GCM was chosen because it is authenticated (tampering is detected rather than producing garbage), it is
standard in Node, and it supports associated data, which provides the hash binding at no extra cost.

### 3. The key lives outside PostgreSQL

`RSVP_CAPABILITY_ENCRYPTION_KEY`:

- base64url of exactly 32 random bytes;
- server-only, never `NEXT_PUBLIC_*`;
- read in one module (ESLint blocks it everywhere else);
- never logged or returned.

A missing, malformed, wrong-length or whitespace-corrupted value is refused. **The app never generates a
key.** A key made up at boot would strand every envelope written under it.

Without a valid key, creating a party and rotating a link **fail before any write**: no new hash-only links
after LB-13. Recovery reports "not available" in that case. Guest RSVPs and everything else are
unaffected. Generating a key is an operator task (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`).
The output is a secret and is never committed.

### 4. Separate private storage

The envelope is more sensitive than ordinary guest-list data, so it is kept apart from it:

- It lives in its own table in the `private` schema, which is not exposed through the Data API. RLS is
  enabled with no policies, and nothing is granted to PUBLIC, anon or authenticated.
- It never appears in the guest-list projection (`listGuestParties`), in public functions (`/boda`) or in
  guest functions (`/rsvp`).
- Each row carries `wedding_id`, with a composite foreign key to its party in the same wedding (ADR-001 §2),
  and `ON DELETE CASCADE`. Deleting the party or the wedding deletes the envelope.
- Each row also carries the hash it is bound to. The database checks the envelope's v1 shape and length,
  but it cannot verify the cryptography and doesn't try.

### 5. Atomic create and rotate

The server generates the token, hashes it and encrypts it. The database receives only the hash and the
envelope, never the plaintext.

- `create_guest_invitation` writes the party, its guests, its contact email and its envelope in one
  transaction. It is now SECURITY DEFINER (it was SECURITY INVOKER), because the envelope table has no client
  grants. It enforces what the insert policy did, itself, from `auth.uid()`: signed in, a member of the target
  wedding, and `created_by` = the caller. It is the **only** way to create a party: the client INSERT grant on
  `guest_invitations` is revoked.
- `rotate_guest_invitation_link` writes the new hash and its envelope in one transaction. It is owner-only
  and the **only** way to rotate: the client `UPDATE (token_hash)` grant is revoked.
- A deferred constraint trigger enforces this for every role. At commit, a party whose hash was inserted or
  changed must have an envelope bound to that exact hash, or the transaction rolls back.

So a "hash rotated, envelope missing" or "envelope pointing at the wrong token" state can't commit. A
failed rotation leaves the old link and its old envelope current.

There is **no standalone envelope writer**. Only those two business functions write
`private.guest_invitation_capability_secrets`, inline. No client role can execute any other function that
touches it, and in `private` clients can execute only the two RLS helpers (`is_wedding_member`,
`has_wedding_role`). Tests pin this from the catalog. (An earlier draft used a separately granted
`private.store_guest_invitation_capability_secret` helper; it was removed before release.)

Revoking a link keeps its envelope, but recovery refuses revoked links. Generating a new link replaces the
envelope.

### 5a. One canonical URL per token

Every absolute RSVP link is the trusted `APP_ORIGIN` + `/rsvp/<token>`, built by one function
(`guestRsvpUrl`). That covers:

- the fresh link after creating a party;
- the fresh link after "Generar nuevo enlace";
- the link returned by "Generar nuevo enlace y enviar" and the one in its email;
- the fresh-link invitation email;
- the recovered link.

`APP_ORIGIN` is parsed once (`@/lib/http/app-origin`, reused by the email configuration). Request headers
(Host, Origin, X-Forwarded-Host, X-Forwarded-Proto) never shape an RSVP link, so the same token always gives
the same URL, and a spoofed request can't make the server mint a link to another host. Without a valid
`APP_ORIGIN`, creating parties and generating links refuse before any write; there is no header fallback.

### 6. Explicit, member-scoped recovery

Recovery is private wedding management. Owners and collaborators may recover a party's current link.
Rotation stays owner-only (service check plus database check).

The flow:

1. A member clicks "Mostrar enlace".
2. The Server Action calls `auth.getUser()` and the normal membership check (`@/lib/authz/wedding`).
3. `get_guest_invitation_recovery_envelope` runs: members only, one party, and it re-checks membership
   itself.
4. The server decrypts the envelope and re-checks the hash.
5. The server builds the absolute URL from `APP_ORIGIN` (never request headers). An email provider is not
   required.
6. Only that URL is returned to the browser.

What the browser and the page never get:

- The browser never receives the envelope.
- Page loads decrypt nothing.
- The guest-list HTML contains no links.
- Recovered links aren't cached, stored in the browser or logged.

Encryption is not authorization. The membership checks come first, and the key only adds the recovery
ability.

The database function returns `recoverable` (with the hash and envelope), `unavailable` (revoked or
expired, nothing else) or `legacy` (nothing else). It returns no row for non-members or unknown parties.

The hash is returned only next to an envelope the caller may recover anyway, so it reveals nothing beyond
the link they are entitled to see. That is a narrow, documented exception to "`token_hash` is never
readable through the API". Legacy parties never get their hash returned. The function still can't keep
the envelope away from a member who calls it directly with their own session. Any credential the server
uses for a member is one the member holds. That is acceptable: without the key the envelope is useless,
and the alternative (service role) would widen ADR-004/ADR-005's exception. No service role is used for
recovery.

### 7. Legacy (pre-LB-13) links

Existing parties have only a hash and nothing can rebuild their plaintext. The migration creates no fake
envelopes and rotates nothing:

- **Guest:** the existing link keeps working exactly as before, until it expires or is revoked.
- **Organizers:** recovery reports "legacy", meaning the link was created before it could be recovered
  safely.
- **Owner:** may explicitly generate a new link once. That kills the old link (as rotation always did) and
  makes the new one recoverable.
- **Collaborator:** is told that an owner must do it.

Nothing is rotated silently.

### 8. Threat model and trust boundary

| Compromised | Outcome |
|---|---|
| Database only (dump, backup, SQL read), key safe | Usable links stay protected: hashes can't be inverted (256-bit tokens) and envelopes can't be decrypted. |
| Key only, database safe | No envelopes or hashes to decrypt or use; the key alone reveals no link. |
| Database **and** key | Every recoverable party's current link can be decrypted. |

The third row is the trust boundary that recoverability unavoidably introduces. Before LB-13, even both
together revealed nothing, because nothing decryptable was stored. The key must therefore be kept like the
service-role key: in the deployment's secret store, apart from database backups and never in the repo.

### 9. Key loss and key change

- **Lost key:** every existing guest link keeps working, because the hash validates it. Server recovery
  fails ("No pudimos recuperar este enlace"). After a new key is configured, an owner repairs a party by
  explicitly generating a new link.
- **Changed key:** LB-13 has no keyring. Envelopes written under the old key become unreadable and fail
  exactly like a lost key. Nothing is silently re-encrypted. Key rotation with a keyring and a `v2`
  envelope can be a separate hardening milestone.
- **Missing key:** creating parties and rotating links fail safely, as described in §3.

### 10. Still deferred

Reminder delivery (email reminders, WhatsApp, schedules, cron, queues, rate limits, reminder metadata) is
not part of this decision. LB-13 only provides the same-link recovery primitive those features will use.
*Later note (LB-14):* manual reminders (email and a WhatsApp-ready text) now reuse this primitive without
rotating; see [ADR-007](ADR-007-manual-rsvp-reminder-delivery.md). Scheduling is still deferred.
The RSVP confirmation email (ADR-005) still carries no capability.

## Consequences

- Organizers can share a party's same current link again at any time. Future reminders can reuse it
  without rotating.
- A new deployment secret, `RSVP_CAPABILITY_ENCRYPTION_KEY`, is required to create parties and rotate
  links. Losing it costs recovery, never guest access.
- The "dump reveals nothing" property becomes "dump without the key reveals nothing" (§8).
- Pre-LB-13 links stay hash-only until an owner explicitly replaces them.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Store the plaintext token | A database read becomes every party's capability (ADR-002). |
| Rotate on every re-share or reminder | Breaks the link the party already has; the product wants one stable personal link. |
| Validate guests by decrypting stored envelopes | Puts the key on the guest path and makes validation depend on recovery; the hash stays the validator. |
| Encrypt inside PostgreSQL (pgcrypto) with the key passed in or stored there | The key would sit in the database (or in its query logs and settings), so a database compromise reveals everything. |
| Deterministic encryption, or a key derived from the token hash | Repeats ciphertexts; a hash-derived key is no secret at all. |
| A service-role recovery path | Widens the ADR-004/ADR-005 exception for no gain; membership is checked with the user's own session. |
| Envelope in a `guest_invitations` column | Too close to routine reads and projections; a separate private table keeps it off every ordinary surface. |
| Returning the envelope to the browser for a later server decrypt | The browser never needs it; only the final URL leaves the server. |
| Backfilling or auto-rotating legacy links | Their plaintext can't be reconstructed, and silent rotation would break links guests hold. |
