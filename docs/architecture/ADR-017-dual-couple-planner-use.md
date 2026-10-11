# ADR-017 — Dual Couple/Planner Use on Wedding Membership

Status: Accepted (LB-24A) · Date: 2026-10-09
Related: [Product Constitution §2, §3, §6, §8, §9, §11, §14, §17](../product/PRODUCT-CONSTITUTION.md), [ADR-001 §3, §4, §6](ADR-001-product-domain-and-tenancy.md), [ADR-002 §2, §3, §4, §6](ADR-002-auth-and-security-boundaries.md)
Amends: ADR-001 §6 (steps 1–2, the planned `planner` role) and ADR-002 §2 (Planner actor row).

## Context

ListaLaBoda launched couple-first (Constitution §2). It is now commercially relevant to two groups:

- **couples (B2C)**, who usually work in one wedding and use the whole Wedding workspace; a future commercial model
  may be a Wedding-scoped one-time purchase;
- **professional planners (B2B)**, who may belong to many weddings and use the exact same workspace; a future
  commercial model may be an account-level subscription, and they will later want cross-wedding attention.

LB-01 assumed supporting planners would need a dedicated `planner` role (ADR-001 §6, ADR-002 §2) and that a
dual-entry model "would force multi-tenant B2B machinery". The data and security model already does what is needed:

- `public.wedding_memberships` (`owner | collaborator`) is the only source of wedding authority, checked server-side
  (`@/lib/authz/wedding`) and by RLS (`private.is_wedding_member`, `private.has_wedding_role`);
- one account may hold any number of memberships, with a role per wedding (zero, one, several; mixed roles);
- `create_wedding` makes the creator an owner, whoever they are, so planner-first and couple-first creation are the
  same flow; MembershipInvite links add the other side as owner or collaborator;
- tenancy is URL-scoped (`/app/weddings/[weddingId]`) and each wedding is authorized independently.

What was missing was product, not architecture: `/app` always showed a list (awkward for a one-wedding couple), the
shell copy assumed a couple ("Crear mi boda", "invita a tu pareja"), and the documents still promised a planner role.

## Decision

### 1. One product, no fork

Couples and planners use the same product and the same Wedding workspace. No separate planner app, planner tenancy,
planner mode or planner-specific chrome.

### 2. Roles stay `owner | collaborator`

No `planner`, `assistant` or `viewer` role is added. A planner is an ordinary member of each wedding they work on and
gets exactly that role's permissions. `private.is_wedding_member`, `private.has_wedding_role`, RLS policies, grants and
membership semantics are unchanged. (`viewer` remains an open question, added only on evidence — Constitution §17.)

### 3. Wedding access comes only from membership

Only `wedding_memberships` grants authority over a wedding. A planner persona, a subscription, an entitlement or
`user_metadata`/`app_metadata` never does. There is no service-role or SECURITY DEFINER "global overview" shortcut:
anything account-level reads through the user's own RLS-bound client.

### 4. Persona is a product segment, not data

Couple and planner are product personas. They are not stored (no `profiles`, `account_type`, `persona`, `is_planner`
or planner flag) and not asked at sign-up. A future onboarding question ("Organizo mi boda" / "Soy wedding planner")
may shape copy, analytics or the pricing funnel; it never shapes authorization.

### 5. Multi-wedding, each wedding isolated

One account may have any number of memberships. Each wedding stays its own tenant: operational domains (checklist,
guests/RSVP, site, seating, vendors, budget, timeline, activity) stay Wedding-scoped. An account-level view may list
or later aggregate only weddings the user is a member of; it owns no operational data.

### 6. URL tenancy, no active wedding

`[weddingId]` in the URL remains the only wedding selector. No `current_wedding_id`, `active_wedding_id`,
`last_active_wedding_id`, wedding cookie or wedding session state. A future switcher only navigates to another URL.

### 7. Account entry (`/app`)

Decided from the user's membership-based list (`listMyWeddings`) only, by the pure `decideWeddingEntry`
(`@/lib/weddings/entry`):

| List | `/app` |
|---|---|
| failed | the error state — never an empty state, never a redirect (no access inference from failure) |
| 0 weddings | empty state: create a wedding, or open the invitation link someone shared |
| 1 wedding | redirect to `/app/weddings/{id}` (owner or collaborator alike; never based on `created_by`) |
| 2+ weddings | "Mis bodas": the list (name, date, city, role), soonest date first, undated last, then by name |

The redirect target is built from the wedding id only; it never copies query strings. Membership-invite acceptance
keeps redirecting straight to `/app/weddings/{id}?joined=new|existing`, not through `/app`.

**"Mis bodas" escape.** With one wedding, a link to `/app` would bounce straight back into the wedding. The header's
"Mis bodas", the wedding page's "Volver a mis bodas" and the invite page's "Ir a mis bodas" therefore link to
`/app?all=1`, which always renders the list (or the empty state). `all` is closed — only the exact value `1` counts —
and is presentation only: it never changes which weddings are listed or authorized. The brand link stays `/app` (home).
"Crear boda" stays in the header, so creating another wedding is always one click away.

### 8. Planner-first and couple-first flows

- **Planner-first:** the planner creates the wedding (owner), then invites the couple — owner recommended, so the
  couple holds full authority over their own wedding.
- **Couple-first:** the couple creates the wedding (owner), then invites the planner as collaborator or owner,
  depending on the authority the planner needs (members, settings, publishing, owner-only guest-link operations).

### 9. Organizations deferred

No `organizations`, `organization_members`, `organization_weddings` or agency tenancy. If introduced later,
organization membership alone grants no wedding access; prefer explicit Wedding membership provisioning first.

### 10. Entitlements are not authorization

Billing (LB-27) answers "is this feature enabled?"; membership answers "may this user access this Wedding?".
Wedding purchase ≠ Wedding membership; planner subscription ≠ Wedding membership. Future compatibility: B2C
Wedding-scoped entitlement/purchase, B2B account-scoped planner subscription, possibly organization-scoped later.
Nothing about entitlements is implemented here.

### 11. Future upstream domains

Templates and a vendor directory may later become account- or organization-scoped, but they are copied into
Wedding-scoped operational records (as checklist templates already are, ADR-001 §5; vendors, ADR-014), never live-linked.

### 12. Vocabulary

The account-level surface is "Mis bodas" / a multi-wedding overview. Never Project/Program/Portfolio/PMO language in
UI, routes, module or type names (Constitution §6, §14). No "workspace", "portfolio" or "tenant" in user-facing Spanish.

## Accepted risk: symmetric co-owners

Several owners of a wedding have identical authority. Any owner may remove another owner, as long as the final-owner
invariant holds (database-enforced). In a planner-first wedding, a couple invited as owners could remove the planner, and
a planner who stays owner could remove a co-owner couple. This is accepted for commercial v1 and is **not solved** here;
it must be revisited from pilot evidence (e.g. ownership transfer or protected primary owner), as an explicit decision.

## Consequences

- No migration, RLS, grant, RPC, SECURITY DEFINER or service-role change; generated database types are unchanged.
- `listMyWeddings` additionally projects `city` (already a wedding column) for the list card.
- A couple with one wedding lands directly in it; a planner with several sees "Mis bodas"; a user who is both sees
  every membership with its own role.
- Still deferred, outside LB-24A: cross-wedding summaries, attention and priority (LB-24B+), a wedding switcher,
  cross-wedding search, billing/entitlements (LB-27), organizations, and the commercial launch P0s (password reset,
  production email domain ownership/verification, legal and commercial onboarding).

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| A `planner` membership role | No distinct capability set; planners need exactly owner or collaborator. Role inflation. |
| Persisted persona / `account_type` / planner flag | Invites authorization by persona; nothing needs it to work. |
| Separate planner product or B2B tenancy | Duplicates the workspace; the Wedding already is the tenant. |
| Stored active wedding (cookie, column, session) | Hidden tenancy state; the URL already selects the wedding. |
| Organizations now | No commercial evidence; org access would need its own provisioning rules. |
| Always list at `/app` | Makes the most common case (one wedding) take an extra click. |
| Remove "Mis bodas" for one-wedding users | Traps them in one wedding and hides the account level. |
