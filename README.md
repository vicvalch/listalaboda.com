# listalaboda.com

listalaboda.com es una plataforma que facilita la gestión de muchos items en tu lista de to-dos de la boda.

> Convierte los cientos de pendientes de tu boda en una lista clara, compartida y a tiempo.

## Status

**Data foundation (LB-03).** The application shell, tooling and Supabase client setup are in place
(LB-02), plus the wedding tenancy schema: weddings, memberships (owner/collaborator) and membership
invites, with RLS tested against a real local database. There is no product UI yet.

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

## Tests and checks

| Command | What it does |
|---|---|
| `npm run lint` | ESLint |
| `npm run typecheck` | Route typegen + `tsc --noEmit` |
| `npm run test:run` | Vitest unit tests (`npm test` for watch mode) |
| `npm run test:e2e` | Playwright smoke test (run `npx playwright install chromium` once) |
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

Formatting: no formatter is configured yet. Follow the existing style in your editor. We can add
one later.

## Product and architecture

- [Product Constitution](docs/product/PRODUCT-CONSTITUTION.md)
- [ADR-001 — Product domain and tenancy](docs/architecture/ADR-001-product-domain-and-tenancy.md)
- [ADR-002 — Auth and security boundaries](docs/architecture/ADR-002-auth-and-security-boundaries.md)
- [ADR-003 — Donor extraction policy](docs/architecture/ADR-003-donor-extraction-policy.md)

Database migrations live in `supabase/migrations/` and are named `YYYYMMDDHHMMSS_lb_<slug>.sql`.
After changing the schema, run `npm run db:reset && npm run db:types` and commit the regenerated types.
