@AGENTS.md

# listalaboda.com

Wedding-planning checklist for couples. Spanish-first. Next.js (App Router) + Supabase.

## Authoritative documents (they win over implementation convenience)

- `docs/product/PRODUCT-CONSTITUTION.md`
- `docs/architecture/ADR-001-product-domain-and-tenancy.md`
- `docs/architecture/ADR-002-auth-and-security-boundaries.md`
- `docs/architecture/ADR-003-donor-extraction-policy.md`

## Product rules

- Couple-first, Wedding-first, checklist-first. The list is home.
- Spanish-first: UI copy lives in `src/lib/i18n/messages/es.ts`, never inline. Code and docs are in English.
- Wedding language, not PM language: no project/program/portfolio/stakeholder/workstream/task concepts.
- No AOC, Frontera, governance machinery or AI authority.
- Donor code (Wedding-Fran-Marilu, PMFreak) is never copied; study, then reimplement (ADR-003).

## Engineering rules

- Strict TypeScript. No `@ts-ignore`, no `any` to silence errors.
- RLS enabled in the same migration that creates any table.
- The service-role key is never normal persistence. There is no service-role client;
  adding one needs a dedicated `server-only` module plus a written justification (ADR-002 §6).
  ESLint blocks `process.env.SUPABASE_SERVICE_ROLE_KEY` by default.
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

## Commands

- `npm run verify`: lint, typecheck, unit tests, build (same as CI)
- `npm run test:e2e`: Playwright journeys against a production build and local Supabase (needs `npx playwright install chromium` and `npm run db:start`)
- `npm run db:verify`: reset local DB, run RLS/security integration tests, check generated types (needs Docker + `npm run db:start`)
- `npm run db:types`: regenerate `src/lib/supabase/database.types.ts` after any schema change (never hand-edit it)

## Prompt sequencing

Work is delivered in numbered prompts (LB-NN). LB-02 is the application foundation. LB-03 is the product
data foundation: weddings, memberships, membership invites, RLS (no UI). LB-04 adds auth and membership
flows (signup/login/logout, wedding creation, invites). Don't implement ahead of the current prompt.
