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
at once, while items with a specific date stay put. No "overdue" status exists yet (there is no
time-zone model).

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
