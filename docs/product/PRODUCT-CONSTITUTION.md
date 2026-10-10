# listalaboda.com Product Constitution

Status: Accepted (LB-01) · Date: 2026-09-30 · Baseline: `7c050f3`
Amended: LB-24A (2026-10-09, [ADR-017](../architecture/ADR-017-dual-couple-planner-use.md)) — dual couple/planner use
of the same Wedding workspace: §2, §3, §6, §7 (item 11), §8, §9, §11, §14, §17.

This document governs every subsequent product and implementation decision for
listalaboda.com. Changing a rule here requires an explicit, reviewed amendment —
not an implementation-time shortcut. Architectural detail lives in:

- [ADR-001 — Product Domain and Tenancy](../architecture/ADR-001-product-domain-and-tenancy.md)
- [ADR-002 — Authentication and Security Boundaries](../architecture/ADR-002-auth-and-security-boundaries.md)
- [ADR-003 — Donor Extraction Policy](../architecture/ADR-003-donor-extraction-policy.md)
- [ADR-017 — Dual Couple/Planner Use on Wedding Membership](../architecture/ADR-017-dual-couple-planner-use.md)

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

**Product model (amended LB-24A, ADR-017): couple-first B2C and planner B2B, one
product, the same Wedding workspace.** The launch voice stays couple-first.

| Group | Who |
|---|---|
| PRIMARY USERS | The couple getting married (one or both partners), planning their own wedding (B2C). Professional wedding planners organizing their clients' weddings (B2B). Both use the same Wedding workspace. |
| SECONDARY USERS | Collaborators invited through a MembershipInvite as `owner` or `collaborator`: partner, family member, maid of honor, friend — or the planner (in a couple-first wedding) / the couple (in a planner-first wedding). |
| FUTURE USERS | Agencies managing many weddings through an Organization (deferred, §9). |
| OUT | Vendors, any `planner` role or persona-based permission, organizations, platform-admin UI. |

Rationale (LB-01): the original README speaks to the couple ("tu lista de to-dos
de la boda"), the product name is couple-language, and the domain-proven donor
(Wedding-Fran-Marilu) is couple-operated. This choice was made on product
coherence, not on reuse convenience.

Amendment (LB-24A): LB-01 assumed a planner or dual-entry model "would force
multi-tenant B2B machinery". It doesn't: Wedding is already the tenant and one
account may hold any number of Wedding memberships, so planners need no separate
platform, tenancy or role. Couple and planner are **product personas**, never
authorization inputs, and are not stored.

**Planners:** there is **no `planner` authorization role**. A planner is an
ordinary member of each wedding they work on — `owner` (e.g. they created it, or
were invited as one) or `collaborator` — with exactly that role's permission
set. Wedding membership remains the only access mechanism. There are no hidden
planner flags, views or permissions; a persona, subscription or metadata never
grants access. Organization semantics stay deferred.

## 3. Secondary Actors

| Actor | MVP? | Access | Scope | Capabilities | Boundaries |
|---|---|---|---|---|---|
| Couple owner | Yes | Account (Supabase Auth) | Weddings where they hold `owner` | Everything in the wedding, incl. issuing MembershipInvites and removing members, editing wedding details, deleting the wedding | Cannot remove the last owner |
| Collaborator (couple side or planner) | Yes | Account | Weddings where they hold `collaborator` | Read and edit the checklist; create, assign, complete items (and the later modules' member capabilities) | Cannot manage members, change wedding settings, or delete the wedding |
| Planner | Yes — a persona, not a role (LB-24A) | Account | Weddings where they hold a membership, as `owner` or `collaborator` | Exactly that membership's capabilities in each wedding; "Mis bodas" lists their own memberships | No `planner` role. Never sees a wedding without explicit membership; a persona, subscription or metadata grants nothing. |
| Planner agency | Future (deferred) | Account(s) via Organization | Weddings explicitly provisioned to its people | Deferred | Org membership alone grants NO wedding access; explicit Wedding membership provisioning comes first (ADR-017) |
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
- A user may belong to any number of weddings, with a role per wedding (amended
  LB-24A, ADR-017). The account-level entry (`/app`, "Mis bodas") may list or
  later aggregate only the weddings the user is a member of; it owns no
  operational data. Wedding remains the tenancy boundary and the URL
  (`/app/weddings/[weddingId]`) the only wedding selector — no stored "active"
  wedding. This overview is never a `Project`/`Program`/`Portfolio`/`PMO` concept.

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
    A professional planner is invited this way too, as an `owner` or `collaborator` (amended LB-24A).
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
- Multi-wedding overview and attention across the weddings a person is a member of
  (LB-24B+); no `planner` role is needed (amended LB-24A, ADR-017).
  Organization/agency semantics stay deferred (§9).
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
- A separate planner/agency SaaS fork, planner-specific tenancy or enterprise
  organization tenancy before commercial evidence. Planners use the same Wedding
  workspace (amended LB-24A).
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

Architecture must stay compatible with (amended LB-24A):

- free or freemium B2C;
- B2C: a Wedding-scoped entitlement / one-time purchase (the Wedding is a natural billable unit);
- B2B: an account-scoped planner subscription;
- later, possibly an Organization-scoped subscription for agencies.

Therefore: entitlements, when they arrive, are checked server-side in one place
and attach to a Wedding, an account or an Organization — never to scattered UI
flags. No feature limits are hardcoded into the domain model.

**Entitlements never authorize Wedding data.** Billing answers "is this feature
enabled?"; membership answers "may this user access this Wedding?". A planner
subscription never grants access to any wedding, and a Wedding purchase never
creates a membership.

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
9. **Simple for a couple, open for a planner** (LB-24A). A couple should never feel they are using
   enterprise planner software; a planner should never be trapped inside one wedding. With one wedding,
   `/app` opens it directly; with several, "Mis bodas" lists them. Inside, one wedding still has one clear home.

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
4. **Planner pull:** *architecture closed by LB-24A (ADR-017)*: planners use the
   same workspace as ordinary `owner`s or `collaborator`s; no planner role will be
   built on this question. Still open, on pilot evidence: how planners and couples
   actually split ownership (co-owners have symmetric authority, ADR-017) and what
   cross-wedding help planners need first.
5. **Commercial model:** free, freemium or paid-per-wedding?
6. **Post-wedding lifecycle:** archive, read-only, export, or delete after the date?
7. **Collaborator permissions:** is a single `collaborator` role enough, or do
   couples need a read-only family member? (Add `viewer` only on evidence.)
