# ADR-001 — Product Domain and Tenancy

Status: Accepted (LB-01) · Date: 2026-09-30
Related: [Product Constitution](../product/PRODUCT-CONSTITUTION.md), [ADR-002](ADR-002-auth-and-security-boundaries.md)

## Context

listalaboda.com is a greenfield repository whose original promise is helping
couples manage the many items on their wedding to-do list. Two donors exist:

- **Wedding-Fran-Marilu (WFM)** — a production wedding site for a single couple.
  It proves the guest/RSVP/invitation/seating domain but has no tenancy at all:
  one wedding is implied by the deployment, couple names are hardcoded into
  schema comments and content, guests per RSVP are a flattened `guest_details`
  jsonb array, and invitations join to RSVPs by a plaintext `invite_token` text column.
- **PMFreak** — a multi-tenant PM SaaS whose aggregate is a generic project,
  with organizations, portfolios and governance layers.

We must decide the domain root, the tenancy boundary, the membership model,
how the checklist relates to it, and how a future planner/agency fits — without
importing PM concepts or overbuilding B2B before B2C is validated.

## Decision

### 1. Wedding-first

**Wedding is the aggregate root and the primary data-security (tenant) boundary.**
No `Project`, `Program`, `Portfolio` or `PMO` entities, aliases, base classes or
hidden generic layers. If a non-wedding event type is ever wanted, that is a
new decision, not a reason to generalize now.

### 2. `wedding_id` ownership

Every wedding-owned row carries a non-null `wedding_id` foreign key to
`weddings`, either directly or through a parent that does. Entities:

```
MembershipInvite, ChecklistItem,
GuestInvitation, Guest, RSVP, Event, ContentSection,
Vendor, BudgetItem, Seating, WeddingActivity
```

Conceptual model:

```
User
  └─ WeddingMembership (owner | collaborator)
       └─ Wedding                      -- aggregate root; every child carries wedding_id
            ├─ MembershipInvite        -- MVP
            ├─ ChecklistItem           -- MVP
            ├─ GuestInvitation         -- Phase 2
            │    └─ Guest
            │         └─ RSVP
            ├─ ContentSection          -- Phase 2
            └─ Vendor / Budget / Seating  -- Phase 3

Future:
Organization ──< WeddingAssignment >── Wedding
```

**Invitation terminology** — two distinct concepts that must never be conflated:

- **MembershipInvite** (MVP): invites a person to become an authenticated
  member (`owner` or `collaborator`) of one Wedding. Used for the
  partner/collaborator flow. Its token is random, high-entropy, hashed at rest,
  expiring and revocable. Accepting it requires a user account.
- **GuestInvitation** (Phase 2): a guest household/party invitation. It
  contains or relates to Guest records and grants their RSVP capability. Guest
  access does not require an authenticated user account.

- Rows never move between weddings.
- Cross-entity references within a wedding must stay within the same wedding
  (enforced by composite FKs `(wedding_id, id)` or equivalent checks — to be
  specified with the schema).
- Links from checklist items to other modules use **explicit nullable FKs**,
  not text-typed polymorphic `(linked_entity_type, linked_entity_id)` pairs, so
  that referential integrity and RLS both hold.

### 3. Membership model

```
User (auth.users)
  │
  └──< WeddingMembership >── Wedding
         wedding_id
         user_id
         role: owner | collaborator
         created_at
```

- MVP roles: **`owner`** and **`collaborator`** only.
- There is **no `planner` role in the MVP**; it is added in Phase 3, when it gains
  distinct capabilities (see §6).
- `viewer` is not created unless user evidence demands it.
- Rejected role names: `pm`, `program_manager`, `portfolio_manager`,
  `ai_agent`, `external_stakeholder`, `admin` (as a wedding role).
- A wedding always has at least one `owner`.
- The creator of a wedding becomes its `owner`; the second partner is
  typically invited as `owner` too.
- The weddings table has no "owner user_id" column as the source of authority —
  authority comes only from memberships. (A `created_by` audit column is fine.)
- A user may hold memberships in many weddings.
- **MembershipInvites** are token-based, single-use, expiring, revocable, and
  bound to one wedding and one intended role (`owner` | `collaborator`) (ADR-002).
  They are distinct from Phase 2 GuestInvitations.

### 4. Organization strategy — **B: reserved, not built**

- **No organization tables in the MVP schema.**
- The future shape is reserved:

```
Organization ──< OrganizationMembership >── User
      │
      └──< WeddingAssignment >── Wedding
```

- Organization membership will **not** automatically grant access to every
  wedding. Access requires an explicit `WeddingAssignment` (and, for the
  individual planner, a `WeddingMembership`) or an explicitly defined,
  documented organizational policy.
- Compatibility rules for the MVP so that adding Organization later is a pure
  additive migration:
  - authority is resolved through one server-side function/module
    ("can user U do A on wedding W"), not scattered checks;
  - RLS policies call a small set of helper functions (e.g. `is_wedding_member`)
    that can later be extended to consider assignments;
  - weddings are not owned by a user column;
  - no assumption that a user has exactly one wedding.

### 5. Checklist relationship to Wedding

- `ChecklistItem` belongs to exactly one Wedding; it is the default landing
  surface of that wedding.
- Assignees must be members of the same wedding.
- Relative due dates are stored as an offset from the wedding date and
  recalculate when the date changes.
- Templates are global, versioned reference data (not wedding-owned).
  Generating a checklist **copies** template items into the wedding; there is no
  live link that could leak changes between weddings.

### 6. Future planner compatibility

The path from couple-first to planner support is:

1. **MVP:** there is **no `planner` authorization role in the
   MVP**. A person who works professionally as a wedding planner may participate
   in an MVP wedding only if an owner invites them, via a MembershipInvite, as an
   ordinary `collaborator` — and they receive exactly the collaborator permission
   set. There are no hidden planner flags, views or permissions.
2. **Phase 3:** `planner` membership role with planner-specific permissions; a
   multi-wedding "my weddings" dashboard across weddings the planner is a member of.
3. **Later:** Organization + WeddingAssignment for agencies, billing per org.

Each step is additive. None requires changing `wedding_id` ownership.

### 7. Guest domain shape (Phase 2, decided now to fix the boundary)

```
Wedding
  └─ GuestInvitation (household / party)  -- first-class; the unit a guest token grants access to
       ├─ max_guests / allowed party size
       └─ Guest (first-class, per person)
            └─ RSVP response (per guest, per event if events exist)
```

- Replaces WFM's flattened `guest_details` jsonb and token-text joins.
- Party size is a property of the GuestInvitation; the household confirms which named
  guests (and permitted plus-ones) attend.
- No open RSVP: every response belongs to an existing GuestInvitation.
- Guest access does not require an authenticated user account.

### 8. Activity

A simple `wedding_activity` log (actor, action, entity reference, timestamp,
small metadata) is **Phase 2**. The MVP keeps `created_by`, `completed_by`,
`completed_at` on items. No governance event model, no event sourcing.

## Consequences

**Positive**
- One obvious answer to "whose data is this?" — every row resolves to one wedding.
- RLS policies are uniform: membership in `wedding_id`.
- Product language and data model match ("boda", not "proyecto").
- Planner/agency support remains an additive path.

**Negative / accepted costs**
- Adding Organization later costs a migration and an extension of the access
  helper functions. Accepted: cheaper than building unvalidated B2B now.
- Composite-FK discipline adds schema verbosity.
- The model is not reusable for non-wedding events. Accepted by design.

## Rejected Alternatives

| Alternative | Why rejected |
|---|---|
| Generic Project-first model (PMFreak-style) with Wedding as a project type | Imports PM vocabulary and complexity; contradicts the product's identity; violates "wedding language, not project language". |
| Organization as tenant root from day one (A) | Overbuilds B2B SaaS before B2C usefulness is validated; every couple would get a phantom org. |
| Pure "add later, no reservation" (C) | Risks MVP code baking in single-owner/one-wedding assumptions that make the later migration painful. Option B costs nothing extra. |
| User-owned weddings (`weddings.owner_id` as authority) | Breaks shared ownership between partners and future planner access. |
| Flattened guest JSON (WFM) | No per-guest identity, no referential integrity, hard to secure and query. |
| Polymorphic text links from checklist items | No FK integrity; easy cross-wedding leakage. |
| Roles `viewer`, `planner` in MVP | Role inflation without distinct capabilities. MVP planners are ordinary `collaborator`s with exactly that permission set. |
