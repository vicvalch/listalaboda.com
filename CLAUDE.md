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
- `docs/architecture/ADR-008-basic-activity-history.md` (append-only wedding activity history)
- `docs/architecture/ADR-009-checklist-guest-work.md` (checklist item → guest party link)
- `docs/architecture/ADR-010-automatic-rsvp-reminder-scheduling.md` (automatic RSVP reminders; the second
  service-role module)
- `docs/architecture/ADR-011-email-delivery-observability.md` (email delivery ledger and signed delivery webhooks;
  staged LB-18; the third service-role module)
- `docs/architecture/ADR-012-seating-plan-domain-model.md` (seating tables and one-table-per-guest assignments)
- `docs/architecture/ADR-013-visual-seating-planner-layout-model.md` (visual planner: table shape and board position)
- `docs/architecture/ADR-014-wedding-vendor-engagement-model.md` (wedding-scoped vendor engagements, quote/contract)
- `docs/architecture/ADR-015-wedding-budget-and-payment-model.md` (budget estimates, vendor schedules and payments)
- `docs/architecture/ADR-016-wedding-run-of-show-model.md` (wedding-day run of show, "Cronograma")

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
  service-role client. Since LB-15 each record RPC also appends that send's activity row in the same transaction
  (ADR-008), and since LB-18.1 its `email_deliveries` ledger row (ADR-011); neither is a new privileged operation.
  The SECOND and only other use is the ADR-010 scheduler store (`src/lib/scheduler/rsvp-reminder-store.ts`: five
  named operations — claim, prepare, begin, record, finish — each one fixed service_role-only RPC; LB-17 below).
  The THIRD and last is the ADR-011 delivery event store (`src/lib/email/delivery-event-store.ts`: one operation,
  `ingest`, one fixed service_role-only RPC, called only after the webhook signature verified; LB-18.2 below). Three
  separate authorities, never merged: app-authorized provider result / system scheduler / provider signature. No
  generic privileged client anywhere. Any other use needs its own `server-only` module plus a written justification
  (ADR-002 §6). ESLint blocks `process.env.SUPABASE_SERVICE_ROLE_KEY` everywhere else, `process.env.CRON_SECRET`
  everywhere but `src/lib/scheduler/cron-auth.ts`, and `process.env.RESEND_WEBHOOK_SECRET` everywhere but
  `src/lib/email/webhook-auth.ts`.
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
- Still deferred: provider webhooks. (Activity history: LB-15; automatic reminders: LB-17 below.)

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
  (current usable hash + current contact email) via the recorder's `recordRsvpReminder` — and, since LB-17, by
  `record_automatic_rsvp_reminder_email` (same rules) for automatic reminders: the latest reminder of either channel.
- WhatsApp is MANUAL COPY ONLY: plain text (`@/lib/guests/rsvp-reminder-message`) returned by the action, shown and
  copied by the organizer. No API (WhatsApp Business/Meta/Twilio/SMS), no phone numbers, no `wa.me` share URL (token
  in a query string), no storage and no delivery metadata; the UI never says "Enviar WhatsApp" or "enviado".
- Manual reminders stay as they are; one owner-enabled automatic reminder per party is LB-17 below (no recurring
  reminders, generic queues or messaging APIs).

## Wedding activity history rules (LB-15, ADR-008)

- `public.wedding_activity` is Wedding-scoped, append-only history of GuestInvitation/RSVP facts. It is not logging,
  analytics, an event bus or an outbox; nothing reads it to make decisions.
- The event type (`wedding_activity_event`) and actor kind (`member | guest_capability | system`) are closed enums.
  Adding an event is a migration plus an exhaustive label in `@/lib/activity/presentation` (`es.activity`); copy is
  never stored. No JSON/free-text payload, no snapshots.
- Write the row INSIDE the database function that performs the fact, in the same transaction (create, rotate,
  `revoke_guest_invitation_link`, the contact-email trigger, `submit_guest_rsvp`, the three recorder RPCs, and
  since LB-17 `record_automatic_rsvp_reminder_email` with actor `system`). Never from
  the app, React or a separate call; there is no `appendActivity`/generic writer and no client-executable function
  takes an event type.
- No client role may INSERT/UPDATE/DELETE it (members SELECT via RLS); a guard trigger refuses edits and deletes for
  every role except the FKs' own actions. `occurred_at` is always the database clock.
- Revoking a link goes only through `revoke_guest_invitation_link` (owner-only, records once; already revoked = no-op).
  The client `UPDATE (revoked_at)` grant is gone.
- Actors: `member` = `auth.uid()` in member RPCs. For member-initiated emails (invitation, reminder) the application
  derives the initiating member from the authenticated `WeddingAccess` context (`userId`, never browser/form input);
  `delivery-recorder.ts` passes it through its named operation, and the service-role recorder verifies that the
  attributed user is a member of the target Wedding before recording. It does not prove who clicked; authorization
  happens in the authenticated app flow. The user id is attribution only, never authorization. Guest RSVPs and
  confirmations are `guest_capability` (no user id; the token is never an identity). These two service_role-only
  recorders are the ONLY functions that take a user id; no client-executable function may supply an actor user id.
- Email events exist only when provider accepted AND the record committed: `sent_but_unrecorded` and failures write
  nothing. `submitted` vs `updated` comes from stored rsvps under the party lock, never the payload.
- Never store or return tokens, hashes, envelopes, RSVP URLs, answers, notes, email addresses or provider ids.
  The read path (`get_wedding_activity`, `@/lib/activity/service`) is SECURITY INVOKER, newest first, max 50, and
  returns the party's CURRENT label and the actor's membership id only.
- Deletion: wedding → history cascades; party → rows stay with `guest_invitation_id` null ("Grupo eliminado");
  account → `actor_user_id` null. No fabricated backfill: history begins at LB-15.
- Activity can answer "was a reminder recorded for this party?" but it is not a scheduler, dedupe key or lock
  (LB-17's scheduler has its own occurrence table for that).

## Checklist ↔ guest work rules (LB-16, ADR-009)

- An item may be about zero or one guest party: `checklist_items.guest_invitation_id`, a GuestInvitation of the SAME
  wedding (composite FK `(guest_invitation_id, wedding_id)`, `ON DELETE SET NULL (guest_invitation_id)`). Null = no
  guest work. Never a stored href/url/route, JSON payload, polymorphic `(entity_type, entity_id)` or link table.
- Same-wedding is database-enforced for every role; never rely on app checks alone. A forged or unknown party id is
  `invalid_guest_party`, indistinguishably.
- Existing authorization wins: linking is a checklist edit (owners and collaborators, `setChecklistItemGuestParty`
  in `@/lib/checklist/service`, column grant + member RLS). The link grants nothing on the party; guest-link rules
  (owner-only rotate/revoke) are unchanged. Items are created unlinked (no INSERT grant on the column).
- No RSVP capability material and no copied guest PII: never store or project tokens, hashes, envelopes, RSVP URLs,
  party label snapshots, guest names, contact emails, answers or notes through the relation. Render the party's
  CURRENT label (`listGuestPartyOptions`: id + label) and the item's id/title/status on the guest side.
- Linking/unlinking writes only that column: it never changes status, timing, order or assignee, and never touches
  the party, guests, RSVPs, link, email metadata or activity history. Guest events never complete or create items.
- Deleting the party unlinks (the item survives with its status); deleting the item leaves the party untouched.
  A link whose party is gone renders as unlinked, never as a broken link.
- Routes come from `@/lib/checklist/guest-work` (ids + app paths + `#item-`/`#party-` anchors); no query strings.
  Reads stay batched: party options in one query, related items nested in `listGuestParties`' single select.
- No activity events for link/unlink. Guest events never complete or create checklist items (LB-17 doesn't either).

## Automatic RSVP reminder rules (LB-17, ADR-010)

- ONE automatic reminder email per unanswered party, `days_before` ∈ {14, 21, 30} (default 21) days before the wedding
  at 10:00 in `weddings.time_zone`, sendable for 48 h. Due times are computed just in time from the CURRENT policy, date
  and zone (`private.automatic_rsvp_reminder_due_at`; UI mirror `@/lib/scheduler/timing`); never a stored calendar.
  No date or no zone → nothing is due. Never server, browser or UTC time.
- Authority = an owner's opt-in + the trusted deployment scheduler, never a member session or a fabricated member.
  `public.wedding_rsvp_reminder_policies`: no row = OFF; written only by the owner-only `set_rsvp_reminder_policy`
  (service `@/lib/scheduler/policy` + database role check); enabling needs date + zone; off → on stamps `enabled_at`;
  no never-claimed party is sent a reminder due before `enabled_at`. Collaborators read the status only.
- `public.automatic_rsvp_reminders`: one row per party (`UNIQUE guest_invitation_id`, same-wedding composite FK), closed
  `state` and `outcome_reason` enums tied together by CHECKs. A row existing ≠ the opportunity consumed: it is consumed
  once `attempt_count ≥ 1`. It never stores tokens, hashes, envelopes, recipients, provider ids, bodies or answers.
  Clients only SELECT display columns (never `claim_token`); every write is a service_role-only function.
- Protocol (`@/lib/scheduler/rsvp-reminder-runner`): claim (sweep → due-time skips → SKIP LOCKED claims under caps
  50/run, 25/wedding, fresh `claim_token`, 10-min lease) → prepare (current truth; returns the CURRENT capability and
  render context; no attempt) → decrypt/verify/render in the app (no lock open) → begin (locks the party, re-checks,
  claimed → sending, `attempt_count + 1`: THE provider boundary) → ONE provider call with the stable key
  `lb-auto-rsvp-reminder:<occurrence id>` → record (metadata + `system` activity + sent, atomically) or finish.
  No database lock is ever held across the provider call.
- `sending` = an email MAY have gone out. Replays only with the same key, ≤ 3 attempts, before
  `first_attempt_at + 23 h` (Resend keeps keys 24 h). Same payload → the provider suppresses the duplicate; a changed
  payload → `unknown (idempotency_conflict)`. Never snapshot a body, recipient or capability to force a match.
  `sent_unrecorded` and `unknown` ("cannot prove no email was sent") are terminal: never resent automatically.
- Only `skipped` rows (attempt 0) are reactivated, and only for `no_contact_email`, `link_unrecoverable`,
  `link_unavailable`, `policy_disabled`, `out_of_window` (and, since LB-18.4, `recipient_undeliverable`), when every
  current check passes. `answered` and `recently_reminded` (a reminder or invitation email recorded within 7 days; to
  the current address since LB-18.4) are final. Manual reminders are never
  blocked by automation.
- `rsvp_reminder_email_*` = the latest reminder email of either channel. Activity: the existing
  `rsvp_reminder_email_sent` with actor `system`, labelled "Automático"; no rows for claims, skips or failures.
- Route `GET /api/cron/rsvp-reminders` (GET only, `force-dynamic`, `no-store`, `maxDuration = 60`, excluded from the
  session proxy): `Authorization: Bearer <CRON_SECRET>` checked first, timing-safe, in `@/lib/scheduler/cron-auth`
  (≥ 32 bytes; query strings ignored); missing configuration → nothing runs. Counts only in responses; nothing logged.
  Runner budget 45 s, ≤ 2 sends/s; the runner passes `timeoutMs: 10_000` (and its key) to the provider. Timeouts and
  idempotency keys are opt-in per `EmailSender.send` call: manual email flows pass neither.
- Infrastructure only (LB-17A.2): `vercel.json` runs the route once daily (`0 15 * * *`, 15:00 UTC; Vercel Hobby
  allows only daily crons; the 48 h window is unchanged, but retries can't fit the 23 h replay limit and end `unknown`,
  ADR-010 §3) and `CRON_SECRET` is provisioned in Production, but sending stays disabled: every policy is OFF and
  production email is blocked until `listalaboda.com` is owned and verified. Enabling a policy in production is a
  separate, explicitly approved step. A migration or a deploy alone can never send (zero policy rows, default OFF).

## Email delivery ledger rules (LB-18.1, ADR-011)

- LB-18.1 is the persistence foundation ONLY: no webhook route, `RESEND_WEBHOOK_SECRET`, Svix verification,
  `email_delivery_events`, delivery status, UI, suppression, `recipient_undeliverable` or `recently_reminded` change yet.
- `public.email_deliveries` = one immutable identity row per provider-accepted email that was successfully recorded:
  `wedding_id`, `guest_invitation_id` (same-wedding composite FK, `ON DELETE CASCADE`), `kind`, `provider_message_id`
  (`UNIQUE`; the id `EmailSender.send` returned), `recipient` (the accepted address, `*_sent_to` CHECK), `accepted_at`
  (database clock = the matching `*_sent_at`).
- `email_delivery_kind` is closed and fixed by the record function: `guest_invitation`, `rsvp_confirmation`,
  `rsvp_reminder_manual` (`record_rsvp_reminder_email`), `rsvp_reminder_automatic`
  (`record_automatic_rsvp_reminder_email`). Never infer a kind.
- Written ONLY inside the four record functions, in their transaction, via `private.record_email_delivery` (no client
  grant). Never a second application write. A failed record (incl. a reused provider id → `email_delivery_not_recorded`)
  leaves no row; `sent_but_unrecorded`/`sent_unrecorded` never have one.
- Identity is immutable for every role (guard trigger); rows are deleted only by the party/wedding cascade. Future
  delivery status columns (LB-18.2) will be the only updatable ones.
- Members SELECT `id, wedding_id, guest_invitation_id, kind, recipient, accepted_at` (member RLS); no client reads
  `provider_message_id`; anon nothing; no client writes. The latest-send `*_sent_at/_sent_to/_provider_id` columns are
  unchanged business metadata. No backfill: pre-LB-18.1 sends have no row (delivery status unavailable).
- Correlation is local only: provider email id → `email_deliveries` → party → Wedding; never trust provider-supplied
  tenant data. Open tracking deferred; click tracking prohibited (it would rewrite `/rsvp/<token>` URLs).
- Approved for later slices (ADR-011 §8–§10): delivery status never rewrites LB-17 execution state; bounced/suppressed/
  complained blocks email to the SAME current address (editing it re-enables; link sharing always allowed; no override);
  LB-18.4 adds `recipient_undeliverable` and scopes `recently_reminded` to the current address.

## Signed delivery webhook rules (LB-18.2, ADR-011 §7)

- Passive ingestion only (LB-18.3 below adds the member status read, UI and manual guard): no
  `recipient_undeliverable` or `recently_reminded` change. No production webhook or `RESEND_WEBHOOK_SECRET` is configured (LB-18.5, separately approved).
- `email_deliveries.status` (`accepted` 0 < `delayed` 10 < `failed` 20 < `delivered` 30 < `suppressed` 40 < `bounced` 50 <
  `complained` 60; the enum is declared in that order) only moves to a strictly higher rank; same/lower-rank events are
  history only; the provider timestamp never decides. `status_event_at` = occurred_at of the event that last advanced it;
  `accepted` ⇔ null (CHECK). The guard (every role) keeps identity immutable and refuses regressions. Webhooks never touch
  `automatic_rsvp_reminders`, `*_sent_*` metadata or activity.
- `email_delivery_events`: append-only, one row per `provider_event_id` (`svix-id`, UNIQUE = the dedupe and concurrency
  authority), same-wedding composite FK to the delivery, cascades with it. Closed `event_type`; `bounce_type` iff bounced.
  Never a recipient, subject, sender, payload, reason text, link, IP, user agent or tags. No privileges for anon,
  authenticated or service_role; written only by `ingest_email_delivery_event` (SECURITY DEFINER, service_role-only),
  which takes normalized fields only (never a Wedding/party/delivery id, recipient or payload) and returns a closed
  outcome (`applied | no_change | duplicate | unknown_message`), never ids.
- Correlation: `data.email_id` → `email_deliveries.provider_message_id` → party → Wedding, locally. Never `data.message_id`,
  tags or any provider-supplied tenant data. Unknown ids → `unknown_message`: 200, nothing written.
- Route `POST /api/webhooks/resend` (POST only, dynamic, no-store, empty bodies, nothing logged, excluded from the session
  proxy; the signature is the only authority): secret missing/malformed → 503; raw body > 64 KiB → 413; missing headers,
  bad signature or timestamp outside ± 5 min → 401 (verify with `standardwebhooks` over the RAW body, before any JSON
  parsing; never a Resend client or `RESEND_API_KEY`); unsupported (incl. opened/clicked, never read) or malformed signed
  bodies → 200 ignored; ingest outcomes → 200; database failure → 500.

## Delivery status UI and manual send guardrails (LB-18.3, ADR-011 §14)

- Members (owners and collaborators) read `email_deliveries.status` (column grant + member RLS). Still never
  `provider_message_id`, `status_event_at` or `email_delivery_events`; anon nothing; no client writes.
- Read model: `listGuestParties`' single nested select embeds `email_deliveries(kind, recipient, accepted_at, status)`;
  the page derives everything in memory (`@/lib/guests/delivery-status`). Never a per-party query or event history.
- Each "last sent" line shows the status of its own send (latest of its kinds, same clock as `*_sent_at`), else
  "Estado de entrega no disponible"; next to, never instead of, the "enviada el … a …" text. The reminder line is the
  latest of both reminder kinds and labels an automatic one. `accepted` = "Enviado", never "Entregado".
- Bad address = a SAME-wedding delivery to the current `contact_email` with status suppressed/bounced/complained
  (`private.email_recipient_block`, no client grant; delayed/failed/delivered/accepted never block), compared in the
  comparison form only: trim + lowercase of the whole address (`private.email_comparison_form` /
  `normalizeEmailForComparison`; never stored, no dot/+tag/alias rules). A case-only edit stays blocked; a genuinely
  different address is never blocked by an old one. Never cross-wedding, never the provider's account-wide list. No override.
- The UI disables email-send buttons for a blocked current address (rotate-and-send, fresh-link send, reminder email);
  link display/copy, WhatsApp, "Generar nuevo enlace" and editing stay enabled. The server guard remains the authority.
- Manual guard: `@/lib/guests/email-block` → `get_guest_invitation_email_block` (member session, membership-checked,
  null = not visible/not current → fail closed), right after loading the party, before link checks, rotation and the
  provider, in the invitation (fresh and rotate-and-send) and manual reminder flows. Blocked = `recipient_undeliverable`
  / `recipient_complained` and zero side effects. "Mostrar enlace" and the WhatsApp text are never blocked.
- RSVP confirmation: `get_rsvp_confirmation_email_context` also returns `contact_email_block`; blocked →
  `skipped_undeliverable` (no send, no note to the guest). The RSVP save never depends on it.
- Not here: activity rows for delivery outcomes, production webhook (LB-18.5). Automatic reminders: LB-18.4 below.

## Automatic reminder suppression (LB-18.4, ADR-010 §27, ADR-011 §10)

- One shared check, `private.automatic_rsvp_reminder_ineligibility` (claim, prepare, begin): never add a separate
  scheduler-side or app-side eligibility path.
- E11 `recipient_undeliverable`: current `contact_email` blocked in the SAME wedding by `private.email_recipient_block`
  (LB-18.3's rule, so the warning, the manual guard and the scheduler agree). Pre-provider: `skipped`, attempt 0, no
  begin/provider/metadata/activity/ledger. Remediable by a genuinely different, clean address (comparison form; a
  case-only edit is the same address).
- E9 `recently_reminded` counts only invitation/reminder sends (latest-send metadata + the party's ledger rows of those
  kinds) TO the current address, comparison form. Never broaden its channels; it stays final once recorded.
- Precedence: answered → policy_disabled → out_of_window → link_unavailable → link_unrecoverable → no_contact_email →
  recipient_undeliverable → recently_reminded. Delivery status never rewrites an occurrence (`sent` stays `sent`).

## Seating plan rules (LB-19, ADR-012)

- The seating unit is `public.guests` (one person, stable id). No attendee/person copy, no seating column on `guests`,
  no backfill, no plus-ones/`max_guests`/placeholder seats, no child/adult fields. Assignment is per person, never per party.
- `seating_tables` (name 1–80 trimmed plain text, not unique; capacity 1–50; `sort_order` appended by trigger, read
  `sort_order, created_at, id`) and `seating_assignments` (`guest_id` PK = at most one table per guest; no row =
  unassigned). Both references are same-wedding composite FKs, `ON DELETE CASCADE`: deleting a table, guest, party or
  wedding removes assignments, never guests or tables on the other side.
- Capacity is enforced in the database: `private.enforce_seating_assignment` locks the destination table row
  (`FOR UPDATE`) and counts EVERY assignment row (attending, pending, declined-but-seated); `seating_table_full`.
  `private.enforce_seating_table_capacity` refuses a capacity below the seated count (`seating_capacity_below_assigned`).
  Never weaken this to app-only checks; the UI's free seats = capacity − assignment count, never confirmed answers.
- Declined (`rsvps.attending = false`) guests can't be newly seated or moved (`seating_guest_declined`); pending and
  attending can. A guest who declines AFTER being seated keeps the assignment: never modify `submit_guest_rsvp` or make
  the RSVP depend on seating; never auto-unseat. The page flags it ("No asistirá" + summary warning); organizers unseat.
- Owners and collaborators have identical seating rights, member RLS only (`private.is_wedding_member`); anon nothing.
  Client-writable columns: tables INSERT `wedding_id, name, capacity` / UPDATE `name, capacity`; assignments INSERT
  `guest_id, wedding_id, seating_table_id` / UPDATE `seating_table_id`. Trigger functions are SECURITY INVOKER, pinned
  `search_path`, not client-executable. No service role, no RPC, no public/RSVP/published-site exposure.
- Writes go through `@/lib/seating/service` (membership first, wedding-scoped, closed reasons; raw SQL never reaches the
  UI). The page reads in two batched queries (`getSeatingData`) and derives everything in `@/lib/seating/plan`.
- No activity events for seating (ADR-008 unchanged); no checklist link (`reception.layout` stays unlinked). No
  auto-seating. The visual planner is LB-20 below.

## Visual seating planner rules (LB-20, ADR-013)

- Progressive enhancement over LB-19, which stays authoritative. Guest drops call ONLY the LB-19 actions (rail → table
  `seatGuestAction`, table → table `moveGuestAction`, table → rail `unseatGuestAction`); never a second assignment
  path, RPC or browser Supabase write. The database decides capacity races (`table_full` → revert + "Mesa llena").
- Layout lives on `seating_tables`: `shape` (`seating_table_shape` enum: `round | rectangle`, default round, visual
  only: never capacity/assignments/order/position), `layout_x/layout_y` (the table CENTER, integers, both or neither,
  0–10000). Null = not placed yet: derive a slot (`deriveTablePositions`), never write on open. No layout table,
  floor-plan entity, persisted seats/chairs, rotation, width/height, zoom or pan. No layout triggers.
- Grants: `INSERT (shape)`, `UPDATE (shape, layout_x, layout_y)` on top of LB-19's; never `wedding_id`, `sort_order`,
  `created_by`, ids or timestamps; no coordinates on insert. anon nothing; never public/RSVP/site.
- Geometry is pure in `@/lib/seating/planner`: logical board 1200 units wide (grows vertically, min 800, never
  stored); `scale = renderedWidth / 1200`; screen delta ÷ scale → snap to 20 → clamp. Sizes derive from shape +
  capacity; chair markers are decorative positions, never guests. Overlap is allowed.
- Positions: `positionSeatingTable` (`@/lib/seating/service`) via `positionTableAction`, ONE write per completed table
  drag (on drop, never on pointer move), optimistic, reverted to the server position on failure; last-write-wins (no
  versions, realtime or conflict UI).
- `?view=plan` on the same route; list is the default. Desktop only (`lg`+): below it the list is the full fallback,
  no "Plano" toggle, and `?view=plan` shows a notice + "Volver a lista" without rendering planner DOM. Page-local
  breakout to ~`max-w-7xl` via fixed negative margins (never `100vw`); the `/app` shell width is unchanged.
- `@dnd-kit/core` pinned exactly (6.3.1); no `@dnd-kit/react`/sortable/other drag libraries. Explicit drag data kinds
  (`table`/`guest`); tables move only by their labelled handle. The inspector (LB-19 forms) is the non-drag path for
  everything; one live region for announcements; no `aria-disabled` on a table group (it would disable its controls).

## Vendor rules (LB-21, ADR-014)

- `public.wedding_vendors` (WeddingVendor) is a Wedding-scoped ENGAGEMENT: identity/contact fields are copied into it.
  No global vendor table, planner/organization directory or copy-between-weddings; a future directory is additive.
- PRIVATE organizer data: owners and collaborators have identical CRUD rights (member RLS, column grants; never
  `id`, `wedding_id`, `created_by` or timestamps). anon nothing; no SECURITY DEFINER/RPC, service role, public/RSVP/
  guest/site projection. Writes go through `@/lib/vendors/service` (membership first, scoped by `(id, wedding_id)`,
  re-validated, closed reasons). Foreign/malformed/deleted ids look identical (404 / `invalid_target`).
- Category is the closed enum; `custom_category` exists iff `other`. Status (`considering|quoted|selected|booked|
  discarded`) has no state machine and no payment vocabulary; "Descartado" is a status, never a delete (hard delete).
- Money: `quoted_amount_minor` / `contracted_amount_minor` are integer minor units (bigint, 0–99 999 999 999 999),
  never float/numeric; `currency` is CRC or USD only, present iff an amount is. Parse with `@/lib/vendors/money`
  (never `parseFloat`), format with `formatMoney`. Never add currencies together or convert; the "Contratado" total
  is booked vendors' contracted amounts per currency; quotes are never summed. Payments/deposits/due dates are LB-22.
- Vendor email is informational: never imported into `@/lib/email`, sent to or tracked. Links are generated only
  (`mailto:`, `tel:`, Instagram URL from a validated handle); never store a URL. Notes are plain text.
- Read model: the list is ONE query without notes; summary/groups/search/filters derive in `@/lib/vendors/summary`.
  Free-text search is local and never in a URL; `?category=&status=` may be. Detail is ONE query with notes.
- `UNIQUE (id, wedding_id)` is the composite-FK target: LB-22 payments `ON DELETE NO ACTION` (ADR-015 §7), LB-23 timeline
  `ON DELETE SET NULL`. No checklist link, activity events, documents/storage, vendor login or realtime yet.

## Budget & Payment Rules (LB-22, ADR-015)

- Estimate = `wedding_budget_totals` (one per wedding + currency) and `wedding_budget_allocations` (one per wedding +
  vendor category + currency; `other` is one bucket). Committed = booked vendors' `contracted_amount_minor` (LB-21, the
  ONLY authority for what was agreed; never a second committed column). Obligation = `vendor_payment_schedule_items`.
  Payment = `vendor_payments`. Allocations never have to sum to the total; a missing one is never zero. No accounting
  (ledger, invoice, receipt, tax, payment method, reversal rows), no generic expenses (deferred), no FX.
- A payment applies to at most ONE same-vendor item (composite FK; null = "Sin cuota"); items may have many payments.
  Payments are editable and hard-deletable.
- Database invariants under the parent vendor row lock (`FOR UPDATE` in invoker-rights triggers; never app checks):
  contract required; Σ items + Σ unlinked payments ≤ contract; Σ linked ≤ item; item ≥ its paid. With any child the
  vendor's currency is locked, the contract can't be null or below Σ items + Σ unlinked. Quote/status never coupled.
- Child rows store NO currency (the vendor's) and NO status: pending/partial/paid/overdue/due soon are derived
  (`@/lib/budget/summary`, pure, BigInt, `today` passed in). Overdue = `due_on` < wedding-local today (due today isn't);
  due soon = today … today + 14; no time zone → no timing labels. Discarded vendors leave global overdue/upcoming.
- Formulas per currency, never combined: paid = all payments; remaining = Σ booked (contract − its payments), never
  committed − global paid; unscheduled = Σ booked (contract − items − unlinked). Payments to non-booked vendors show
  under "Atención"; never change status automatically.
- Vendor → children and payment → item FKs are NO ACTION (never CASCADE): `has_financial_records`,
  `schedule_item_has_payments`. Children reference `weddings` ON DELETE CASCADE so wedding deletion still works.
- Member RLS only (owners = collaborators), no RPC, SECURITY DEFINER or service role; never public/RSVP/email/activity/
  checklist. Writes via `@/lib/budget/service` and `@/lib/vendors/payments`; named trigger reasons map to closed
  results. Reads: budget page = 2 queries (wedding with estimates embedded, vendors with items/payments embedded).

## Timeline / Run of Show Rules (LB-23, ADR-016)

- `public.wedding_timeline_entries` ("Cronograma") is the wedding day's run of show: a mutable private PLAN, not a
  calendar, checklist, payment schedule or history. Explicit organizer input only; nothing creates entries.
- Wedding-relative wall clock: `day_offset` is exactly 0 (wedding day) or 1 (after midnight); `start_time` is local
  whole minutes (null = "Sin hora"); `duration_minutes` 1–1440 optional. Never a timestamp or calendar date; the day is
  derived from the CURRENT `wedding_date`, so a date change rewrites nothing. Midnight is chosen, never inferred.
- Window CHECK `wedding_timeline_entries_end_within_window`: `day_offset*1440 + start + duration ≤ 2880` when both are
  set; refused, never clipped. No stored end, status, `sort_order`, priority or participants. Order:
  `day_offset, start_time NULLS LAST, created_at, id` (pure sorter in `@/lib/timeline/summary` is the authority).
- Display wall-clock text only (no JS `Date` for times). `weddings.time_zone` only interprets "now": "Ahora /
  Siguiente" is derived per request (`weddingLocalNow`), only on the wedding day or the day after with a date and a zone;
  current = timed WITH duration containing now (several allowed), next = all sharing the earliest future start. Never
  "late", never stored, no auto-refresh, realtime or delay propagation.
- Zero or one vendor: composite FK `(wedding_vendor_id, wedding_id)` `ON DELETE SET NULL (wedding_vendor_id)`; foreign
  vendor = `invalid_vendor`. The timeline reads only `id, name, category, custom_category, status, contact_name, phone`
  (never email, Instagram, notes or money); `tel:` only. Free-text `location`/`responsible_name`; closed nullable
  `phase` badge.
- Member RLS (owners = collaborators), column grants, `@/lib/timeline/service`, two read queries. No RPC, SECURITY
  DEFINER, service role, activity events, public itinerary, RSVP/site exposure or vendor access. Basic print CSS only.

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
no scheduling or activity history yet). LB-15 adds the basic wedding activity history: an append-only, member-only
"Actividad" page of GuestInvitation/RSVP facts, each written in the same transaction as the fact (owner-only revoke RPC,
member-attributed recorder events; ADR-008; no backfill, no scheduler yet). LB-16 links checklist items to guest work:
zero or one same-wedding party per item (composite FK, `ON DELETE SET NULL`), "Relacionado con / Ver grupo" on the
checklist and "Pendientes relacionados" on the party card (ADR-009; no status automation, no scheduler yet). LB-17 adds
automatic RSVP reminders: an owner-enabled policy, one automatic reminder per unanswered party through a claim/lease
state machine with a stable provider idempotency key, a second narrow service-role module and a `CRON_SECRET`-protected
route (ADR-010; production cron NOT activated: a separately approved step). LB-18 closes the email delivery lifecycle in
slices (ADR-011); LB-18.1 adds only the `email_deliveries` ledger, one immutable row per recorded send written inside the
four record functions (no webhooks, statuses, UI or suppression yet). LB-18.2 adds passive signed Resend webhook
ingestion: delivery status with a rank rule, the append-only `email_delivery_events`, one service_role-only ingest RPC
through a third narrow service-role module and `POST /api/webhooks/resend` (no UI, suppression or production webhook).
LB-18.3 shows delivery status to members on the party card and blocks manual emails (and skips RSVP confirmations) to a
current address that bounced, was suppressed or complained in the same wedding; editing the address re-enables it
(no production webhook). LB-18.4 applies the same rule to automatic reminders (`recipient_undeliverable`, a remediable
pre-provider skip) and scopes `recently_reminded` to sends to the current address (no production webhook). LB-19 adds the
seating plan foundation: `seating_tables` and one-table-per-guest `seating_assignments` (same-wedding composite FKs,
database capacity under a table row lock, declined guests not seatable, decline-after-seating preserved and flagged) and
the "Mesas" page with plain forms (ADR-012; no floor plan, drag and drop or activity events). LB-20 adds the desktop
visual planner (`?view=plan`): table shape and board position on `seating_tables`, guest drops through the LB-19
actions, one position write per table drag, decorative chairs (ADR-013; no persisted seats, rooms, zoom or realtime).
LB-21 adds vendor management: wedding-scoped `wedding_vendors` engagements (category, status, one contact, quote and
contracted amount in CRC/USD minor units), the "Proveedores" list and detail pages (ADR-014; no payments, directory,
checklist link, activity or documents).
LB-22 adds the wedding budget and vendor payments: per-currency estimates (total and per category), vendor schedule
items and payments with database caps under the vendor row lock, a locked vendor currency and contract floor, derived
statuses and the "Presupuesto" page plus the vendor's "Pagos" section (ADR-015; no expenses, accounting, FX, reminders,
activity or documents).
LB-23 adds the wedding-day run of show, "Cronograma": wedding-relative wall-clock entries (the wedding day and its
continuation after midnight, a window CHECK), optional duration, phase badge, free-text location and responsible, zero
or one same-wedding vendor (`ON DELETE SET NULL (wedding_vendor_id)`), derived "Ahora / Siguiente" and basic print
styles (ADR-016; no status, public itinerary, multi-vendor, templates, realtime or activity).
Don't implement ahead of the current prompt.
