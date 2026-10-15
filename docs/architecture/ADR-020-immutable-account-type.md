# ADR-020 — Immutable Account Type (Planner or Couple)

Status: Accepted (ACCOUNT-01) · Date: 2026-10-14
Related: [ADR-001](ADR-001-product-domain-and-tenancy.md), [ADR-002 §3, §6](ADR-002-auth-and-security-boundaries.md),
[ADR-017](ADR-017-dual-couple-planner-use.md), [ADR-018](ADR-018-multi-wedding-overview-and-attention.md)
Amends: ADR-017 §4 (persona is now stored, as an account type), §7 (entry depends on it) and the "Persisted persona /
`account_type`" row of its rejected alternatives. Everything else in ADR-017 stands.

## Context

ADR-017 kept couple and planner as unstored personas: one account could hold any mix of memberships, and `/app` adapted
only to the wedding count. The product owner has since frozen a different account model (ACCOUNT-01):

- exactly two account types, **planner** and **couple**;
- one authenticated user/email has exactly one type, chosen explicitly and never changed;
- someone who needs both uses two accounts with two email addresses;
- marketing splits into two landings (`/planners`, `/parejas`); `/` is no longer a third, generic landing.

The type has to change what the product offers (a couple sees "our wedding", a planner sees "Mis bodas"), so it has to be
stored. It must not change who may access a wedding.

## Decision

### 1. Storage: `public.user_accounts`

The repository has no profile or account table (identity is `auth.users`; wedding authority is `wedding_memberships`). A
new table holds only the choice:

| Column | Meaning |
|---|---|
| `user_id` | PK, `references auth.users (id) on delete cascade` |
| `account_type` | `public.account_type` enum: `planner`, `couple` (`not null`) |
| `selected_at` | database clock, set on insert |

**No row = not selected yet** (the product's `NULL`). Nothing else is stored: no profile fields, no metadata.

An enum (not a CHECK) because the schema already models every closed set as an enum (`wedding_role`,
`wedding_site_theme`, …) and the generated types then carry it to TypeScript (`ACCOUNT_TYPES` mirrors it).

### 2. Immutability, database-enforced

- Clients (`anon`, `authenticated`) have no INSERT, UPDATE or DELETE privilege. `authenticated` SELECTs its own row (RLS
  `user_id = auth.uid()`).
- The only write path is `public.select_account_type(requested)`: SECURITY DEFINER, `search_path = ''`, no user id
  parameter (the caller is `auth.uid()`). It inserts once (`ON CONFLICT DO NOTHING`) and returns the stored type; the
  same type again is an idempotent no-op; the other type raises `account_type_already_selected` (55000). Concurrent
  first choices serialize on the primary key: exactly one wins.
- A guard trigger (`private.guard_user_accounts`) applies to **every role**, including the function owner and
  `service_role`: an UPDATE that changes any column is refused (`account_type_immutable`), a same-value UPDATE is a
  no-op, and DELETE is refused except the `auth.users` cascade (trigger depth ≥ 2), so deleting an account still works.
- Allowed: none → planner, none → couple, planner → planner, couple → couple. Refused: planner ↔ couple, anything →
  none.
- There is no product UI or application API to change a type. An emergency correction is an operator's reviewed,
  database-level intervention (disabling the guard inside one transaction), never a feature.

### 3. Never inferred

The type is only ever the user's explicit choice. Never from the landing page, a call to action, the referrer, the number
of weddings, invitations, roles, `created_by`, the email domain, `user_metadata`/`app_metadata` or behavior. Existing
accounts get no row and no backfill; they are asked on their next entry. (A landing page may later *suggest* a card;
nothing does today, and a suggestion never selects or submits.)

### 4. First authenticated entry

`/login` and `/signup` are unchanged and shared (no `/login/planner`). After authentication they continue to `next`
(`/app` by default). The `/app` layout calls `requireAccountType` (`@/lib/accounts/session`): signed out → `/login`; no
type → `/onboarding/account-type?next=<the requested /app path>`; a failed read throws (never read as "no type"). The
onboarding page lives **outside** `/app`, so the guard never loops on it. It shows two choices, nothing preselected, a
short warning, and a confirmation button named after the choice ("Continuar como …"); a card click alone saves nothing.
A typed account never sees it again (it redirects to `next`). After the choice the user continues to `next`
(re-validated by `safeNextPath`, never back into onboarding), so an accepted invitation still lands on its wedding.

The `/app` layout is the shared deep-link guard: every `/app/**` page renders inside it, so no URL skips the choice.
Server Actions don't run layouts; the one action whose outcome depends on the type (`createWeddingAction`) calls
`requireAccountType` itself. All others are authorized by wedding membership, which the type doesn't affect.

### 5. Wedding creation

The account type also constrains wedding **creation**, enforced the same way by the database and the application:

- **planner:** any number of weddings;
- **couple:** a wedding only while they belong to **zero** weddings (any membership, owner or collaborator, blocks it);
- **untyped** (no row): creation refused; the one-time choice comes first;
- **invitations still add memberships** for any account: joining a wedding (`accept_membership_invite`) is not
  creating one. A legacy couple keeps every wedding they belong to and can't create more.

Database (`20261025120100_lb_create_wedding_account_type.sql`): `create_wedding` (same signature, SECURITY DEFINER,
grants and owner) locks the caller's `user_accounts` row `FOR UPDATE`, then refuses with SQLSTATE 55000
`account_type_required` (no row) or `couple_wedding_limit` (couple with any membership). The lock serializes concurrent
creations by the same account, so a couple's simultaneous first submissions create exactly one wedding.

Application: the header's "Mis bodas"/"Crear boda", the switcher's "Crear otra boda" and the wedding page's "Volver a
mis bodas" are planner-only; `/app/weddings/new` redirects a couple who already has a wedding to `/app`;
`createWeddingAction` checks `canCreateWedding` first and maps the database refusals (`couple_wedding_limit` → the
couple's "ya tiene una boda" message, `account_type_required` → onboarding). This is a creation rule only: wedding
access, RLS and memberships are unchanged.

### 6. Entry (`/app`)

| Type | 0 weddings | 1 wedding | 2+ weddings |
|---|---|---|---|
| planner | LB-24A empty state | LB-24A redirect into it | LB-24C "Mis bodas" (overview + attention), unchanged |
| couple | couple empty state: "Crear mi boda" + invitation hint | redirect into it (`?all` ignored) | **legacy**: plain list |

A failed membership list is an error for both, never an empty state or a redirect.

**Legacy couple with several weddings.** Under ADR-017 one account could belong to many weddings. If such an account
chooses couple, nothing is deleted, moved or chosen for them: `/app` shows a plain list of their weddings (name, date,
city, role; no overview, attention or create action) with a short explanation. The switcher still moves between them.

### 7. Not authorization

The account type never grants or restricts wedding access. `wedding_memberships`, `private.is_wedding_member`,
`private.has_wedding_role`, RLS, roles (`owner | collaborator`) and every wedding-scoped domain are unchanged
(ADR-017 §2, §3, §5 stand). A planner and a couple are both ordinary members of the weddings they belong to.

### 8. Marketing

`/` redirects (`next.config.ts` `redirects()`, 307, server-side) to `/planners`, the default commercial entry. The
generic homepage, its copy and its two homepage-only screenshots are removed. The header links exactly "Para planners",
"Para parejas", "Cómo funciona" (`#como-funciona` on the current page) and "Iniciar sesión"; the brand opens
`/planners`. One shared `HowItWorks` section explains both account paths on both pages, the page's own audience first.
SEO policy is unchanged (noindex, no canonical, robots, no sitemap); no public signup link is added.

## Consequences

- Two migrations: `20261025120000_lb_account_type.sql` (the enum, the table, its guard, `select_account_type`) and
  `20261025120100_lb_create_wedding_account_type.sql` (the creation rule in `create_wedding`). Existing users and
  weddings are untouched; production needs both before (or with) the deploy that reads them. Untyped production
  accounts can't create a wedding until they choose (the app sends them to the choice first anyway).
- `requireAccountType` adds one small read per `/app` request (memoized per render, shared by layout and page).
- Pilot: the planner demo account must choose "Wedding planner" on its next login.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Nullable column on a new `profiles` row per user | Needs a trigger on `auth.users` and a backfill; "no row" says "not chosen" with less machinery. |
| CHECK constraint on text | Every other closed set is an enum; the enum flows into generated types. |
| Client INSERT grant + RLS | A second write path; the SECURITY DEFINER function is the one approved door. |
| Store the type in `user_metadata` | User-editable through Auth; ADR-002 forbids metadata as authority. |
| Infer couple/planner from weddings or invitations | The user must choose; inference would misclassify legacy accounts. |
