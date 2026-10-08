# ADR-013 — Visual Seating Planner Layout Model

Status: Accepted (LB-20) · Date: 2026-10-07
Related: [ADR-012](ADR-012-seating-plan-domain-model.md), [ADR-001 §2, §6](ADR-001-product-domain-and-tenancy.md), [ADR-002 §3, §4](ADR-002-auth-and-security-boundaries.md), [ADR-008](ADR-008-basic-activity-history.md)

## Context

LB-19 (ADR-012) shipped the seating domain: tables, capacity enforced by the database under a table row lock, and
one-table-per-guest assignments, managed through plain forms. Couples plan a reception spatially, though, and asked to
see the room: where each table is and who sits there, and to move people by dragging.

LB-20 adds a visual planner. It must not become a second seating domain, weaken any LB-19 invariant, or commit the
product to a venue/floor-plan model that doesn't exist yet.

## Decision

### 1. LB-19 stays the authoritative seating domain

The planner is a **progressive enhancement** of the "Mesas" page. Who sits where, capacity, declined guests and
concurrency are exactly ADR-012: the same tables, the same `seating_assignments`, the same triggers. Every guest drop
calls an existing LB-19 Server Action — rail → table `seatGuestAction`, table → table `moveGuestAction`, table → rail
`unseatGuestAction` — so there is no second assignment path, API or RPC. The server and the database decide; the
client only avoids requests that are known to fail.

### 2. Layout lives on `seating_tables`

```
seating_tables
  + shape    seating_table_shape NOT NULL DEFAULT 'round'   -- enum: round | rectangle
  + layout_x integer NULL                                   -- table CENTER, logical units
  + layout_y integer NULL
  CHECK ((layout_x IS NULL) = (layout_y IS NULL))           -- placed, or not
  CHECK (each non-null coordinate BETWEEN 0 AND 10000)
```

- No separate layout table and no general floor-plan entity: LB-20 has exactly **one board per Wedding**, and a
  position is a property of a table like its name. A future multi-space model can move it (§10).
- **Null coordinates mean "not placed yet."** The planner derives a deterministic slot; opening the planner never
  writes. The first drag of a table persists its position.
- The database range (0–10000) is deliberately **loose**: the board width and grid are presentation choices (§3), not
  domain invariants, and are not enforced there. Coordinates are plain integers; no style strings, sizes or JSON are
  stored.
- **Shape is visual only**: round or rectangle (always horizontal). It never changes capacity, assignments, position or
  order. There is no rotation, width/height or resize; the drawn size derives from shape + capacity.
- **No layout triggers.** The capacity trigger (`BEFORE UPDATE OF capacity`) and the `sort_order` trigger are
  unchanged; a layout or shape write only bumps `updated_at`.

### 3. Logical coordinate system

- The board is a fixed **1200 logical units** wide and grows vertically: its height is
  `max(800, lowest table bottom + margin)`, derived in memory and never stored.
- `x`/`y` are the table's **center**. The board renders scaled to the available width,
  `scale = renderedBoardWidth / 1200`; a drag's screen-pixel delta becomes logical units by **dividing by the scale**
  (200 px at scale 0.5 = 400 units). This conversion is the critical invariant and is unit-tested.
- On drop, the new center **snaps to a 20-unit grid** and is **clamped** so the table and its chairs stay on the board
  (grid-aligned bounds). Movement during the drag is continuous; only the snapped end position is saved.
- No zoom and no pan in LB-20.
- **Derived placement** for unplaced tables is pure and deterministic (`@/lib/seating/planner`): tables in their
  persisted `sort_order`, ~6 slots per row, 200 units apart; the k-th table starts at slot k (so placing one table
  never reflows the others) and skips slots whose footprint would overlap an already-placed table. Stored positions
  win.
- **Overlap is allowed** for manual placement; there are no collision rules in the database or the client.

### 4. Seats and chairs

There are **no persisted seats**: no seat/chair table, seat index or seat coordinates. Chair markers are generated
from capacity (round: evenly around the circumference, the first at the top; rectangle: ⌈N/2⌉ on top and ⌊N/2⌋ on
the bottom) and are **decorative only**: never ids, never tied to a guest. Guest assignment stays table-level.

### 5. Writes, timing and concurrency

- A table position is written by `positionSeatingTable` (`@/lib/seating/service`) through the user's RLS-bound
  client: membership first, UUID and integer/range validation, an update of **only** `layout_x`/`layout_y` scoped to
  `(id, wedding_id)`, closed failure reasons. It is called by one Server Action, `positionTableAction`.
- Exactly **one write per completed table drag**, on drop; never during pointer moves. The UI applies it
  optimistically (`useOptimistic`); on failure it returns to the last server position and says "No se pudo guardar
  la posición." There is no "unsaved layout" state.
- Concurrent position edits are **last-write-wins**: no version column, conflict dialog, realtime or extra locks.
  Collaboration stays refresh/revalidation based (no Supabase Realtime).
- Guest moves are optimistic too and revert to the server state on any failure. Capacity races are still decided by
  the LB-19 table row lock: if a collaborator took the last seat first, the drop is refused (`table_full`), the guest
  goes back, "Mesa llena" is shown and the page data refreshes. Capacity is never decided or changed by the client.
- Known-full tables and declined guests are refused before any request (a declined guest who is seated may only go
  back to "Sin mesa"); pending guests are seatable and count against capacity.

### 6. Access

The existing member RLS policies cover the new columns. Column grants widen narrowly: `INSERT (shape)`;
`UPDATE (shape, layout_x, layout_y)`. `wedding_id`, `sort_order`, `created_by`, ids and timestamps remain
non-writable, and new tables can't be inserted with coordinates. anon has no privileges; no anon-executable
function, the RSVP page or the published website exposes layout. No service role or RPC is added.

### 7. Presentation

- Route: the same `/app/weddings/[weddingId]/seating`; **list is the default**, `?view=plan` opens the planner.
  `view` is presentation, never a boundary: both views run the same membership check and load the same data (two
  batched queries; ADR-012 §7).
- **Desktop only** (`lg`, ≥ 1024 px). Below it the LB-19 list is the full operational fallback, the "Plano" toggle is
  not shown, and a direct `?view=plan` shows a short notice with a link back to the list; the planner's DOM is not
  rendered there. The planner breaks out of the shell's `max-w-4xl` to about `max-w-7xl` with page-local, fixed
  negative margins (never `100vw`, which counts the scrollbar); the `/app` shell is unchanged.
- Layout: a "Sin mesa" rail (Confirmados, Sin responder, collapsible "No asistirán"), the board, and an inspector.

### 8. Drag and drop and accessibility

- `@dnd-kit/core` (exact 6.3.1; not `@dnd-kit/react`, no sortable) with one `DndContext`: a pointer sensor with a
  small activation distance (a click selects) and a keyboard sensor. Drag data carries an explicit kind
  (`table` / `guest`), never inferred from DOM ids.
- A table moves only by its dedicated, labelled handle ("Mover Mesa 1"); dragging a guest never moves a table. With
  the keyboard, Space picks up, arrows move one 20-unit step, Space drops, Escape cancels; a guest jumps between drop
  targets with the arrows.
- **The primary accessibility guarantee is the non-drag path**: the inspector reuses the LB-19 forms (name, capacity,
  shape, delete; seat / move / unseat), so every assignment works without dragging. One live region announces picks,
  results and refusals in Spanish (dnd-kit's own announcer is silenced). A full table's state is in its accessible
  name ("…, llena") and announced while dragging, not `aria-disabled` on the group (that would disable the controls
  inside it for assistive technology).

### 9. Out of scope

No activity events (ADR-008 unchanged) and no checklist link. No persisted seats, rotation, resize, zoom, pan,
rooms, venue map, background images, walls/doors/stage/dance floor, multiple spaces, realtime, auto seating or
print/PDF.

### 10. Future compatibility

A later floor-plan model (e.g. `seating_spaces`, layers or venue elements) can introduce a space id and move the
center coordinates into a placement keyed by `(table, space)`, migrating today's `layout_x/layout_y` as the default
space. Persisted seats, if ever needed, would refine assignments without changing ADR-012's one-table-per-guest key
or capacity rule.

## Consequences

- The planner adds no new authority: everything it writes was already writable by members, plus three narrow,
  validated presentation columns.
- Two collaborators moving the same table end with the last drop; there is no merge.
- The board is a fixed-ratio canvas; very small screens use the list.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| A separate layout table | One board per Wedding; a position is a table property. Adds a join and a second write path for no gain yet. |
| A general floor-plan/venue entity now | No product decision on rooms or venues; it would freeze an unvalidated model. |
| Persisted seats/chairs | Seating is table-level (ADR-012); chairs would need their own invariants and UI. |
| Pixel coordinates or a percentage model | Pixels depend on the screen; a logical board is stable across devices and scales. |
| Board width/grid enforced in the database | Presentation choices that may change; a loose range keeps the data valid without coupling. |
| Writing on every pointer move | Network chatter and partial states; one write on drop is enough. |
| Version column / conflict dialog for positions | Low-stakes data; last-write-wins is acceptable and simple. |
| Supabase Realtime | Not needed for LB-20; revalidation keeps the source of truth on the server. |
| A planner-specific assignment RPC | Would duplicate LB-19's write path; drops reuse its actions. |
| `@dnd-kit/react` | Newer API surface; `@dnd-kit/core` 6.x is mature and sufficient. |
