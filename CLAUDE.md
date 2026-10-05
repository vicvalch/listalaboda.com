@AGENTS.md

# listalaboda.com

Wedding-planning checklist for couples. Spanish-first. Next.js (App Router) + Supabase.

## Authoritative documents (they win over implementation convenience)

- `docs/product/PRODUCT-CONSTITUTION.md`
- `docs/architecture/ADR-001-product-domain-and-tenancy.md`
- `docs/architecture/ADR-002-auth-and-security-boundaries.md`
- `docs/architecture/ADR-003-donor-extraction-policy.md`
- `docs/architecture/ADR-004-invitation-delivery-recorder.md`, `docs/architecture/ADR-005-rsvp-confirmation-email.md`
  and `docs/architecture/ADR-007-manual-rsvp-reminder-delivery.md` (the only service-role exceptions, one module)
- `docs/architecture/ADR-006-recoverable-rsvp-capability.md` (recoverable RSVP link encryption)

## Product rules

- Couple-first, Wedding-first, checklist-first. The list is home.
- Spanish-first: UI copy lives in `src/lib/i18n/messages/es.ts`, never inline. Code and docs are in English.
- Wedding language, not PM language: no project/program/portfolio/stakeholder/workstream/task concepts.
- No AOC, Frontera, governance machinery or AI authority.
- Donor code (Wedding-Fran-Marilu, PMFreak) is never copied; study, then reimplement (ADR-003).

## Engineering rules

- Strict TypeScript. No `@ts-ignore`, no `any` to silence errors.
- RLS enabled in the same migration that creates any table.
- The service-role key is never normal persistence. Its only use is the ADR-004/ADR-005/ADR-007 exception
  (`src/lib/email/delivery-recorder.ts`: recording provider-accepted invitation, RSVP confirmation and RSVP
  reminder emails, and reading a party's confirmation context by its link's hash); there is no generic
  service-role client.
  Any other use needs its own `server-only` module plus a written justification (ADR-002 §6).
  ESLint blocks `process.env.SUPABASE_SERVICE_ROLE_KEY` everywhere else.
- Browser code reads env only through `src/lib/env/public.ts` (`NEXT_PUBLIC_*` only).
- Modules that touch cookies or secrets start with `import "server-only"`.
- Migrations live in `supabase/migrations/`, named `YYYYMMDDHHMMSS_lb_<slug>.sql`; applied
  migrations are immutable. No hand-run or direct production schema changes. No remote `supabase link`/`db push` without explicit approval.
- No hidden auth shortcuts: authority comes from server-side membership checks, never client input or `user_metadata`.
- Tests validate behavior, not source text.

## Auth and membership rules (LB-04)

- Server identity is `auth.getUser()` via `@/lib/auth/session` (`getCurrentUser`/`requireUser`),
  never `getSession()`, cookie presence or client input. Every protected page and Server Action calls
  it; the `/app` layout alone is not a security boundary.
- Wedding access goes through `@/lib/authz/wedding`; non-members get `notFound()` (same as a missing
  wedding). Don't re-implement membership checks.
- `src/proxy.ts` only refreshes the Supabase session. No authorization or redirects there.
- Every redirect target from input (`next=`, callbacks) goes through `safeNextPath`.
- Invite tokens: plaintext only in the one link shown to the owner, the `/invite/[token]` path and the
  httpOnly `lb_membership_invite` handoff cookie. Never log, persist, put in `next=`/query strings,
  error text or client storage. Acceptance is an explicit POST through `accept_membership_invite`.
- Code that reads cookies must not swallow Next's dynamic-rendering signal inside `try/catch`, or the
  route gets prerendered as signed-out.

## Checklist rules (LB-05)

- The checklist is the Wedding home: `/app/weddings/[weddingId]` opens on it; people/invites are secondary.
- `checklist_templates`/`checklist_template_items` are global, versioned reference data. Clients have no
  privileges on them; content changes ship as a new `(key, version)`, never by editing a shipped version.
- `checklist_items` is wedding-owned mutable data. Applying a template copies; it never live-links.
- Seeding goes only through the owner-only, at-most-once `initialize_wedding_checklist` RPC. No
  auto-seed in `create_wedding`, no reset/resync to the template.
- Owners and collaborators both manage checklist content (add/edit/status/delete) through `@/lib/checklist/service`.
  `created_by`/`completed_by` are provenance only, never authority.
- Status is exactly `pending | done | not_applicable`; the database stamps `completed_at`. Store timing
  rules (`relative_days`, negative = before the wedding), derive effective dates; never persist them.

## Planning rules (LB-06)

- Persisted order (`sort_order`) and planning order are different things. Planning order (Plan view,
  "Lo próximo") is derived in memory by `@/lib/checklist/planning`; never write `sort_order` to provide it.
- Effective due dates are derived from the *current* `weddings.wedding_date` + `relative_days` through
  `@/lib/checklist/timing`; never persist them or rewrite items when the wedding date changes.
  Absolute dates never move. Clearing the wedding date never clears `relative_days`.
- Wedding settings (name, date, city, time zone) are owner-only through `updateWeddingSettings` in `@/lib/weddings/service`.
- "Today"/overdue only through the wedding time zone (LB-08 rules below); never server or browser local time.
- Categories stay the fixed enum (Constitution §5); custom categories are Phase 3.

## Assignment rules (LB-07)

- An item has at most one assignee: `checklist_items.assignee_membership_id`, a `wedding_memberships.id`
  of the SAME wedding (composite FK; never an auth user id, never a MembershipInvite). Null = "Sin asignar".
- Assignment is planning metadata, never authorization: don't restrict reads/edits to the assignee, and
  never let assigning change status, timing or `sort_order`. Any member may assign anyone in the wedding.
- "Mis pendientes" (`view=mine`) = items whose assignee is the caller's own membership, resolved server-side
  (`WeddingAccess.membershipId`), never from client input. `view` is presentation, not a boundary.
- `wedding_memberships.display_name` is wedding-scoped presentation identity. Only the member themselves sets
  it, through the `set_wedding_display_name` RPC (no table grant; it would widen role updates). Never derive
  names from emails; never show emails or user/membership ids as labels (`@/lib/weddings/members`).

## MVP completion rules (LB-08)

- `weddings.time_zone` is an IANA identifier (never an offset), validated by the database; null is valid.
  Never infer it (browser, server, IP, UTC); a device suggestion is only an explicit, visible, editable action.
- Overdue = `pending` + effective due date strictly before the wedding-local today (`@/lib/weddings/timezone`
  `weddingLocalToday`, from one server clock read per request). Due today is not overdue; no time zone means
  nothing is overdue. Overdue is derived (`@/lib/checklist/overdue`), never a status or a stored column.
- `weddings.city` is optional plain text (trimmed, blank = null); not a venue, address or geocode.
- Removing a member deletes one `WeddingMembership` (owner-only, `removeWeddingMember`), never the auth user,
  their other memberships or checklist items. Assigned items become unassigned via the FK. The generic removal
  flow never removes the caller (no "leave wedding"), and the final owner stays database-enforced.

## Guest list and RSVP rules (LB-09)

- MembershipInvite != GuestInvitation. A MembershipInvite makes an authenticated member; a
  GuestInvitation (`guest_invitations`) is one household/party's RSVP capability. Never share a table,
  service or token semantics between them (only the crypto primitive `@/lib/security/capability-token`).
- Guests have no Supabase Auth account, no membership and no contact data; a guest token never grants
  WeddingMembership. A party has one or more named Guests (non-empty, database-enforced); party size is
  derived from `guests` rows, with no fixed maximum. No stored party size or counters; explicit invited
  capacity / `max_guests` / plus-one semantics are not modeled yet (a future product decision).
- Guest link tokens: CSPRNG (256 bits), plaintext only in the link returned once by create/rotate, the
  `/rsvp/[token]` path and the httpOnly `lb_guest_rsvp` handoff cookie (path `/rsvp`) — and, since LB-11, the
  invitation email body and the fresh-link send form's POST body, and, since LB-13, the explicit recovery
  response ("Mostrar enlace"). Only the SHA-256 hash (plus, since LB-13, an encrypted envelope; see below) is stored,
  and `token_hash` is never readable through the API, except next to a recoverable envelope in the member-only
  recovery read. Never log a token or put it in a query string.
- Link expiry is derived (`private.guest_invitation_expires_at`, mirrored by `@/lib/guests/link`) from the
  current wedding date; never store it. Revoke = `revoked_at` (a revoked token stays dead); "Generar nuevo
  enlace" = new hash on the same party.
- A token unlocks exactly one Wedding + one GuestInvitation: guests read and write only through
  `get_guest_invitation`/`submit_guest_rsvp` (token hash in, that party only, via `@/lib/rsvp/service`).
  anon has no table privileges; no open RSVP (no name/email lookup); no service role. Unknown, revoked,
  expired and deleted links all look the same.
- The guest page shows only the party label and its guests. No wedding fields (private until explicit
  publishing), members, checklist or other parties.
- One current RSVP per Guest (`rsvps.guest_id` is the primary key): resubmitting updates, never duplicates.
  A party answers every guest at once, each explicitly; unanswered is never "No". Organizers read RSVPs, never write them.
- Owners and collaborators manage guest-list content (parties, guests, reading RSVPs) through
  `@/lib/guests/service`; creating a party also issues its first link. Only owners rotate or revoke a
  GuestInvitation link (service `requireWeddingRole` + the `guest_link_owner_only` trigger), never UI-only.
  Same-wedding composite FKs keep guests/RSVPs in their party's wedding. The checklist stays the home;
  Invitados is secondary.

## Wedding website rules (LB-10)

- Nothing is public unless an owner explicitly publishes the wedding website. A wedding, content, a slug
  or a visible section existing is never enough: public = `wedding_publications.published_at` set AND the
  section `is_visible` (default false). Wedding fields stay private outside that projection.
- The public slug (`/boda/<slug>`) is a locator, never a capability or authorization input. Missing,
  unpublished and malformed slugs look identical (404). Never put a wedding UUID in a public URL.
- anon never reads `weddings`, `content_sections`, `wedding_publications`, memberships or guest tables. The only
  public read is `get_published_wedding_site(slug)` via `@/lib/wedding-site/public`: name, date, city and visible
  sections (kind, title, body). No ids, time zone, timestamps, members, checklist or guest data. Add a field
  there only as an explicit product decision.
- Owners and collaborators edit ContentSections (`@/lib/wedding-site/service`, keyed by wedding + kind, never a
  browser-sent row id). Choosing/changing the slug, publishing and unpublishing are owner-only: service
  `requireWeddingRole` + owner-checked SECURITY DEFINER RPCs; clients have no write grant on `wedding_publications`.
- Section kinds are the fixed Constitution set (`intro, ceremony, reception, schedule, dress_code, faq, rsvp`),
  one row per kind; no CMS, no reordering, no custom kinds.
- User content is plain text only: render through React text with `whitespace-pre-line`; never
  `dangerouslySetInnerHTML`, Markdown/HTML rendering, embeds or user-supplied URLs as media.
- The public RSVP section never means open RSVP: no form, guest search or guest data; RSVP stays token-gated
  (`/rsvp/<token>`). The RSVP page may show the published context (`get_guest_invitation_site_slug`) only while
  the site is published; unpublishing never affects guest links.
- Public site pages are dynamic/no-store and `noindex, nofollow` (public by address, not discoverable).
  Saved edits to a published site are live immediately; there are no drafts or versions.

## Guest invitation email rules (LB-11)

- The contact email belongs to the GuestInvitation (party): `guest_invitations.contact_email`, optional, not unique,
  never on Guests/RSVPs. It is PRIVATE wedding data: members only (`@/lib/guests/service`); never in public/guest
  functions, `/boda`, `/rsvp`, URLs, logs or client storage. Normalize/validate through `@/lib/guests/contact-email`
  (mirrors the DB CHECK). Owners and collaborators set/edit/remove it; that never rotates, revokes, resends or
  touches RSVPs.
- The plaintext token is still never persisted. An email may only carry a link whose plaintext exists right now:
  a fresh create/rotate result (any member; the token returns in the send form's POST body, never a URL, and must
  pass `guest_invitation_link_is_current`) or the owner-only "Generar nuevo enlace y enviar"
  (`@/lib/guests/invitation-email`). Never rotate silently; never let a collaborator rotate through email.
- Order: authorize → validate → config → party/recipient → current link → content → [rotate] → one provider call →
  privileged record. The provider is never called before every check passes; the recorder never before the provider
  accepted. Provider ids come only from the provider response. No automatic retries; no exactly-once claims.
- A failed send never rolls back a rotation: return the new link. Provider success + record failure is
  `sent_but_unrecorded` ("no lo envíes otra vez todavía"), never "not sent".
- Send metadata (`invitation_email_sent_at/_sent_to/_provider_id`) is the latest successful send only, written only
  by `record_guest_invitation_email` (database clock), executable ONLY by `service_role` and called only through
  the server-only recorder after the provider accepted (ADR-004): a user JWT can't prove a provider result, so no
  client role may execute it. The recorder never authorizes; the user's session does, first. Not an activity
  history; no provider payloads, counters or tracking.
- The provider is server-only behind `EmailSender` (`@/lib/email/provider`); Resend lives only in `@/lib/email/resend`.
  Email env is read only in `@/lib/email/config` (`APP_ORIGIN`, `EMAIL_FROM`, `RESEND_API_KEY`, never
  `NEXT_PUBLIC_*`). Absolute email links use `APP_ORIGIN`, never request headers. Services take an
  `EmailDelivery` parameter; tests inject fakes and never reach a real provider (E2E: the localhost-only file outbox).
- Email content: catalog copy only (`es.invitationEmail`), text + HTML, every user value escaped at render, one-line
  subject. Include the website link only while it is published (`getPublishedSitePath`).
- Sending never implies open RSVP. Confirmations: LB-12 below; manual reminders: LB-14 below (no cron, queue or jobs).

## RSVP confirmation email rules (LB-12)

- RSVP persistence is PRIMARY; the confirmation email is SECONDARY. Order (`@/lib/rsvp/confirmation`):
  `submit_guest_rsvp` (anon + token hash, unchanged) commits → only then email config → privileged context →
  site slug (existing guest helper) → render → ONE provider call → privileged record. Never send before the RSVP
  is saved; a failed RSVP never reaches config, provider or recorder.
- No email outcome (no contact email, not configured, provider failure, recorder failure, no provider id) ever
  rolls back, hides or fails a saved RSVP. Keep the two results separate (`rsvp` vs `confirmation`); never one boolean.
  Provider accepted + not recorded is `sent_but_unrecorded`, never "not sent", never retried.
- Every successful submission/update sends one fresh confirmation (no dedup) from the database's post-save state,
  never the form. Recipient = the party's CURRENT `contact_email`, from the database only.
- The confirmation contains NO GuestInvitation capability: no `/rsvp/<token>`, no token, no hash. It also leaves out
  food notes, the contact email, ids and provider data. The website is linked only while published. Plaintext tokens
  are still never stored or rebuilt.
- Confirmation metadata (`rsvp_confirmation_email_sent_at/_sent_to/_provider_id`, latest only, on the party,
  separate from `invitation_email_*`) is written only by `record_rsvp_confirmation_email`. That function and
  `get_rsvp_confirmation_email_context` are service_role-only (ADR-005) and reached only through the recorder module.
  The app never uses the service role to submit, update or authorize an RSVP. (`service_role` itself is globally
  privileged in Supabase; the guarantee is the app boundary: the key is used only in that module, which exposes
  no client or generic query/RPC helper.)
- The guest page shows RSVP success first and at most one secondary sentence about the email (`?email=sent|failed`,
  fixed words); it never reveals the address. Organizers see the last confirmation's date and recipient,
  distinct from the invitation status and from the current contact email.
- Still deferred: automatic/scheduled reminders, cron/queues/jobs, provider webhooks and activity history.

## Recoverable RSVP capability rules (LB-13, ADR-006)

- Never store a plaintext RSVP capability. `guest_invitations.token_hash` stays the ONLY validator of guest links
  (`get_guest_invitation`/`submit_guest_rsvp`); never validate by decrypting.
- The AES-256-GCM envelope (`private.guest_invitation_capability_secrets`, v1, bound to the hash) is recovery-only.
  Crypto lives only in `@/lib/security/rsvp-capability-encryption` (server-only, pure; no DB, React or logging).
- `RSVP_CAPABILITY_ENCRYPTION_KEY` is server-only, read only in that module (ESLint), never logged, returned,
  `NEXT_PUBLIC_*` or generated by the app. Without it, creating parties and rotating links fail BEFORE any write.
- Every new/rotated link writes hash + envelope in ONE transaction (`create_guest_invitation`,
  `rotate_guest_invitation_link`: SECURITY DEFINER, membership/owner checked from `auth.uid()`, the only create and
  rotation doors; a deferred trigger refuses a hash without its envelope). No standalone envelope writer, and no
  client grant to execute one.
- Every absolute RSVP link is `guestRsvpUrl(token, APP_ORIGIN)` (fresh, rotated, emailed, recovered). Never build
  one from request headers (`getRequestOrigin`, Host, Origin, X-Forwarded-*); no `APP_ORIGIN` = refuse.
- No decryption on page loads, public pages or the RSVP page. Recovery happens only on an explicit organizer action
  ("Mostrar enlace") through `@/lib/guests/link-recovery` → `get_guest_invitation_recovery_envelope`. Only the final
  URL (from `APP_ORIGIN`) reaches the browser; never the envelope. Never cache or store recovered links client-side.
- Owners and collaborators recover; only owners rotate. Revoked/expired links are never handed out. Recovery
  failures never rotate, revoke or rewrite anything, and leak no crypto detail.
- Legacy hash-only (pre-LB-13) links keep working and are `legacy` for recovery: never backfill or auto-rotate; an
  owner's explicit "Generar nuevo enlace" makes them recoverable.
- Recovered links are delivered again only by LB-14's explicit manual reminders (below); no schedulers.

## Manual RSVP reminder rules (LB-14, ADR-007)

- A reminder reuses the party's CURRENT recoverable capability: recovered inside the action through
  `recoverCurrentCapability` (`@/lib/guests/link-recovery`), URL from `guestRsvpUrl(token, APP_ORIGIN)`. A reminder
  never generates, rotates, revokes or stores a token, and never uses a token or link sent by the browser.
- Explicit organizer actions only ("Enviar recordatorio", "Preparar mensaje para WhatsApp"), owners and collaborators
  alike, through `@/lib/guests/rsvp-reminder`. Never on page load, recovery, RSVP, edits, publication or rotation.
- Email recipient = the party's CURRENT `guest_invitations.contact_email`, read from the database at action time;
  never a form value. No contact email = no email (the WhatsApp text still works).
- Legacy/undecryptable links: no reminder in either channel; only an owner's explicit "Generar nuevo enlace" repairs
  them. Revoked/expired: nothing is sent. Every failure happens before the provider and leaves the link untouched.
- Email order: authorize → validate → config (email + link key) → party/recipient → recover → content → ONE provider
  call → privileged record. No retries. Provider accepted + not recorded = `sent_but_unrecorded`.
- The reminder email INTENTIONALLY carries `/rsvp/<token>` (`@/lib/email/rsvp-reminder`, `es.rsvpReminderEmail`);
  the LB-12 confirmation stays token-free. Never answers, notes, members, ids, hashes or envelopes in either.
- Reminder metadata (`rsvp_reminder_email_sent_at/_sent_to/_provider_id`, latest only, all-or-none) is separate from
  `invitation_email_*` and `rsvp_confirmation_email_*`, written only by service_role-only `record_rsvp_reminder_email`
  (current usable hash + current contact email) via the recorder's `recordRsvpReminder`.
- WhatsApp is MANUAL COPY ONLY: plain text (`@/lib/guests/rsvp-reminder-message`) returned by the action, shown and
  copied by the organizer. No API (WhatsApp Business/Meta/Twilio/SMS), no phone numbers, no `wa.me` share URL (token
  in a query string), no storage and no delivery metadata; the UI never says "Enviar WhatsApp" or "enviado".
- No scheduler, cron, queue, recurring or automatic reminders, and no activity history yet.

## Commands

- `npm run verify`: lint, typecheck, unit tests, build (same as CI)
- `npm run test:e2e`: Playwright journeys against a production build and local Supabase (needs `npx playwright install chromium` and `npm run db:start`)
- `npm run db:verify`: reset local DB, run RLS/security integration tests, check generated types (needs Docker + `npm run db:start`)
- `npm run db:types`: regenerate `src/lib/supabase/database.types.ts` after any schema change (never hand-edit it)

## Prompt sequencing

Work is delivered in numbered prompts (LB-NN). LB-02 is the application foundation. LB-03 is the product
data foundation: weddings, memberships, membership invites, RLS (no UI). LB-04 adds auth and membership
flows (signup/login/logout, wedding creation, invites). LB-05 adds the checklist domain (templates,
wedding checklist items, RLS) and the checklist-first wedding page. LB-06 refines it: List/Plan/category
views, "Lo próximo", owner-only wedding settings (no schema change). LB-07 adds single-assignee checklist
assignment, "Mis pendientes" and wedding-scoped member display names. LB-08 completes the MVP gaps: optional
wedding city, IANA wedding time zone, derived overdue ("Atrasado") and owner-only member removal. LB-09
starts Phase 2: GuestInvitation (household/party) → Guest → per-guest RSVP, token links without guest
accounts and the couple's "Invitados" page (no emails, website or activity history yet). LB-10 adds the
published wedding website: ContentSection, the "Sitio web" editor, owner-only slug/publish/unpublish and the
public `/boda/[slug]` page (no email or activity history yet). LB-11 adds the party's optional contact email and
the GuestInvitation email through Resend (fresh-link send for any member, owner-only "new link and send", latest-send
status; no confirmation emails, reminders or activity history yet). LB-12 adds the RSVP confirmation email (sent after
every successful RSVP save to the party's contact email, without the RSVP link; latest-confirmation status for
organizers; ADR-005; no reminders, scheduling or activity history yet). LB-13 makes the party's current RSVP link
recoverable (AES-256-GCM envelope next to the hash, server-side key, explicit "Mostrar enlace" for members; ADR-006;
no reminders or delivery yet). LB-14 adds manual RSVP reminders with that same link: an explicit reminder email to the
party's contact email (latest-reminder status; ADR-007) and a WhatsApp-ready text to copy (no API, no phone numbers;
no scheduling or activity history yet). Don't implement ahead of the current prompt.
