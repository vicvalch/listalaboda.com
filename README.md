# listalaboda.com

listalaboda.com es una plataforma que facilita la gestión de muchos items en tu lista de to-dos de la boda.

> Convierte los cientos de pendientes de tu boda en una lista clara, compartida y a tiempo.

## Status

**Checklist foundation (LB-05).** On top of the application foundation (LB-02), the wedding tenancy
schema with RLS (LB-03) and auth/membership flows (LB-04: sign up, create a wedding, invite a partner
or collaborator), each wedding now opens on its checklist. An owner creates the list once from the
default Spanish template (`default-wedding-es`, version 1); owners and collaborators then add, edit,
complete, mark as not applicable and delete items.

Applying the template **copies** its items into the wedding. The wedding's copy is independent: later
template changes never mutate existing weddings (template content changes ship as a new version).
The template is seeded by a migration, so `npm run db:reset` is all a fresh database needs.

**Planning views and wedding settings (LB-06).** The checklist has three views, kept in the URL
(`?view=list|plan|category`, combinable with `?status=`): **Lista** shows the wedding's own stored
order; **Plan** orders pending items by date (earliest effective date first, then items waiting for
the wedding date, then undated items; ties by list order); **Por categoría** groups items with each
category's progress. "Lo próximo" shows the first five pending items in plan order. Views are derived
on read and never rewrite the stored order. Effective dates are derived, not persisted: a relative
item's date is always the *current* wedding date plus its offset, so changing or clearing the wedding
date in **Ajustes de la boda** (`/app/weddings/[id]/settings`, owner-only) moves every relative item
at once, while items with a specific date stay put.

**Assignment and "Mis pendientes" (LB-07).** Each checklist item can have one responsible person:
a current member (`wedding_memberships` row) of the same wedding, or nobody ("Sin asignar"). Owners
and collaborators can assign, reassign and unassign any item. Assignment is planning metadata, not
authorization: every member can still see and edit every item, and assigning never changes status,
dates or order. The database refuses an assignee from another wedding (composite foreign key on
`(assignee_membership_id, wedding_id)`), and removing a member unassigns their items without deleting
them. Pending invites can't be assigned. **Mis pendientes** (`?view=mine`, combinable with `?status=`)
lists the items assigned to you in plan order. Each member can set how they appear in a wedding
(`display_name`, scoped to that wedding, only by themselves). Without a name, others see a neutral
role label; you always see yourself as "Tú". Emails and user ids are never shown.

**City, time zone, "Atrasado" and member removal (LB-08).** A wedding has an optional **city**
(plain text, up to 120 characters) and an optional **time zone**, an IANA identifier such as
`America/Costa_Rica` (never an offset, never inferred from the browser, server or IP; the database
checks it against Postgres's time-zone catalog). Both can be set when creating the wedding and in its
settings (owner-only); existing weddings have neither. The time zone defines the wedding's local
calendar day, from which **overdue** is derived on read: a *pending* item whose effective due date is
strictly before the wedding-local today. Due today is not overdue, done/not applicable never are, and
without a time zone nothing is. Overdue is never stored and is not a status (still `pending | done |
not_applicable`). It shows as "Pendiente · Atrasado" on rows, in an "Atrasados" summary and first in the
Plan view; "Lo próximo" lists only non-overdue pending items. Owners can **remove another member**
("Quitar de la boda", with confirmation): that deletes only their membership in this wedding, never
their account or other weddings; items assigned to them stay and become "Sin asignar". Nobody removes
themselves through this flow, and the last owner can never be removed (database-enforced).

**Guest list and RSVP foundation (LB-09, Phase 2).** Each wedding has an **Invitados** page
(`/app/weddings/[id]/guests`), secondary to the checklist, that any member (owner or collaborator)
manages. Guests are organized in **parties** (GuestInvitations: "Familia Pérez", "Ana y Carlos",
"María") holding one or more named **guests**; party size is simply the number of guests (an explicit
invited capacity, `max_guests` or plus-ones are not modeled yet). Guests have no account, membership,
email or phone. Each guest
has at most one current **RSVP** (attending yes/no plus an optional food note); no RSVP row means "Sin
responder". Counts (total, attending, not attending, pending) are derived, never stored.

Each party gets a **guest link** (`/rsvp/<token>`). The token is 256 bits from a CSPRNG; only its
SHA-256 hash is stored, so the link is shown once when the party is created (by any member) or when
"Generar nuevo enlace" replaces it (the old link stops working at once; guests and answers stay).
"Revocar acceso" disables the link without deleting anything. Owners and collaborators manage the
guest-list content; only owners replace or revoke links, since that changes who holds a working
bearer link (enforced by the server and the database). A link expires 30 days after the *current* wedding date
(365 days after it was generated if the wedding has no date). Opening the link moves the token into a
short-lived httpOnly cookie and redirects to `/rsvp`, where the party answers for every guest at once,
and can come back later to change it. Guests see only their party's label and guests (plus the wedding's public
details once its website is published, LB-10): no members, checklist or other parties. Guest reads and writes go through two narrow database
functions keyed by the token hash. Anonymous clients have no table access, and RSVP is never open (no
name search). A GuestInvitation is not a MembershipInvite and never creates an account or membership.

**Published wedding website (LB-10, Phase 2).** Each wedding has a **Sitio web** page
(`/app/weddings/[id]/site`), secondary to the checklist, where any member (owner or collaborator) writes the
website's sections (ContentSections). The sections are fixed, one of each: introduction, ceremony,
reception, schedule ("Programa"), dress code, FAQ and RSVP. Each has an optional title (blank uses a neutral
default such as "Bienvenidos"), a plain-text body (line breaks kept; no HTML, Markdown, images or embeds) and a
"Mostrar en el sitio" switch, off by default. A visible section needs text, except RSVP, which then shows fixed
guidance to use the personal invitation link.

**Nothing is public until an owner publishes it.** Only owners choose the site's address (`/boda/<slug>`:
lowercase letters, digits and hyphens, 3–80 characters, globally unique, a few app words reserved; a suggestion
from the wedding name is prefilled but never saved on its own), publish and unpublish. The service and the
database enforce that (clients have no write privilege on `wedding_publications`; the owner-checked functions do
the writes). Publishing needs an address and at least one visible section. A published site shows the wedding's
name, date and city and its visible sections, through one narrow database function keyed by slug; anonymous
clients still have no table access, and an unknown, unpublished or malformed address is the same 404. Saved
edits appear on a published site immediately (there are no drafts). Unpublishing takes the site offline at once
and keeps the content and address, so publishing again restores the same URL. Changing a published address
(with confirmation) makes the old URL stop working; there are no redirects. Public pages are never cached and
are marked `noindex, nofollow`: anyone with the address can read them, but they aren't offered to search engines.

The public RSVP section is never an RSVP form: guests still answer only through their party's link
(`/rsvp/<token>`). While the site is published, the RSVP page also shows the wedding's public name, date and city
with a link to the site; unpublishing removes that context and never affects guest links.

**Guest invitation email (LB-11, Phase 2).** A party can have one optional **contact email** ("Correo de
contacto"), set when it is created or later, by any member (owner or collaborator), and changed or removed at any
time. It belongs to the party, not to individual guests (guests still have no contact data), isn't unique (one
address may receive several invitations), and is private wedding data: only members see it, on the Invitados page;
it never appears on the public website, the RSVP page, a URL, a log or any guest/public database function. It is
stored normalized (trimmed, domain lowercased, conservative syntax, ≤ 254 characters), checked by the server and
the database alike. Changing or removing it never touches the link, the guests or their answers, and sends nothing.

The invitation email goes out through **Resend**, only when an organizer asks, and carries the party's RSVP link
(`/rsvp/<token>`). Because only the link's hash is stored, an email can only carry a link whose plaintext exists
right now:

- **Fresh link, any member.** Right after creating a party (or replacing its link), the panel that shows the link
  also offers "Enviar invitación por correo". The browser sends that token back in the form body (never a URL); the
  database confirms it is still the party's current, usable link before anything is sent.
- **Existing party, owner only.** An invitation email for an existing party still means a new link (to email the
  party's current link again without replacing it, use LB-14's "Enviar recordatorio"):
  "Generar nuevo enlace y enviar" (with a confirmation naming the address) replaces the link — the old one stops
  working; guests and answers stay — and emails the new one. Collaborators are told an owner must do it; the
  service and the database refuse it anyway. Nothing is ever rotated silently.

The email (fresh Spanish copy; plain text and HTML, every user value escaped, a one-line subject) includes the
party's name, the wedding's name, date and city when set, a "Confirmar asistencia" button with the raw link as a
fallback, a note that the link is personal, and a "Ver sitio de la boda" link only while the website is published.
Absolute links use the configured `APP_ORIGIN`, never the request's host. Each party shows "Nunca enviada" or
"Última invitación enviada el … a …" (the latest successful send only: when, to which address, and the provider's
message id). Clients can't write that status, not even through an RPC: a user's session can't prove what the
provider answered, so it is recorded by one narrow database function executable only by `service_role`, called by a
dedicated server-only recorder right after the provider accepted the message. That is the app's single, documented
service-role exception ([ADR-004](docs/architecture/ADR-004-invitation-delivery-recorder.md)); all authorization
still uses the user's own session, and the key is never a general-purpose client. Copying
the link by hand keeps working everywhere.

Sending is one provider call per click, never retried automatically and never claimed to be exactly-once. If the
provider fails nothing is recorded and every link stays valid; if "Generar nuevo enlace y enviar" fails after
replacing the link, the replacement is not rolled back: the new link is shown to copy or retry. If the provider
accepts but the status can't be saved, the page says the email went out and asks not to resend yet. Without email
configuration sending fails safely and nothing else is affected. Tests never reach Resend: unit and database tests
inject a fake sender, and the E2E suite runs the app with a local file outbox (see `.env.example`).

**RSVP confirmation email (LB-12, Phase 2).** When a party saves or changes its RSVP through its link and the party
has a contact email, the server emails a confirmation of the party's **current** answers ("Confirmación de
asistencia — {boda}"): the party label, the wedding's name, date and city, each guest with "Asistirá" / "No
asistirá" and, only while the site is published, a link to the wedding website. It is rendered from what the
database saved, never from the form, and it deliberately leaves out food notes, the contact email and ids. **It does not
carry the RSVP link or token**: it confirms the answer, and forwarding it never hands anyone the party's
capability. To change the answer, the party uses the link it received with the invitation.

The RSVP is primary and the email secondary. The answers are saved first, and only then is an email attempted
(one provider call, no automatic retries). A party without a contact email, missing email configuration, a
provider failure or a failure to record the send never affects the saved RSVP. The guest always sees "Guardamos
tu respuesta", plus at most one calm sentence about the email. That sentence never shows the address, which the RSVP
page never reveals. Organizers see "Confirmación de asistencia por correo: Última confirmación enviada el … a …" on the
party card, separate from the invitation status. Only the latest successful confirmation is kept, and its
recipient can differ from the current contact email. The guest has no account, so reading the party's private contact
email for the send, and recording it, go through the same server-only recorder module, by the link's hash only
([ADR-005](docs/architecture/ADR-005-rsvp-confirmation-email.md)). The RSVP itself never uses the service role.

**Recoverable RSVP link (LB-13).** A party's RSVP link is meant to be ONE personal link for its whole life: the
same link can be shared again later (copy today; reminders, WhatsApp or other channels later) until an owner
explicitly generates a new one. Organizers (owners and collaborators) can now click **Mostrar enlace** on a party
card to see and copy its current link again, exactly the link the party already has. The guest-list page never
loads links by itself: only that explicit click recovers one, the link is never cached or stored in the browser,
and "Ocultar" removes it from the page. Revoked or expired links are never shown.

The plaintext token is still never stored. Its SHA-256 hash stays the only thing that validates a guest's link.
Each new or replaced link is also stored as an **AES-256-GCM** envelope in a private table
(`private.guest_invitation_capability_secrets`, no client access, not on the Data API), bound to that hash and
written in the same transaction. The key, `RSVP_CAPABILITY_ENCRYPTION_KEY`, lives only in the server environment,
never in the database. Recovery checks membership, then decrypts on the server and re-checks the hash. It builds
the URL from `APP_ORIGIN` (no email provider needed), and only that URL reaches the browser. A database dump alone
still reveals no usable link; the dump plus the key would
([ADR-006](docs/architecture/ADR-006-recoverable-rsvp-capability.md)). The key is required to create parties and
generate new links: without it they fail safely before changing anything. Losing or changing the key never breaks
guests' links; it only makes existing links unrecoverable until an owner generates new ones (no keyring yet).

Links created before LB-13 have only their hash, so they **keep working for guests** but can't be shown again.
"Mostrar enlace" says so. An owner can generate a new link once (the old one stops working, as always) and from then
on it is recoverable; collaborators are told an owner must do it. Nothing is backfilled or rotated automatically.

**Manual RSVP reminders (LB-14).** Organizers (owners and collaborators) can remind a party with its **same** personal
link, from the party card's "Recordatorio de confirmación" panel, only when they ask:

- **Enviar recordatorio** emails the party's current contact email ("Recordatorio de confirmación — {boda}"). The
  email has the party's name, the wedding's name, date and city when set, a "Confirmar asistencia" button with the
  party's current RSVP link (and the raw link as a fallback), and the website only while it is published. Unlike the
  RSVP confirmation, it is meant to carry the link. It never includes answers, food notes, ids or provider data.
- **Preparar mensaje para WhatsApp** shows a short ready-made text (greeting, reminder, current link) to copy and send
  yourself. The app doesn't send it, store it or record it, and needs no phone number. There is no WhatsApp or SMS
  integration.

Both recover the party's current link on the server at the moment of the click (LB-13), so a link an owner replaced
after the page loaded is the one used. Nothing ever rotates, revokes or creates a link. The recipient is always the
contact email stored right now, never a value from the page. Revoked or expired links get no reminder. Links created
before LB-13 can't be reminded until an owner explicitly generates a new link (collaborators are told so). Without a
contact email, only the WhatsApp text is available.

Each send is one provider call, never retried automatically. A provider failure records nothing and leaves the link
as it was. If the provider accepted but the status couldn't be saved, the page says so and asks not to resend yet.
Each party shows "Recordatorio por correo: Último recordatorio enviado el … a …" (latest successful reminder only),
next to and separate from the invitation and confirmation statuses. That status is written only by a
service_role-only database function, through the same server-only recorder
([ADR-007](docs/architecture/ADR-007-manual-rsvp-reminder-delivery.md)).

**Wedding activity history (LB-15).** Each wedding has an **Actividad** page (`/app/weddings/[id]/activity`, linked
from the wedding's home) showing what happened to its guest parties, newest first (the latest 50): "Invitación
creada", "Enlace personal regenerado", "Acceso RSVP revocado", "Correo de contacto actualizado", "Invitación enviada
por correo", "RSVP recibido", "RSVP actualizado", "Confirmación RSVP enviada" and "Recordatorio RSVP enviado". Each
row names the party (its current name, or "Grupo eliminado"), who did it (a member, the group through its personal
link, or the system) and when, in the wedding's time zone.

- **Append-only.** History is written only by the database function that performs each fact, in the same
  transaction (a failed history write rolls the action back, and the other way round). No one can edit or delete a
  row, not even through the API as a member; deleting the wedding deletes its history. Revoking a link now goes
  through one owner-only function, `revoke_guest_invitation_link`, so the revocation and its history row commit
  together.
- **Members only.** Owners and collaborators read their own wedding's history; outsiders get a 404, and guests and
  anonymous visitors get nothing.
- **Only facts that really happened.** Emails appear only after the provider accepted them **and** the send was
  recorded. A failed or `sent_but_unrecorded` send leaves no history row.
- **Nothing sensitive.** No links, tokens, hashes, envelopes, RSVP answers, food notes, email addresses or provider
  ids are stored in or shown by the history.
- **Starts at LB-15.** Nothing earlier is backfilled; existing weddings start with an empty history.

See [ADR-008](docs/architecture/ADR-008-basic-activity-history.md).

**Checklist ↔ guest work (LB-16).** A checklist item can be about one guest party of the same wedding (e.g.
"Confirmar el transporte" → "Familia Pérez"). On the checklist, "Vincular con invitados" picks the party from the
wedding's groups; a linked item shows "Relacionado con: Familia Pérez · Ver grupo", and "Cambiar vínculo" / "Quitar
vínculo" change or remove it. On **Invitados**, each party card lists its "Pendientes relacionados" (title and
status), each linking back to the item on the checklist.

- **One typed relation.** `checklist_items.guest_invitation_id`: zero or one party per item (a party may have many
  items). No stored URLs, routes, JSON or polymorphic links; routes are derived from the ids.
- **Same wedding, enforced by the database.** A composite foreign key `(guest_invitation_id, wedding_id)` makes a
  party of another wedding (or a made-up id) impossible to link, for every role.
- **Same permission as checklist editing.** Owners and collaborators link, change and unlink; outsiders, guests and
  anonymous visitors can't. The link grants no access to the party.
- **Linking never changes status.** Done stays done, pending stays pending; RSVPs, emails and reminders never
  complete an item. Linking also never touches the party, its guests, answers, link, emails or history.
- **No copied guest data.** The checklist stores only the party id and shows the party's current name; no guest
  names, contact email, answers, notes, tokens or RSVP links are copied.
- **Deleting.** Deleting the party keeps the item (status included) and just unlinks it; deleting the item leaves
  the party untouched.

See [ADR-009](docs/architecture/ADR-009-checklist-guest-work.md).

**Automatic RSVP reminders (LB-17).** An owner can turn on **one automatic reminder email** per party that hasn't
answered yet, 14, 21 or 30 days before the wedding (default 21) at 10:00 in the wedding's time zone. It's off by
default, needs the wedding's date and time zone, and shows the send date before saving; collaborators see the status
but can't change it. Each party card says "Recordatorio automático: programado para … / enviado el … / no se enviará: …"
(already answered, no contact email, link not recoverable or not active, emailed in the last 7 days, date passed), and
Actividad shows an automatic send as "Automático".

- **Same capability rules as manual reminders.** The email carries the party's CURRENT link (recovered, never rotated)
  to its CURRENT contact email, all re-checked right before the send; a party that answers in the meantime gets nothing.
- **At most one per party, never twice on purpose.** A claim/lease state machine in the database
  (`automatic_rsvp_reminders`, one row per party) plus a stable provider idempotency key per occurrence. A send that may
  have gone out is only ever replayed with that same key (≤ 3 attempts, within 23 h); anything uncertain stops for good
  and is shown for review instead of being resent.
- **Manual first.** A manual reminder or invitation email in the last 7 days suppresses the automatic one; manual
  reminders are never blocked.
- **No session, narrow privilege.** The scheduler is a `GET /api/cron/rsvp-reminders` route protected by
  `CRON_SECRET` (Bearer header, timing-safe) that drives five service_role-only database functions through one
  server-only module. Responses carry counts only.
- **Infrastructure only, no sends yet.** `vercel.json` schedules the route once daily (`0 15 * * *`, 15:00 UTC;
  Vercel Hobby allows only daily crons) and `CRON_SECRET` is provisioned in Production (LB-17A.2). The 48 h send
  window is unchanged, so a daily run still reaches every due reminder, up to ~24 h late (see ADR-010 §3). Automatic
  sending stays operationally disabled: every reminder policy is OFF (the default), and production email delivery is
  blocked until `listalaboda.com` is owned and verified with the email provider. Deploying or migrating alone never
  sends anything.

See [ADR-010](docs/architecture/ADR-010-automatic-rsvp-reminder-scheduling.md).

**Email delivery ledger (LB-18.1, persistence foundation only).** "Sent" means the provider accepted an email; it
doesn't mean it arrived. LB-18 will record what happened afterwards (delivered, delayed, bounced, spam complaint), in
slices. LB-18.1 only lays the foundation: every invitation, RSVP confirmation, manual reminder and automatic reminder
email that is successfully recorded now also gets one row in `email_deliveries`, with its kind, the provider's email
id (unique) and the address it went to, written in the same database transaction as the existing "sent" status and
activity row. Rows are immutable, visible only to the wedding's members (never the provider id) and deleted with their
party or wedding. Nothing visible changes yet, and nothing is backfilled: emails sent before LB-18.1 have no row. See
[ADR-011](docs/architecture/ADR-011-email-delivery-observability.md).

**Signed delivery webhooks (LB-18.2, passive ingestion foundation only).** `POST /api/webhooks/resend` accepts Resend's
signed delivery events (delivered, delayed, failed, suppressed, bounced, spam complaint), verified with the Standard
Webhooks/Svix signature over the raw body and `RESEND_WEBHOOK_SECRET`. Each event is matched to its recorded email only
by the provider's email id, deduplicated by its event id, kept as internal history (`email_delivery_events`, no client
access) and advances that email's delivery status by a fixed rank, so duplicates and out-of-order events never move it
backwards. Opens and clicks are never processed. Nothing is visible yet, nothing blocks sending, and no production
webhook or secret is configured (a separately approved step).

**Delivery status and the same-address guard (LB-18.3).** Each "última … enviada el … a …" line on a party card now also
shows what happened to that email ("Enviado", "Entrega retrasada", "No se pudo enviar", "Entregado", "Bloqueado",
"Rebotó", "Marcado como spam", or "Estado de entrega no disponible" for sends before LB-18.1), to owners and
collaborators only. When the party's CURRENT contact email has already bounced, been suppressed or marked an email as
spam in this wedding, the card shows a warning, and the invitation email, "Generar nuevo enlace y enviar" and the manual
reminder email buttons are disabled and the server refuses them before anything is sent or rotated; the RSVP
confirmation is quietly skipped (the RSVP is always saved). Addresses are compared ignoring case and surrounding spaces
(a case-only edit is the same address; dots and `+tags` still count). Delayed and failed never block. Changing the contact
email to a different address makes sending possible again; sharing the link
("Mostrar enlace", the WhatsApp text) is never blocked; there is no override. No production webhook is configured.

**Automatic reminders and undeliverable addresses (LB-18.4).** The automatic reminder follows the same rule: it is not
sent to a CURRENT contact email that bounced, was suppressed or marked an email as spam in this wedding ("No se
enviará automáticamente a esta dirección porque tuvo un problema de entrega."). It is checked when the reminder is
picked up and again right before sending, so a bounce that arrives in between still stops it; nothing is consumed
(the one automatic reminder is still available). Changing the contact email to a genuinely different address brings it
back; a case-only edit doesn't. "Recently reminded" now only counts invitations and reminders sent to the current
address: an email to an old address no longer delays the reminder to a new one. A bounce of a reminder that was already
sent never changes it. The production webhook is still not configured, so nothing is suppressed in production yet.

Still deferred: recurring or multi-stage reminders, per-party automation settings, production webhook activation
(LB-18.5), and messaging APIs and phone numbers.

**Seating plan foundation (LB-19).** "Mesas" lets owners and collaborators create tables (name and capacity, 1–50),
seat each guest at one table, move and unseat them, and see occupancy ("8 / 10"), who still has no table (grouped by
party) and a summary. Every seated person takes a seat, whether they confirmed or haven't answered yet; capacity is
enforced by the database, also under concurrent edits. Guests who declined can't be seated; a guest who declines after
being seated stays on their table with a "No asistirá" warning until someone unseats them. It is a list-and-forms
tool: there is no visual floor plan, drag and drop, chair-level seating, plus-ones or automatic seating. See ADR-012.

## Stack

Next.js (App Router) · React · TypeScript (strict) · Tailwind CSS · Supabase (`@supabase/ssr`) ·
Vitest · Playwright · npm · Node 22 LTS (`.nvmrc`).

## Local development

```bash
nvm use                      # Node version from .nvmrc
npm ci
cp .env.example .env.local   # fill in values; see comments in the file
npm run dev                  # http://localhost:3000
```

RSVP link recovery (LB-13): set `RSVP_CAPABILITY_ENCRYPTION_KEY` (generate one with
`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`; it is a secret, keep it stable and
never commit it) and `APP_ORIGIN`. Every absolute RSVP link (shown after creating or replacing it, emailed or
recovered) is `APP_ORIGIN` + `/rsvp/<token>`, never derived from the request's Host/Origin headers. Without the key
or `APP_ORIGIN`, creating parties and generating links refuse safely. The E2E suite uses a fake, test-only key.

Email (optional locally): set `APP_ORIGIN`, `EMAIL_FROM`, `RESEND_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` (the
local `SECRET_KEY` from `npx supabase status`; used only for email delivery metadata, ADR-004/ADR-005/ADR-007) to send
real invitation, RSVP confirmation and RSVP reminder emails,
or `EMAIL_TRANSPORT=outbox` with an absolute `EMAIL_OUTBOX_DIR` (localhost `APP_ORIGIN` only) to write them to files.
Without them, everything works except sending (RSVPs are still saved; they just get no confirmation email).

Automatic reminders (LB-17, optional locally): with the email settings above, set `CRON_SECRET` to a random value of
at least 32 characters (generate one yourself, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`;
never commit it) and call the scheduler yourself:
`curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/rsvp-reminders`. Locally nothing calls it on
its own (the `vercel.json` cron runs only on Vercel). The E2E suite uses a fake, test-only secret.

Delivery webhooks (LB-18.2, optional locally): set `RESEND_WEBHOOK_SECRET` (a `whsec_…` signing secret) only when
exercising `POST /api/webhooks/resend`; without it the route answers 503 and records nothing. It also needs
`SUPABASE_SERVICE_ROLE_KEY`. The tests sign events with fake, test-only secrets; no real webhook is involved.

Local Supabase (requires Docker): `npx supabase start`. Then copy the API URL and publishable key
from `npx supabase status` into `.env.local`. The project is not linked to any remote Supabase project.

Local auth: email + password. The local stack auto-confirms sign-ups (`enable_confirmations = false`
in `supabase/config.toml`), so a new account is signed in immediately. If confirmation is enabled (as
expected in production), sign-up shows "Revisa tu correo" and the emailed link returns through
`/auth/callback`. Locally, those emails would appear in Mailpit (`http://127.0.0.1:54324`).

## Tests and checks

| Command | What it does |
|---|---|
| `npm run lint` | ESLint |
| `npm run typecheck` | Route typegen + `tsc --noEmit` |
| `npm run test:run` | Vitest unit tests (`npm test` for watch mode) |
| `npm run test:e2e` | Playwright journeys against a production build and the local Supabase stack (run `npx playwright install chromium` once; needs `npm run db:start`) |
| `npm run verify` | lint + typecheck + unit tests + build (CI `verify` job) |

### Database (local Supabase, requires Docker)

| Command | What it does |
|---|---|
| `npm run db:start` / `npm run db:stop` | Start / stop the local Supabase stack |
| `npm run db:reset` | Recreate the local database from `supabase/migrations/` |
| `npm run db:test` | RLS and security integration tests against the local stack (fails if it isn't running) |
| `npm run db:types` | Regenerate `src/lib/supabase/database.types.ts` from the local schema |
| `npm run db:types:check` | Fail if the committed types don't match the local schema |
| `npm run db:verify` | `db:reset` + `db:test` + `db:types:check` |

The DB tests sign up fake `@example.test` users on the local stack and use a direct local Postgres
connection only to arrange fixtures and read ground truth. They refuse to run against non-local hosts.
CI runs them in the `database` job on a throwaway local stack.

The E2E suite (`npm run test:e2e`) signs up fresh `e2e-…@example.test` accounts each run and deletes
the previous run's E2E accounts and weddings from the local database first. It reads the Supabase URL
and publishable key from `supabase status` (or the `NEXT_PUBLIC_*` env) and refuses non-local hosts.
CI runs it in the `e2e` job. `npm run db:reset` wipes all local accounts; nothing depends on rows
created by hand.

Formatting: no formatter is configured yet. Follow the existing style in your editor. We can add
one later.

## Product and architecture

- [Product Constitution](docs/product/PRODUCT-CONSTITUTION.md)
- [ADR-001 — Product domain and tenancy](docs/architecture/ADR-001-product-domain-and-tenancy.md)
- [ADR-002 — Auth and security boundaries](docs/architecture/ADR-002-auth-and-security-boundaries.md)
- [ADR-003 — Donor extraction policy](docs/architecture/ADR-003-donor-extraction-policy.md)
- [ADR-004 — Service-role exception: recording invitation-email delivery](docs/architecture/ADR-004-invitation-delivery-recorder.md)
- [ADR-005 — Service-role exception: RSVP confirmation email](docs/architecture/ADR-005-rsvp-confirmation-email.md)
- [ADR-006 — Recoverable RSVP capability encryption](docs/architecture/ADR-006-recoverable-rsvp-capability.md)
- [ADR-007 — Manual RSVP reminder delivery](docs/architecture/ADR-007-manual-rsvp-reminder-delivery.md)
- [ADR-008 — Basic wedding activity history](docs/architecture/ADR-008-basic-activity-history.md)
- [ADR-009 — Checklist ↔ guest work](docs/architecture/ADR-009-checklist-guest-work.md)
- [ADR-010 — Automatic RSVP reminder scheduling](docs/architecture/ADR-010-automatic-rsvp-reminder-scheduling.md)
- [ADR-012 — Seating plan domain model](docs/architecture/ADR-012-seating-plan-domain-model.md)

Database migrations live in `supabase/migrations/` and are named `YYYYMMDDHHMMSS_lb_<slug>.sql`.
After changing the schema, run `npm run db:reset && npm run db:types` and commit the regenerated types.
