# ADR-015 — Wedding Budget and Payment Model

Status: Accepted (LB-22) · Date: 2026-10-08
Related: [Product Constitution §8 Phase 3, §9](../product/PRODUCT-CONSTITUTION.md), [ADR-001 §2, §7](ADR-001-product-domain-and-tenancy.md), [ADR-002 §3, §4, §6](ADR-002-auth-and-security-boundaries.md), [ADR-008](ADR-008-basic-activity-history.md), [ADR-012](ADR-012-seating-plan-domain-model.md), [ADR-014](ADR-014-wedding-vendor-engagement-model.md)

## Context

The Constitution plans a Phase 3 budget — "estimated / committed / paid, per category or vendor, due dates" — and rules
out accounting-grade budgeting (ledgers, invoices, tax). LB-21 (ADR-014) established the WeddingVendor engagement with a
contracted amount in CRC or USD and recorded that payments would reference it without letting it silently vanish. LB-22
adds the budget and the vendor payment schedule on that spine, and prepares the data a planner dashboard (LB-24) will
read.

## Decision

### 1. Four money concepts, one authority each

| Concept | Meaning | Where it lives |
|---|---|---|
| Estimate | Planning intent: how much the couple expects to spend | `wedding_budget_totals`, `wedding_budget_allocations` |
| Committed | What was contractually agreed | `wedding_vendors.contracted_amount_minor + currency` of **booked** vendors (LB-21) |
| Obligation | A scheduled part of one vendor's contract | `vendor_payment_schedule_items` |
| Payment | Money actually paid | `vendor_payments` |

There is **no second committed column**: the vendor's contracted amount stays the only authority for what was agreed.
Accounting (ledger, journal, invoice, receipt, tax, reconciliation, bank feeds, payment processing) is out of scope.

### 2. Estimates

- An optional wedding **total per currency**: one row per `(wedding_id, currency)`.
- Optional **category allocations per currency**: one row per `(wedding_id, category, currency)`, reusing
  `public.wedding_vendor_category`. `other` is one shared bucket for every custom vendor type; there are no custom
  budget categories.
- The total and the allocations are intentionally **independent**: allocations never have to sum to the total. The UI
  shows the difference ("Sin asignar a categorías" / "Las categorías superan el total por …") and never blocks saving.
- A missing allocation is "Sin presupuesto asignado", never zero. 0 is a valid explicit estimate.
- Removing an estimate is an explicit action that deletes its row; a blank amount is never "remove".

### 3. Non-vendor expenses are deferred

LB-22 covers estimates, vendor commitments, vendor schedules and vendor payments only. There is no `wedding_expenses`,
`transactions` or generic polymorphic obligation. A future expense model (e.g. a wedding-scoped expense with its own
optional schedule) is additive: the budget summary already works per currency and category, and a new source of
"committed"/"paid" can join it without changing these tables.

### 4. Schedule items and payments

- `vendor_payment_schedule_items`: label (1–80, single line), amount (> 0), `due_on` (a Postgres `date`). Same-wedding
  composite FK `(wedding_vendor_id, wedding_id) → wedding_vendors (id, wedding_id)`; `UNIQUE (id, wedding_vendor_id,
  wedding_id)` is the target of the payments' item FK.
- `vendor_payments`: amount (> 0), `paid_on`, an optional single-line `note` (1–500: "SINPE #8842", "Transferencia BAC",
  "Efectivo" — instead of a payment-method enum), and an optional `schedule_item_id`.
- **Optional allocation**: a payment applies to at most ONE schedule item, through the composite FK
  `(schedule_item_id, wedding_vendor_id, wedding_id)` (MATCH SIMPLE: null = "Sin cuota"). One item may have many
  payments (**partial payments**). A payment never spans several items. **Unallocated payments** are allowed and may be
  linked later (or unlinked) by editing.
- Payments are editable and hard-deletable. There are no reversal rows, soft deletes or audit trail: LB-22 is not a
  ledger. Deleting a payment simply changes the derived state.

### 5. Invariants (database-enforced, per vendor)

1. A schedule item or payment needs `contracted_amount_minor` and `currency` (`vendor_contract_required`). A quote is
   never a contract.
2. **Allocation invariant**: Σ schedule items + Σ unlinked payments ≤ contracted amount
   (`vendor_schedule_exceeds_contract` when an item grows it, `vendor_payment_exceeds_unscheduled` when an unlinked
   payment does). An unallocated payment consumes contract room exactly like a schedule item.
3. Σ payments linked to an item ≤ that item's amount (`vendor_payment_exceeds_schedule_item`).
4. An item can't drop below what is paid against it (`vendor_schedule_item_below_paid`).
5. A payment update is evaluated as its proposed new state with itself excluded from the sums, so moving it between
   items, or item ↔ "Sin cuota", re-checks the destination's cap atomically.

Together they imply Σ payments ≤ contract and, per vendor, the **decomposition identity**
`contract − paid = scheduled remaining + unscheduled`, where scheduled remaining = Σ (item − its payments) and
unscheduled = contract − Σ items − Σ unlinked payments.

### 6. Currency derivation and the vendor guard

Child rows store **no currency**: it is the vendor's. A `BEFORE UPDATE OF currency, contracted_amount_minor` trigger
on `wedding_vendors` (`private.enforce_wedding_vendor_finance`) applies once any schedule item or payment exists:

- the currency can't change (`vendor_currency_locked`; same-currency writes are no-ops);
- the contracted amount can't become null (`vendor_contract_required`);
- it can't drop below the **recorded floor** Σ items + Σ unlinked payments (`vendor_contract_below_recorded`); it may
  grow freely;
- quote and status are untouched: finance never couples to status, and status never changes automatically.

The UI shows the currency as fixed text with the reason; the database stays authoritative for stale forms.

### 7. Deletion: NO ACTION, not RESTRICT

Both vendor references and the payment → item reference are `ON DELETE NO ACTION`:

- a vendor with any schedule item or payment can't be deleted (`has_financial_records`); financial history is never
  cascaded away — "Descartado" is the way out;
- an item with payments can't be deleted (`schedule_item_has_payments`); its payments are never silently unallocated.

ADR-014 §11 anticipated `RESTRICT`. **NO ACTION** is chosen because it checks at the end of the statement: every child
also references `weddings (id) ON DELETE CASCADE` directly, so deleting a wedding removes vendors, items and payments in
one statement and the NO ACTION checks then find nothing left. `RESTRICT` checks immediately and can refuse the
wedding's own cascade depending on trigger order. Direct vendor or item deletion is blocked either way.

### 8. Concurrency: the vendor row lock

Every financial write that can move a sum — item insert/amount update, payment insert/amount/allocation update — runs a
`BEFORE` trigger that first locks the parent vendor row (`SELECT … FROM wedding_vendors … FOR UPDATE`) and only then
re-sums. Vendor updates already hold that row lock. So all monetary writes of one vendor serialize, and in READ
COMMITTED each subsequent statement sees the winner's committed rows: two concurrent final payments of the same item →
exactly one succeeds; a payment racing a contract or item reduction never leaves an invariant broken. Nothing checks a
sum in the application (no check-then-write race).

The trigger functions follow the LB-19 precedent: SECURITY INVOKER (they run as the member, under RLS, which sees the
whole wedding), `search_path = ''`, `EXECUTE` revoked from everyone. No SECURITY DEFINER function, RPC or service role.

### 9. Statuses are derived, never stored

There is no `status`, `is_paid`, `paid_at` or `overdue` column. Per item: paid = Σ linked payments; progress
`pending` (0) / `partial` / `paid` (= amount). Timing exists only while something remains and the wedding has a time
zone:

- `overdue`: `due_on` < wedding-local today — **due today is not overdue**;
- `due_soon`: today ≤ `due_on` ≤ today + **14 days**;
- `later`: otherwise.

Without a wedding time zone dates still show, nothing is labelled overdue or due soon, and a short hint explains why.
The clock is read once per request at the page boundary (`weddingLocalToday`); `@/lib/budget/summary` is pure. Display
precedence: Pagado > Vencido > Vence pronto > Parcial > Pendiente, with the paid/remaining amounts always shown too.

### 10. Formulas (per currency, never combined, BigInt)

- **Committed** = Σ contracted amount of vendors with `status = booked` and a contracted amount (LB-21, unchanged).
- **Paid** = Σ every payment in that currency, whatever the vendor's status.
- **Remaining (Pendiente)** = Σ over booked vendors of (contract − that vendor's payments) — never
  "committed − global paid", which payments to non-booked vendors would distort.
- **Scheduled remaining** = Σ over non-discarded vendors of (item − linked payments).
- **Unscheduled** = Σ over booked vendors of (contract − items − unlinked payments).
- **Overdue / due soon** = Σ remaining of such items of non-discarded vendors.
- **Total variance** = total − committed ("Disponible" / "Sobre presupuesto"), only when a total exists.
- **Category variance** = allocation − committed in that category and currency, only when an allocation exists.

Discarded vendors' items stay visible on the vendor page but leave the global overdue/upcoming sections; their payments
stay real and count in Paid.

### 11. Non-booked payments need attention

A vendor not marked "Contratado" may have a contract and payments (the couple paid a deposit before updating the
status). Those payments count in Paid while the contract doesn't count in Committed, so the budget page lists them under
"Atención: Pagos a proveedores que no están como Contratado". Nothing changes the status automatically and nothing adds
those contracts to Committed.

### 12. CRC / USD separation

Only CRC and USD (the LB-21 set). Each currency is an independent block; there is no combined total, exchange rate,
conversion or "equivalent" amount anywhere.

### 13. Access, read model and exposure

- Private organizer data: owners and collaborators have identical CRUD rights (four member policies per table on
  `private.is_wedding_member(wedding_id)`), column grants exclude ids, the wedding, the parent vendor after insert,
  provenance and timestamps; anon has nothing. Nothing is reachable from `/boda`, `/rsvp`, guest functions or email.
- Budget page: membership + TWO reads whatever the size — the wedding (time zone, totals and allocations embedded) and
  its vendors (items and payments embedded through named relationships). Vendor page: membership + the vendor with its
  items and payments in one query + the wedding's time zone.
- No activity events (ADR-008 unchanged), checklist links, reminders/email/scheduler, storage or documents.

### 14. LB-24 readiness

A planner dashboard can read, per wedding, the same two queries and `summarizeBudget`: committed, paid, remaining,
overdue and due-soon amounts per currency, without new columns. Due dates are indexed by `(wedding_id, due_on)`.

## Consequences

- Every monetary invariant holds for every role and every client, under concurrency, without an RPC.
- Editing money is constrained once money is recorded: lowering a contract or switching currency needs the schedule or
  payments adjusted first. Accepted: the alternative is silently inconsistent records.
- No audit trail of payment edits. Accepted for a planning tool; accounting is out of scope.

## Rejected alternatives

- **A committed-amount column on budget rows** — two authorities for "what was agreed" would drift.
- **Stored item status / `paid_at`** — would go stale with every payment edit and time zone change.
- **Currency on child rows** — redundant with the vendor's and able to disagree with it.
- **SECURITY DEFINER RPCs for payments** — unnecessary: invoker triggers under RLS plus the row lock give the same
  guarantees with the normal member boundary.
- **CASCADE from vendor or item** — would erase financial history with one click.
- **Generic expenses / ledger entries now** — premature; the vendor case is concrete, the rest is additive.
