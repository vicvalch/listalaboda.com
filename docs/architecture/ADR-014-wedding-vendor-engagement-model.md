# ADR-014 — Wedding Vendor Engagement Model

Status: Accepted (LB-21) · Date: 2026-10-08
Related: [Product Constitution §3, §5, Phase 3](../product/PRODUCT-CONSTITUTION.md), [ADR-001 §2, §7](ADR-001-product-domain-and-tenancy.md), [ADR-002 §3, §4, §6, §8](ADR-002-auth-and-security-boundaries.md), [ADR-008](ADR-008-basic-activity-history.md), [ADR-009](ADR-009-checklist-guest-work.md), [ADR-012](ADR-012-seating-plan-domain-model.md)

## Context

The Constitution plans vendors as a Phase 3 *record the couple manages* — "a light directory: contact, category,
quote/contract amount, linked items" — never a login, portal or marketplace. Couples (and the planners who help them)
track who they are considering for each service, what each one quoted, and who they finally booked.

The approved roadmap builds on this in order: LB-21 vendors, LB-22 budget and payments, LB-23 the wedding-day
timeline, LB-24 a planner operations dashboard. LB-21 must establish the vendor engagement spine those slices hang
from, without building any of them early, and without a planner-wide vendor directory.

## Decision

### 1. Identity: a Wedding-scoped engagement

One table, `public.wedding_vendors`; domain entity **WeddingVendor**. A row is a vendor *engagement of one wedding*
(this couple's florist), not a global vendor. Every row has a `wedding_id` (ON DELETE CASCADE) and authority comes only
from `wedding_memberships` (ADR-001 §2).

There is **no global `vendors` table, no planner/organization directory, no ownership outside the wedding, and no
copy-between-weddings** in LB-21. A directory needs an owner (a planner or organization), which the product doesn't
model yet (the Constitution keeps planners and organizations out of the MVP), and it would create a cross-tenant read
surface that LB-21 doesn't need.

### 2. The engagement owns its identity and contact fields

`name`, `category`, `custom_category`, `contact_name`, `email`, `phone`, `instagram_handle` are COPIED into the
engagement. One primary contact only (no contact list). Editing an engagement never affects another wedding.

Future directory (additive): a later directory table may add a nullable reference from `wedding_vendors` to a
directory entry ("created from"). Creating an engagement from the directory still **copies** identity into the
wedding row, so existing engagements, their RLS and every LB-22/LB-23 child stay unchanged, and a directory edit never
rewrites a wedding's history silently.

### 3. Schema

```
wedding_vendor_category  enum: venue, catering, photography, video, music, flowers_decor, cake_desserts, beauty,
                               attire, officiant, stationery, transport, lodging, rentals, planning, other
wedding_vendor_status    enum: considering, quoted, selected, booked, discarded

wedding_vendors
  id uuid PK, wedding_id uuid NOT NULL → weddings ON DELETE CASCADE,
  name text (1–120, trimmed, no control characters; NOT unique),
  category wedding_vendor_category NOT NULL, custom_category text (1–60; iff category = other),
  status wedding_vendor_status NOT NULL DEFAULT considering,
  contact_name text (1–120), email text (guest contact-email stored form), phone text (4–40, conservative),
  instagram_handle text (^[A-Za-z0-9._]{1,30}$, no "@"),
  currency text (CRC | USD; iff an amount exists),
  quoted_amount_minor bigint, contracted_amount_minor bigint (0 – 99 999 999 999 999),
  notes text (≤ 4000, trimmed; \n \r \t are the only controls),
  created_by uuid default auth.uid() → auth.users ON DELETE SET NULL (provenance only),
  created_at, updated_at (private.set_updated_at)
  UNIQUE (id, wedding_id) — wedding_vendors_id_wedding_key; INDEX (wedding_id, created_at)
```

Every rule is a CHECK, mirrored by `@/lib/vendors/validation` for Spanish field messages; the service re-validates
before writing. No triggers besides `updated_at`, no functions.

### 4. Category: closed enum + custom "Otro"

Sixteen built-in categories with fixed Spanish labels (`es.vendors.categories`). `other` requires a short custom type
("Seguridad"), and only `other` may have one (`wedding_vendors_custom_category_iff_other`); it is displayed in place of
"Otro". New built-ins are an additive enum migration. Unknown categories are refused by the enum.

### 5. Status: a business outcome, no state machine

`considering` (En evaluación) · `quoted` (Cotizado) · `selected` (Elegido) · `booked` (Contratado) · `discarded`
(Descartado). Any status may change to any other; there are no transition rules, timestamps or history. Status never
depends on money and money never depends on status. There is no payment vocabulary (no contacted, completed, paid,
archived): payment state belongs to LB-22.

### 6. Financial boundary

LB-21 stores exactly two summaries: the **quote** and the **contracted amount**. No paid amount, deposit, balance, due
date, schedule, terms, tax, invoice or receipt (all LB-22).

- **Currencies: CRC and USD only** (current product need, Costa Rica). Text + CHECK; adding a currency is an additive
  migration (widen the CHECK) plus a catalog label.
- **Integer minor units** (`bigint`), never floating point or `numeric` amounts. The maximum, 99 999 999 999 999, keeps
  every stored amount an exact JavaScript number (below `Number.MAX_SAFE_INTEGER`). Null = not entered; 0 is valid.
- **Currency iff an amount**: a currency exists exactly when at least one amount does
  (`wedding_vendors_currency_iff_amount`); both amounts share it. The form may *suggest* the currency of the most
  recently updated vendor, but with no amount the currency is dropped, never stored alone.
- **Parsing** (`@/lib/vendors/money`): digits, one grouping separator kind in groups of three, and an optional 1–2
  digit decimal part after `.` or `,`. A single separator followed by exactly three digits is grouping
  (`1.200` = 1200). Ambiguous or malformed input (`1.2.3`, `1,20,0`, `1200.500`, signs, exponents) is refused, never
  reinterpreted. Assembly is integer (BigInt), never `parseFloat`.
- **Never mixed**: amounts in different currencies are never added; there is no FX conversion. The list's
  "Contratado" total sums only `booked` vendors' contracted amounts, one line per currency. Quotes are never summed
  (competing quotes for one service would double count). Formatting is `Intl.NumberFormat("es")` from an exact
  decimal string (USD shows as "US$", never a bare "$").

### 7. Contact privacy

Vendor data — contacts, amounts, notes — is PRIVATE organizer data. The email is informational only: nothing imports
it into `@/lib/email`, sends to it or tracks it. Links are generated, never stored: `mailto:` (local part encoded),
`tel:` (digits and "+" only), and `https://www.instagram.com/<handle>/` from a validated handle
(`rel="noopener noreferrer"`). No website field and no arbitrary URL or scheme is stored or rendered. Notes render as
plain React text (`whitespace-pre-line`): no HTML, Markdown or rich text.

### 8. Tenancy and access

RLS on in the creating migration; `REVOKE ALL` from anon and authenticated first. Authenticated: SELECT; INSERT of the
editable columns plus `wedding_id`; UPDATE of the editable columns only (never `id`, `wedding_id`, `created_by` or
timestamps); DELETE. Four member policies on `private.is_wedding_member(wedding_id)`: **owners and collaborators have
identical rights**. anon has nothing.

No SECURITY DEFINER function, no RPC, no service role, no public, RSVP, guest-capability or published-site projection.
The service (`@/lib/vendors/service`) checks membership first and scopes every read and write by `(id, wedding_id)`:
another wedding's vendor id, a deleted one and a malformed id look identical (pages 404; writes are `invalid_target`).
Concurrent edits are last-write-wins (no versions, locks or realtime).

### 9. Read model

The list is ONE wedding-scoped query of the list columns (no notes); summary, category groups, ordering (status rank
booked → selected → quoted → considering → discarded, then `localeCompare("es")`), search and filters are derived in
memory. Free-text search (vendor and contact names, case- and accent-insensitive) is local only and never put in a
URL; the category and status filters may be (`?category=&status=`). The detail page is ONE query scoped by id and
wedding, with notes. Expected scale is 10–50 vendors per wedding: no pagination or extra indexes.

### 10. Delete semantics

Hard delete, the repository convention. Deleting a wedding cascades its vendors. Deleting a vendor removes the
engagement; "Descartado" is a status, not a deletion, and discarded vendors stay listed (muted). No `archived_at`.

### 11. Future relationships (recorded, not built)

`UNIQUE (id, wedding_id)` is the target for same-wedding composite foreign keys `(wedding_vendor_id, wedding_id)`:

- **LB-22 payments** reference a vendor with `ON DELETE RESTRICT`: a vendor with recorded money can't silently vanish.
  The contracted amount stays the engagement's authority for "what was agreed"; payments record what was paid.
- **LB-23 timeline** entries reference a vendor with `ON DELETE SET NULL (wedding_vendor_id)`: the timeline survives.
- **Documents** (contracts, receipts), if ever added, most likely `ON DELETE CASCADE` with their storage cleanup.

No child relation exists in LB-21, so nothing restricts deletion yet.

### 12. Deliberately not here

Checklist ↔ vendor links (`checklist_items.wedding_vendor_id`; the Constitution's "linked items"), activity events or
status history (ADR-008 stays guest-invitation/RSVP facts), documents and storage, vendor login or portal, a public
vendor directory, email to vendors, realtime.

## Consequences

- One small, private, wedding-scoped table that LB-22 and LB-23 can reference safely within a wedding.
- Vendor identity is duplicated per wedding. Accepted: it is what makes engagements independent, and a directory can
  be layered on additively.
- CRC/USD only; another currency needs a migration. Accepted for a concrete, local need.

## Rejected alternatives

- **A global `vendors` table with per-wedding links** — needs an owner the product doesn't have, opens cross-tenant
  reads, and makes one wedding's edit change another's records.
- **`numeric` or floating-point money** — floats round; `numeric` arrives in JavaScript as strings or floats. Integer
  minor units are exact end to end.
- **A status state machine** — real engagements move in every direction (a booked vendor cancels, a discarded one comes
  back); rules would only get in the way.
- **Soft delete (`archived_at`)** — "Descartado" already covers "no longer considered"; deletion stays a real delete.
- **Summing quotes** — competing quotes for the same service would inflate the total.
