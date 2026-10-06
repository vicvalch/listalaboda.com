# ADR-002 — Authentication and Security Boundaries

Status: Accepted (LB-01) · Date: 2026-09-30
Related: [Product Constitution](../product/PRODUCT-CONSTITUTION.md), [ADR-001](ADR-001-product-domain-and-tenancy.md)

## Context

listalaboda.com stores private wedding data (plans, budget, guest PII) for many
unrelated couples in one database, and will later expose narrow slices of it to
guests who have no account and to the public.

Donor evidence:

- WFM's admin uses a **single shared password** from an env var with an
  HMAC-signed cookie — acceptable for one couple's site, unacceptable for a
  multi-wedding product.
- WFM's RSVP API persists through the **service-role key**, bypassing RLS.
- WFM stores `invite_token` in **plaintext**, joins on it, and carries it in a
  `?token=` query string.
- WFM schema changes were **hand-run in the Supabase SQL editor**.
- PMFreak uses Supabase Auth with `@supabase/ssr` and versioned CLI migrations,
  but wraps them in governance machinery (governed actions, AOC/Frontera) that
  this product does not need.

## Decision

### 1. Stack

| Concern | Choice |
|---|---|
| Framework | Next.js (App Router) + React |
| Language | TypeScript (strict) |
| Package manager | npm |
| Database | Supabase Postgres |
| Auth | Supabase Auth via `@supabase/ssr` (cookie sessions) |
| Hosting | Vercel |
| Email | Resend (introduced in Phase 2, or MVP if MembershipInvite email is pulled in) |
| Unit/integration tests | Vitest |
| E2E tests | Playwright |
| Styling | Tailwind CSS (donor familiarity; final in LB-02) |

Rationale: both donors use this stack; it minimizes new learning and risk.

### 2. How each actor authenticates

| Actor | Mechanism |
|---|---|
| Couple owner / collaborator | Supabase Auth account, email-based (magic link and/or email+password; exact methods fixed in the auth implementation prompt). Social login deferred. |
| Planner | Same as couple: personal Supabase Auth account, access only via explicit wedding membership. **No `planner` role in the MVP**: a professional planner joins only through a MembershipInvite as an ordinary `collaborator` and gets exactly the collaborator permission set. Planner-specific roles and permissions are Phase 3. |
| Platform admin | No in-app admin surface in MVP. Operations through the Supabase dashboard / CLI by named accounts. If an in-app admin is ever built: an explicit server-checked allowlist table, never `user_metadata`, never a shared password. |
| Guest (Phase 2) | No account. Scoped GuestInvitation token (see §5). |

### 3. Server-side authorization

- Every protected route, server action and route handler:
  1. validates the session server-side (`supabase.auth.getUser()` — never trusts
     an unverified cookie/session payload);
  2. resolves the user's membership and role for the target wedding from the
     database;
  3. checks the capability for that role.
- Authorization logic lives in **one** server module, used by all entry points.
- Client components never decide access; UI hiding is cosmetic only.
- The `wedding_id` in a URL or request body is a *lookup key*, never proof of access.

### 4. RLS

- RLS is **enabled in the same migration that creates each table**. No table in
  the exposed schema exists without RLS.
- Policies are expressed through a few `SECURITY DEFINER` helper functions with
  fixed `search_path` (e.g. `is_wedding_member(wedding_id)`,
  `has_wedding_role(wedding_id, role)`).
- RLS is the **backstop**: the server check (§3) runs first; RLS ensures a bug
  in it cannot leak another wedding's data.
- RLS policies are covered by automated tests (cross-wedding access attempts
  must fail).

### 5. Token model (MembershipInvite and GuestInvitation)

Applies to two distinct token kinds:

- **MembershipInvite** (MVP): invites a future authenticated member (`owner` |
  `collaborator`) into one Wedding; accepting requires a user account.
- **GuestInvitation** (Phase 2): grants a guest household/party access to its
  invitation and RSVP; no user account required.

- Generated with a CSPRNG, ≥ 256 bits, URL-safe encoded.
- **Only a hash is stored** (SHA-256 is sufficient for high-entropy tokens);
  plaintext exists only in the link sent to the recipient.
  *Later note (LB-13):* the plaintext is still never stored, and the hash is still the only
  validator. GuestInvitation tokens are now also stored as an AES-256-GCM envelope, under a key
  kept outside the database, so organizers can recover the same link
  ([ADR-006](ADR-006-recoverable-rsvp-capability.md)). MembershipInvites are unchanged.
- Scoped to exactly **one wedding** and **one GuestInvitation** (guest) or
  **one intended role** (MembershipInvite).
- **Expiring** (MembershipInvites: short-lived, single-use; GuestInvitation tokens:
  valid until a defined point after the wedding) and **revocable** (owner can
  revoke/regenerate).
- Never used as a join key between tables — rows reference each other by UUID FKs.
- On arrival, the token is exchanged for a short-lived, httpOnly, scoped cookie
  and the URL is redirected without the token, to limit leakage via history,
  referrers and logs.
- **Open RSVP: NO.** **Guest account required: NO.**
- Guest operations run through narrow server endpoints backed by
  `SECURITY DEFINER` database functions that take the token hash and can only
  read/write that GuestInvitation's rows. Anonymous clients get no direct table access.

### 6. Service-role policy

- The service-role key is **exceptional**: never the default persistence path,
  never in client bundles, never in `NEXT_PUBLIC_*` variables.
- Each use is isolated in a clearly named server-only module with a written
  justification (e.g. a scheduled job). Guest flows should not need it (§5).
- Code review rejects new service-role usage without that justification.
- Accepted exceptions: [ADR-004](ADR-004-invitation-delivery-recorder.md) (recording provider-accepted
  invitation emails; LB-11), [ADR-005](ADR-005-rsvp-confirmation-email.md) (reading a party's private
  confirmation context by its link's hash and recording provider-accepted RSVP confirmations; LB-12) and
  [ADR-007](ADR-007-manual-rsvp-reminder-delivery.md) (recording provider-accepted manual RSVP reminders;
  LB-14). All are in the same single server-only module. Since LB-15 ([ADR-008](ADR-008-basic-activity-history.md))
  each record also appends its activity-history row in the same transaction; no operation was added.
- *Later note (LB-18.1):* [ADR-011](ADR-011-email-delivery-observability.md) makes each of the four record functions
  (including ADR-010's automatic one) also insert one `email_deliveries` ledger row in the same transaction. No
  service-role module, operation or RPC was added, and the ledger has no other writer.
- *Later note (LB-17):* [ADR-010](ADR-010-automatic-rsvp-reminder-scheduling.md) accepts a **second** service-role
  module, `src/lib/scheduler/rsvp-reminder-store.ts`, for the automatic RSVP reminder scheduler, which runs with no
  session. It exposes exactly five named operations (claim, prepare, begin, record, finish), each one fixed
  service_role-only RPC, and reads a claimed party's capability envelope only while it is eligible. No generic
  client. ESLint allows `SUPABASE_SERVICE_ROLE_KEY` only in that file and `delivery-recorder.ts`. Its route is
  authenticated by `CRON_SECRET` (read only in `src/lib/scheduler/cron-auth.ts`); the production cron entry is a
  separately approved deployment step.

### 7. Public / private boundary

| Class | Access | Examples |
|---|---|---|
| PRIVATE | Wedding members (RLS) | Checklist, notes, budget, vendors, contracts, guest list, members |
| SHARED | One token holder, one GuestInvitation | A household's GuestInvitation, its guests' RSVP |
| PUBLIC | Anyone with the link | Published ceremony/reception info, schedule, FAQ, dress code |

- Wedding fields are **private by default**. Content becomes public only through
  an explicit publish action on specific content sections.
- Public reads go through a dedicated read path (view/function) that returns only
  published content, never the raw `weddings` row.
- Guest PII is never public.

### 8. Fail-closed behavior

- Missing session, missing membership, unknown role, expired/revoked token,
  configuration error → **deny**.
- Denial for an inaccessible or nonexistent wedding returns the same response
  (404-equivalent), so existence is not revealed.
- Errors shown to users never include other weddings' identifiers or data.

### 9. Constitutional authorization principles

1. Client-supplied `wedding_id` never establishes authority.
2. Every protected request resolves membership server-side.
3. RLS is the database backstop.
4. Service role is exceptional, not normal.
5. Guest capabilities are explicit and narrow.
6. Missing authorization fails closed.
7. Denials do not reveal whether inaccessible weddings exist.
8. Tokens are hashed at rest.
9. Public wedding content is explicitly published content.

### 10. Database and migration discipline (constitutional)

- Postgres; UUID primary keys; real foreign keys; `wedding_id` on all
  wedding-owned data; normalized core entities; JSON only for genuinely flexible
  metadata; `created_at`/`updated_at` timestamps; soft deletion only where
  justified (none planned for MVP).
- No text-token joins.
- **Supabase CLI migrations** under version control in `supabase/migrations/`,
  named `YYYYMMDDHHMMSS_lb_<slug>.sql`.
- Applied migrations are **immutable**; fixes are new migrations.
- **No hand-run production SQL.** Production changes only via the migration pipeline.
- Generated DB types are committed and checked against the schema in CI
  (schema-contract verification).
- Staging and production migration histories are compared before each
  production release (parity check).

## Consequences

**Positive**
- Defense in depth: server checks + RLS + narrow token functions.
- Tenancy leaks require two independent failures.
- Guest access is safe without guest accounts.
- Familiar stack for both donor codebases.

**Negative / accepted costs**
- RLS and `SECURITY DEFINER` functions need careful testing.
- Token exchange adds a redirect step.
- Supabase lock-in for auth; acceptable at this stage.

## Rejected Alternatives

| Alternative | Why rejected |
|---|---|
| Shared admin password (WFM) | No per-user identity, no revocation, no multi-wedding isolation. |
| UI-only authorization | Trivially bypassed. |
| Service role as default persistence | Disables RLS; one bug leaks every wedding. |
| Plaintext tokens / token joins (WFM) | DB read = full guest impersonation; tokens leak through logs. |
| Guest accounts | Friction kills RSVP completion; unnecessary with scoped tokens. |
| Open RSVP | Spam, impersonation, uncontrolled headcount. |
| Auth.js/NextAuth or Clerk | Adds a second identity system next to Supabase RLS. |
| Authorization from `user_metadata` | User-editable; not a trust source. |
| PMFreak/Frontera governed-action architecture | Governance complexity the product explicitly rejects. |
| Hand-run SQL in the Supabase editor (WFM) | No history, no parity, no review. |
