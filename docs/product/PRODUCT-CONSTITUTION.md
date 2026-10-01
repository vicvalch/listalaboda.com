# listalaboda.com Product Constitution

Status: Accepted (LB-01) · Date: 2026-09-30 · Baseline: `7c050f3`

This document governs every subsequent product and implementation decision for
listalaboda.com. Changing a rule here requires an explicit, reviewed amendment —
not an implementation-time shortcut. Architectural detail lives in:

- [ADR-001 — Product Domain and Tenancy](../architecture/ADR-001-product-domain-and-tenancy.md)
- [ADR-002 — Authentication and Security Boundaries](../architecture/ADR-002-auth-and-security-boundaries.md)
- [ADR-003 — Donor Extraction Policy](../architecture/ADR-003-donor-extraction-policy.md)

---

## 1. Product Promise

**Product name:** listalaboda.com

**Primary promise (es):**

> listalaboda.com convierte los cientos de pendientes de tu boda en una lista clara, compartida y a tiempo, para que organizar la boda se sienta manejable.

**Extended definition.** listalaboda.com is a wedding-planning checklist for
couples. When a couple creates their wedding and sets the date, they get a
ready-made, categorized to-do list whose due dates are calculated back from the
wedding day. They share it with their partner and helpers, assign items, and
watch progress. Guests, RSVP, a wedding website, vendors and budget come later
as modules that *support the list* — they never replace it.

**Problem statement.** Planning a wedding means hundreds of small, time-sensitive
decisions spread over 12+ months, usually tracked across notes, spreadsheets,
chats and memory. Couples don't know what to do next or what they've forgotten,
and the work lands unevenly on one person. listalaboda.com answers three
questions at any time: *what's left, what's next, and who's doing it.*

**Anti-definition.** listalaboda.com is NOT:

- generic project-management or PM software;
- "PMFreak for weddings";
- enterprise governance, approval or compliance software;
- a gift registry (see §14, branding risk);
- a vendor marketplace or vendor portal;
- a single-couple wedding website (the Wedding-Fran-Marilu model);
- an AI agent that plans the wedding for you.

## 2. Primary User

**Launch model: A — Couple-first B2C.**

| Group | Who |
|---|---|
| PRIMARY USER | The couple getting married (one or both partners), planning their own wedding. |
| SECONDARY USERS | Collaborators the couple invites: partner, family member, maid of honor, friend — or a person who works professionally as a wedding planner, invited as an ordinary `collaborator` with exactly the collaborator permission set (no `planner` role exists in the MVP). |
| FUTURE USERS | Guests (Phase 2, token access, no account). Professional planners with a dedicated `planner` role and planner-specific permissions, and agencies managing many weddings (Phase 3+). |
| OUT OF MVP | Guests, vendors, any `planner` role or planner-specific permission/dashboard, agencies/organizations, platform-admin UI. |

Rationale: the original README speaks to the couple ("tu lista de to-dos de la
boda"), the product name is couple-language, and the domain-proven donor
(Wedding-Fran-Marilu) is couple-operated. A planner-first or dual-entry model
would force multi-tenant B2B machinery before B2C usefulness is validated. This
choice was made on product coherence, not on reuse convenience.

**Planners in the MVP:** there is **no `planner` authorization role in the
MVP**. A person who works professionally as a wedding planner may participate
in an MVP wedding only if an owner invites them, via a MembershipInvite, as an
ordinary `collaborator` — and they receive exactly the collaborator permission
set. There are no hidden planner flags, views or permissions. Planner-specific
roles, organization semantics, multi-wedding dashboards and planner-specific
permissions are Phase 3.

## 3. Secondary Actors

| Actor | MVP? | Access | Scope | Capabilities | Boundaries |
|---|---|---|---|---|---|
| Couple owner | Yes | Account (Supabase Auth) | Weddings where they hold `owner` | Everything in the wedding, incl. issuing MembershipInvites and removing members, editing wedding details, deleting the wedding | Cannot remove the last owner |
| Couple collaborator | Yes | Account | Weddings where they hold `collaborator` | Read and edit the checklist; create, assign, complete items | Cannot manage members, change wedding settings, or delete the wedding |
| Planner | Phase 3 (as a role) | Account | Explicitly assigned weddings only | Phase 3: collaborator capabilities + planner-specific permissions and a multi-wedding dashboard | No `planner` role exists in the MVP. In the MVP a professional planner participates only if an owner invites them as an ordinary `collaborator`, and gets exactly the collaborator permission set. Never sees a wedding without explicit membership/assignment. |
| Planner agency | Future | Account(s) via Organization | Weddings explicitly assigned to the org | Assign planners to weddings | Org membership does NOT imply access to every wedding |
| Guest | Phase 2 | **Token**, no account | One GuestInvitation (household) in one wedding | View their invitation and the wedding's published info; submit/update RSVP for their party | Nothing else. No checklist, no other guests |
| Vendor | Out (no portal) | None | — | Exists only as a *record* the couple manages (Phase 3) | No vendor login |
| Platform admin | Operational only | Supabase dashboard / privileged ops, never in-app in MVP | Platform | Support, incident response | Never via shared passwords or user-editable metadata |

## 4. Core Product Metaphor

**The checklist (la lista) is the product.**

- The checklist is the **default landing surface** of a wedding.
- Every other module exists to help complete items on the list.

**A checklist item** is one thing someone has to do for the wedding, e.g.
"Reservar el lugar de la recepción". Conceptual fields (not a schema):

```
ChecklistItem
  id
  wedding_id                 -- mandatory; tenancy boundary
  title
  notes                      -- free text
  status                     -- pending | done | not_applicable
  category                   -- from a fixed category set (MVP)
  due_date                   -- absolute date, OR
  due_offset_days            -- relative to wedding date (negative = before)
  assignee                   -- a member of this wedding, optional
  template_item_ref          -- origin template item, optional
  created_at / updated_at / completed_at / completed_by
  (links to other modules)   -- Phase 2+, as explicit nullable FKs, not
                             -- text-typed polymorphic pairs
```

**Lifecycle:** `pending → done`, `pending → not_applicable`, and either can go
back to `pending`. `not_applicable` exists because a template generates items
that don't fit every wedding; hiding beats deleting. No `in_progress`,
`blocked`, `in_review` or approval states.

**Dates:** an item has either an absolute due date or an offset from the wedding
date. When the wedding date changes, relative items move with it. If the
wedding has no date yet, relative items simply have no concrete date.

**Complexity ceiling.** A checklist item stays deliberately simpler than a
PMFreak execution task. The following are **OUT**, permanently unless this
constitution is amended:

| Concept | Decision |
|---|---|
| Task dependencies | OUT |
| CPM / critical path | OUT |
| RAID logs | OUT |
| Baselines | OUT |
| Forecasts / earned value | OUT |
| Governance approvals | OUT |
| AI-generated execution authority | OUT |
| Material-action policies | OUT |
| Sub-tasks | OUT for MVP (revisit only with user evidence) |

## 5. Checklist Templates

- Templates are **core** and **in the MVP**: an empty list fails the promise of
  "muchos items".
- Flow: create wedding → (optional) set date → choose template → checklist is
  generated → items get dates relative to the wedding date.
- MVP ships **one** Spanish (`es`) general template. Content is authored in a
  later prompt; LB-01 does not define the dataset.
- **Categories exist**, as a fixed, curated set in the MVP (e.g. lugar,
  ceremonia, proveedores, invitados, atuendo, papeleo, luna de miel). Custom
  categories are Phase 3.
- Generated items are copies: editing or deleting them never changes the
  template, and template updates never rewrite existing weddings.
- Country/culture-specific templates (e.g. MX, ES, AR, US-Hispanic, religious
  vs civil) are supported later via a template `locale`/`variant`. The design
  must allow it; the MVP doesn't build it.

## 6. Domain Root

**Wedding is the aggregate root and the primary data-security boundary.**

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

- No `Project`, `Program`, `Portfolio` or `PMO` concepts, aliases or hidden layers.
- `Organization` is a **reserved future concept**, not built in the MVP
  (see ADR-001).
- A user may belong to several weddings (schema allows it; MVP UI optimizes for one).

## 7. MVP

The smallest version of listalaboda.com that delivers the original promise:

1. Create an account (email-based Supabase Auth).
2. Create a wedding (names, optional date, optional city).
3. Set or change the wedding date; relative due dates recalculate.
4. Generate the checklist from the Spanish template, or start empty.
5. Create, edit, delete checklist items; mark `done` / `not_applicable` / reopen.
6. Categorize items (fixed category set).
7. Due dates: absolute or relative to the wedding date.
8. Assign items to a member of the wedding.
9. Views: "Próximos" (upcoming/overdue), by category, "Mis pendientes" (assigned to me).
10. Simple progress: overall and per-category completion.
11. Invite a partner/collaborator through a **MembershipInvite**: a secure,
    copyable link (email delivery may come with Phase 2's email infrastructure).
    A professional planner can be invited this way only as an ordinary `collaborator`.
12. Manage members (owner only): list, remove, see and revoke pending MembershipInvites.

**Guests / RSVP are NOT in the MVP.** They are the first item of Phase 2.

## 8. Post-MVP

**PHASE 2 — Guests and the outward-facing wedding**

- GuestInvitations (households/parties) → Guests → per-guest RSVP.
- Secure GuestInvitation tokens (ADR-002); no guest account; no open RSVP.
- GuestInvitation and RSVP confirmation emails via Resend; RSVP reminders.
- Minimal wedding website made of explicitly published content (see table below).
- Basic wedding activity history.
- Checklist items may link to guest-related work (explicit FKs).

**PHASE 3 — Running the wedding**

- Vendors (light directory: contact, category, quote/contract amount, linked items).
- Budget (estimated / committed / paid, per category or vendor, due dates).
- Seating (depends on Phase 2 RSVP data).
- `planner` role, planner-specific permissions and a multi-wedding planner dashboard;
  Organization/agency semantics with explicit wedding assignment.
- Custom categories; additional templates/locales.
- Notification digests ("this week's pendientes").

**DEFERRED (no committed phase)**

- AI suggestions (§12), billing (§11), gallery, gift registry, mobile apps,
  additional UI languages, vendor portal (likely never).

**Wedding website section classification** (WFM-derived content):

| Section | Class |
|---|---|
| Couple intro | POST-MVP (Phase 2) |
| Ceremony | POST-MVP (Phase 2) |
| Reception | POST-MVP (Phase 2) |
| Schedule | POST-MVP (Phase 2) |
| Dress code | POST-MVP (Phase 2) |
| FAQ | POST-MVP (Phase 2) |
| RSVP | POST-MVP (Phase 2) |
| Hotels | OPTIONAL |
| Travel | OPTIONAL |
| Local recommendations | OPTIONAL |
| Gifts (info/links) | OPTIONAL — must not become a registry product |
| Gallery | OUT for now (media storage + privacy cost) |

## 9. Explicit Non-Goals

- PM machinery: dependencies, critical path, RAID, baselines, forecasts, Gantt.
- Governance: approvals, governed actions, policy engines, AOC, Frontera.
- AI agents or AI authority over any data.
- Vendor portal or marketplace.
- Gift registry / e-commerce.
- Accounting-grade budgeting (ledgers, invoices, tax).
- Planner/agency SaaS before couple usefulness is validated.
- A single-couple, hardcoded wedding site.
- Open, unauthenticated RSVP.

## 10. Security Principles

Full detail in ADR-002. Constitutional summary:

1. A client-supplied `wedding_id` never establishes authority.
2. Every protected request resolves the user's membership server-side.
3. Postgres RLS is enabled on every wedding-owned table from its first migration; it is the backstop, not the only check.
4. The service-role key is exceptional, isolated and justified per use — never the default persistence path.
5. Guest capabilities are explicit and narrow: one GuestInvitation, one wedding.
6. Missing or ambiguous authorization fails closed.
7. Denials do not reveal whether an inaccessible wedding exists.
8. MembershipInvite and GuestInvitation tokens are high-entropy, hashed at rest, expiring and revocable.
9. Nothing is public unless explicitly published. Wedding fields are private by default.
10. No shared passwords; no UI-only authorization; no authorization from user-editable metadata.

**Visibility classes**

| Class | Meaning | Examples |
|---|---|---|
| PRIVATE | Wedding members only | Checklist, notes, budget, vendors, contracts, guest list, member list |
| SHARED | A specific outside party, via scoped token | A household's GuestInvitation and its RSVP |
| PUBLIC | Anyone with the link, after explicit publishing | Ceremony/reception place & time, schedule, FAQ, dress code |

## 11. Commercial Model Boundary

**COMMERCIAL MODEL DEFERRED.** No Stripe, no plans, no paywalls in the MVP.

Architecture must stay compatible with:

- free or freemium B2C;
- paid-per-wedding (the Wedding is a natural billable unit);
- planner/agency subscriptions (the future Organization is the billable unit).

Therefore: entitlements, when they arrive, are checked server-side in one place
and attach to a Wedding or an Organization — never to scattered UI flags.
No feature limits are hardcoded into the domain model.

## 12. AI Boundary

**AI = OPTIONAL FUTURE ENHANCEMENT.**

- AI is never required to create a wedding, create or complete items, authorize anything, or run any core workflow.
- No agents in the MVP. No AOC, no Frontera, no governed actions.
- Future candidates: checklist and timeline suggestions, questions to ask vendors, copy help, drafting guest messages.
- AI output is always a *suggestion* a human accepts; it never writes wedding data on its own.

## 13. Localization

- **Primary locale: `es`.** The UI ships in Spanish only.
- **i18n-ready from day one, lightly:** user-facing strings live in a message
  catalog, not inline; dates, numbers and currency go through `Intl` with the
  wedding/user locale; templates carry a `locale`.
- **No locale routing** (`/es/...`) until a second language is actually planned.
- Code, identifiers, database names and docs are in English; product copy is in Spanish.

## 14. Product Design Principles

**North Star:** *Make wedding planning feel manageable.* Every feature must
reduce the feeling of "there's too much and I don't know where to start". If it
adds weight without adding clarity, it doesn't ship.

1. **The list is home.** Advanced modules support the list; they never replace it.
2. **Wedding language, not project language.** "Pendientes", "invitados", "proveedores" — never "tasks", "stakeholders", "workstreams".
3. **Simple before powerful.** Ship the simple version; add power only on evidence.
4. **Progressive disclosure.** Day one shows a few next steps, not 200 fields.
5. **One wedding, one clear home.** Everything about a wedding lives in, and resolves to, that wedding.
6. **Collaboration without bureaucracy.** Share and assign; no approvals, no workflows.
7. **Time-aware by default.** Dates relative to the wedding day surface "what's next" automatically.
8. **Secure and private by default.** Nothing leaks, nothing is public unless the couple publishes it.

## 15. Donor Policy

Full detail in ADR-003.

- **Wedding-Fran-Marilu:** domain rules and proven UX flows may inform a fresh
  implementation. Couple content, PII, photos, branding and its insecure
  auth/persistence patterns must never be ported.
- **PMFreak:** proprietary ("All rights reserved"). Patterns may be studied and
  independently reimplemented. No verbatim code, no branding, no AOC/Frontera
  dependencies, no governance machinery.
- Default: **retype and redesign, never copy wholesale.**

## 16. Branding Risk

"Lista de boda" is commonly understood in Spanish — notably in Spain — as a
**gift registry**, not a planning checklist. This may confuse visitors and hurt
SEO intent matching. **The product is not renamed in LB-01.**

## 17. Open Product Questions

1. **Branding / SEO validation:** Does the target market interpret
   "listalaboda.com" primarily as (A) wedding checklist/planning, (B) wedding
   registry, or (C) ambiguous? → customer interviews + keyword research, per country.
2. **Primary market:** which Spanish-speaking country first? Affects template
   content, vocabulary and the branding question above.
3. **Template content:** which items, categories and offsets form the default
   `es` template? Who authors and validates it?
4. **Planner pull:** do couples actually invite planners? Measure MembershipInvites
   accepted by professionals (joining as ordinary `collaborator`s) before building the planner role.
5. **Commercial model:** free, freemium or paid-per-wedding?
6. **Post-wedding lifecycle:** archive, read-only, export, or delete after the date?
7. **Collaborator permissions:** is a single `collaborator` role enough, or do
   couples need a read-only family member? (Add `viewer` only on evidence.)
