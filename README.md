# listalaboda.com

listalaboda.com es una plataforma que facilita la gestión de muchos items en tu lista de to-dos de la boda.

> Convierte los cientos de pendientes de tu boda en una lista clara, compartida y a tiempo.

## Status

**Auth and membership flows (LB-04).** On top of the application foundation (LB-02) and the wedding
tenancy schema with RLS (LB-03), couples can sign up, sign in, create a wedding, invite a partner or
collaborator with a copyable single-use link, and the invitee joins the same wedding. The checklist
arrives in LB-05.

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
