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
and can come back later to change it. Guests see only their party's label and guests: no wedding
details, members, checklist or other parties. Guest reads and writes go through two narrow database
functions keyed by the token hash. Anonymous clients have no table access, and RSVP is never open (no
name search). A GuestInvitation is not a MembershipInvite and never creates an account or membership.

Still deferred: invitation/confirmation emails and reminders (Resend), the published wedding website,
activity history, and linking checklist items to guest work.

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

Database migrations live in `supabase/migrations/` and are named `YYYYMMDDHHMMSS_lb_<slug>.sql`.
After changing the schema, run `npm run db:reset && npm run db:types` and commit the regenerated types.
