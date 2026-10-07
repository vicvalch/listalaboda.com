# ADR-012 — Seating Plan Domain Model

Status: Accepted (LB-19) · Date: 2026-10-07
Related: [Product Constitution §8](../product/PRODUCT-CONSTITUTION.md), [ADR-001 §2, §6, §7](ADR-001-product-domain-and-tenancy.md), [ADR-002 §3, §4, §8](ADR-002-auth-and-security-boundaries.md), [ADR-008](ADR-008-basic-activity-history.md), [ADR-009](ADR-009-checklist-guest-work.md)

## Context

The Constitution lists "Seating (depends on Phase 2 RSVP data)" as a later module. Phase 2 built the guest domain
(ADR-001 §7): GuestInvitation (party) → Guest (one named person, stable UUID) → one current RSVP per guest. Couples
already plan the reception with the checklist item "Definir la distribución de las mesas" (`reception.layout`), but
had no place to record who sits where.

LB-19 ships the first functional seating plan — tables, seating, moving, unseating, occupancy — as plain forms. The
visual floor plan, drag and drop and coordinates are explicitly later (LB-20+). The model must not get in their way.

## Decision

### 1. The seating unit is `public.guests`

A guest row is already one invited person with a stable id, scoped to a party and a wedding, and RSVP is per guest.
Seating references it directly. There is **no attendee/person duplicate table**, no backfill, and no seating column
on `guests` (no guest grant is widened). Assignment is **per person**, never per GuestInvitation: a party may be
split across tables.

Out of scope, deliberately: plus-ones, `max_guests`, party size, anonymous or placeholder seats, and child/adult
fields. Every seatable person must already be a guest row; the product doesn't model those concepts yet and LB-19
doesn't invent them.

### 2. Tables

```
seating_tables
  id uuid PK, wedding_id uuid NOT NULL → weddings ON DELETE CASCADE,
  name text (1–80 chars, trimmed, no control characters; NOT unique),
  capacity integer (1–50), sort_order integer (> 0; 0 on insert = append, trigger),
  created_by uuid default auth.uid() → auth.users ON DELETE SET NULL (provenance only),
  created_at, updated_at (private.set_updated_at)
  UNIQUE (id, wedding_id); INDEX (wedding_id, sort_order)
```

Read order is `sort_order, created_at, id`. New tables append (the checklist's pattern). There is no reordering UI in
LB-19; `sort_order` is not client-writable.

### 3. Assignments

```
seating_assignments
  guest_id uuid PRIMARY KEY, wedding_id uuid NOT NULL, seating_table_id uuid NOT NULL,
  created_at, updated_at
  FK (guest_id, wedding_id)         → guests (id, wedding_id)         ON DELETE CASCADE
  FK (seating_table_id, wedding_id) → seating_tables (id, wedding_id) ON DELETE CASCADE
  INDEX (seating_table_id)
```

- `guest_id` as the primary key is the **one-table-per-guest** invariant. No row = unassigned. Moving updates the row.
- Both references are **same-wedding composite FKs**: a guest can only sit at a table of its own wedding, for every
  role, including privileged ones. Application checks are not the boundary.
- Deleting a table deletes its assignments (guests untouched). Deleting a guest — or its party, which cascades to
  its guests — deletes the assignment (table untouched). Deleting a wedding removes tables and assignments.

### 4. Capacity is a database invariant

A `BEFORE INSERT OR UPDATE OF seating_table_id, guest_id, wedding_id` trigger
(`private.enforce_seating_assignment`) on `seating_assignments`:

1. skips an UPDATE that keeps the same table and guest;
2. refuses a guest whose current RSVP is `attending = false` (`seating_guest_declined`);
3. locks the destination table row (`SELECT … FOR UPDATE`, scoped to `NEW.wedding_id`); a missing table is left to
   the FK/RLS;
4. counts the destination's assignment rows (excluding `NEW.guest_id`) through `(seating_table_id)`; if
   `count >= capacity`, raises `seating_table_full`.

The row lock **serializes every seat/move into a table**: of two concurrent transactions taking the last seat, the
second waits, re-counts with the first one committed (READ COMMITTED takes a new snapshot per statement), and is
refused. This is tested with two overlapping transactions on separate connections, for inserts and for moves (the
failed mover stays at its original table).

A `BEFORE UPDATE OF capacity` trigger (`private.enforce_seating_table_capacity`) on `seating_tables` refuses a
capacity below the current assignment count (`seating_capacity_below_assigned`). The UPDATE already holds the same
row lock, so it serializes with seats and moves. Nobody is ever unseated silently: equal or higher is allowed.

**Every assignment row counts**: attending, pending, and a guest who declined after being seated. The UI derives free
seats the same way (`capacity − assignment count`), never from confirmed answers.

All refusals are SQLSTATE `23514` with a fixed message, mapped by the service to closed reasons.

### 5. RSVP interaction

- Pending (no RSVP row) guests may be seated; attending guests may be seated.
- Declined guests cannot be **newly seated or moved** (database rule above).
- A guest who declines **after** being seated keeps the assignment. `submit_guest_rsvp` is unchanged; the RSVP never
  depends on seating and never touches it. There is no automatic unseating. The page flags "seated + declined" as a
  conflict ("No asistirá" on the table, a summary warning) and the organizers unseat by hand. A declined guest can
  always be unseated.

### 6. Tenancy and access

- RLS on both tables from their creating migration; policies use `private.is_wedding_member(wedding_id)`. Owners and
  collaborators have the same seating rights (shared planning content, like the checklist and guest list).
- `seating_tables`: SELECT; INSERT (`wedding_id, name, capacity`); UPDATE (`name, capacity`); DELETE.
  `seating_assignments`: SELECT; INSERT (`guest_id, wedding_id, seating_table_id`); UPDATE (`seating_table_id`);
  DELETE. Ids, `sort_order`, `created_by` and timestamps are not client-writable; rows never change wedding or guest.
- anon has no privileges. No anon-executable function (guest RSVP functions, the published website) references
  seating; seating is never public and never reachable with a guest capability.
- The trigger functions are SECURITY INVOKER with `search_path = ''`, fully qualified, and not executable by clients.
  Invoker rights suffice: a member sees every table and assignment of their own wedding — exactly the destination's
  wedding, by the composite FK — so the count is complete, and locking uses the member's own UPDATE privilege. A
  non-member sees no table and is refused by RLS. No service-role module or privileged client is added.
- The application layer (`@/lib/seating/service`) uses the user's RLS-bound client, checks membership first
  (`requireWeddingMembership`), scopes every write to the authorized wedding and maps database errors to a closed set
  (`invalid_input`, `invalid_target`, `table_full`, `capacity_below_assigned`, `guest_declined`, `already_seated`,
  `forbidden`, `not_found`, `unauthenticated`, `database_error`). Raw SQL messages never reach the UI.

### 7. Read model

Two batched queries: the wedding's tables in order, and the guest list with each guest's `rsvps(attending)` and
`seating_assignments(seating_table_id)` nested. No per-table or per-guest queries. The page model (occupancy,
groups by party, conflicts, summary) is derived in memory by the pure `@/lib/seating/plan`.

### 8. No activity events, no checklist relation

Seating changes are not GuestInvitation/RSVP facts: no `wedding_activity` events (ADR-008 is unchanged). No checklist
item is added and `reception.layout` ("Definir la distribución de las mesas") is not linked to the seating page;
navigation between them may come later.

### 9. Future visual compatibility (LB-20+)

A floor plan can add layout data (position, shape, rotation) as new columns on `seating_tables` or a separate
table keyed by `(id, wedding_id)`, and drag and drop maps onto the same seat/move/unseat writes. Individual chairs, if
ever needed, would refine assignments without changing the one-table-per-guest key or the capacity rule.

## Consequences

- Seating is correct under concurrency and across tenants without trusting the application.
- A table can be temporarily "full" of people who declined; that is visible and resolved by hand, by design.
- Plus-ones and children can't be seated until the guest domain models them as guest rows.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| An attendee/person table copied from guests | Duplicates identity; drifts from RSVP; needs backfill. |
| `table_id` on `guests` | Widens guest grants and mixes domains; seating stays separate. |
| Assigning parties instead of people | Parties are often split across tables; RSVP is per person. |
| Application-only capacity checks | Races between concurrent requests overfill tables. |
| Counting only confirmed guests toward capacity | Pending/declined-but-seated people still occupy seats until moved. |
| Auto-unseating on decline | Silent data changes; the RSVP must never depend on seating. |
| SECURITY DEFINER seating RPCs | A second write door; RLS + composite FKs + invoker triggers already enforce scope. |
| Activity events for seating | Not a GuestInvitation/RSVP fact (ADR-008). |
