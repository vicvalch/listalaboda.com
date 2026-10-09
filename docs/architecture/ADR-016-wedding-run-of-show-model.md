# ADR-016 — Wedding Run of Show (Cronograma) Model

Status: Accepted (LB-23) · Date: 2026-10-09
Related: [Product Constitution §8 Phase 3, §9, §10](../product/PRODUCT-CONSTITUTION.md), [ADR-001 §2, §7](ADR-001-product-domain-and-tenancy.md), [ADR-002 §3, §4, §6](ADR-002-auth-and-security-boundaries.md), [ADR-008](ADR-008-basic-activity-history.md), [ADR-014 §11](ADR-014-wedding-vendor-engagement-model.md), [ADR-015](ADR-015-wedding-budget-and-payment-model.md)

## Context

Phase 3 is "running the wedding". The checklist template already asks couples to "Armar el cronograma del día" ("desde
la preparación hasta el cierre de la fiesta") and to "Repasar el cronograma con quienes ayudan", but the product had
nowhere to keep that schedule. ADR-014 §11 recorded that LB-23 timeline entries would reference a vendor with
`ON DELETE SET NULL (wedding_vendor_id)` so the timeline survives a vendor's deletion. LB-23 adds the run of show: what
happens on the wedding day, when, where, how long, who is responsible and which vendor is involved — operational data for
the organizers, not a decorative itinerary and not a calendar.

## Decision

### 1. Domain boundary and naming

One entity, `public.wedding_timeline_entries` (code: `@/lib/timeline`; UI: **"Cronograma"**, the checklist's own word).
"Programa" stays the public site's free-text section and "programar" the budget's verb; "schedule" names payment
obligations in the database.

| Concept | Is | Lives in |
|---|---|---|
| Run of show entry | A scheduled operational activity of the wedding day | `wedding_timeline_entries` (this ADR) |
| Checklist item | Work to finish before the wedding | `checklist_items` (LB-05) |
| Payment deadline | A financial obligation | `vendor_payment_schedule_items` (ADR-015) |
| Calendar event | A general personal event | not modeled |
| Activity | An immutable record of what happened | `wedding_activity` (ADR-008) |

A timeline entry is a mutable plan. It never completes, creates or links checklist items, payments, seating or activity.

### 2. Scope: the wedding day and its continuation after midnight

`day_offset smallint` is exactly `0` (the wedding day) or `1` (the next calendar day: last call, teardown after
midnight). Rehearsal dinners, next-day brunches and other days are out of scope: no arbitrary dates exist, so the table
can't become a calendar. Widening later (e.g. `-1..2` for a rehearsal or a brunch) is a CHECK change and new labels, with
no data rewrite.

### 3. Storage: wedding-relative day + local wall-clock time

- `start_time time` — local wall-clock time in whole minutes (CHECK: no seconds or fractions, strictly before `24:00`,
  which Postgres's `time` would otherwise accept). Null = "Sin hora" (not decided yet).
- `duration_minutes smallint` — optional, 1–1440. Null = a moment, or a length not known yet. It may exist without a
  start time ("45 min · hora por confirmar").
- **No end column.** The end is derived (start + duration), so there are never two authorities.
- No `timestamptz`, no calendar `date`, no local timestamp. The calendar day of an entry is derived from the CURRENT
  `weddings.wedding_date` + `day_offset`, the same "store the rule, derive the date" convention as checklist timing
  (LB-06).

Consequences:

- Entries work without a wedding date (headers "Día de la boda" / "Día siguiente · después de medianoche").
- Changing the wedding date moves the interpreted timeline; **no row is rewritten** (nothing is shifted, prompted or
  blocked).
- Display never goes through a JavaScript `Date`: times are text ("15:30") and minutes, so no process, browser or wedding
  zone can shift them. Calendar dates are formatted in UTC from `YYYY-MM-DD`, like `formatWeddingDate`.
- A future ICS export is `timezone(weddings.time_zone, (wedding_date + day_offset) + start_time)`, the same expression
  ADR-010 uses for reminder due times.

### 4. The timeline window (approved invariant)

A timed entry with a duration must end within the window: minute 0 of the wedding day through minute 2880 (midnight at
the end of day 1):

    day_offset × 1440 + start minutes + duration_minutes ≤ 2880

Enforced by the CHECK `wedding_timeline_entries_end_within_window` (plain `extract(hour/minute)` arithmetic, never
wrapping `time + interval`) and mirrored by the form validation ("La actividad terminaría después de la medianoche del
día siguiente…"). It is refused, never clipped. Without a start time it isn't evaluated. Day 0 entries may cross
midnight (23:45 + 60 → day 1 00:45); a day-1 span may end exactly at 2880 (shown as "24:00").

### 5. Midnight is explicit

The organizer chooses the day ("Día de la boda" / "Día siguiente · después de medianoche", with helper text). "00:30"
is never moved to the next day by guessing; on day 0 it simply sorts first, where it is visible.

### 6. Time zone authority

`weddings.time_zone` (IANA) is the only zone. Entries never snapshot a zone and have no zone of their own. It only
interprets "now" (current/next, §11) and a future export; the displayed schedule never changes with it. A wedding without
a zone keeps full create/edit/order/display; only "Ahora / Siguiente" is hidden, with a hint to set the zone. The app
never infers a zone.

DST: wall-clock data stays exactly as entered; ambiguous or nonexistent local times are never rejected. "Now" is the
wedding-local wall clock (`weddingLocalNow`, Intl with the IANA rules), compared to wall-clock spans: during a fall-back
hour, 01:xx entries are current twice, which is what the clock at the venue shows. Durations are wall-clock minutes.

### 7. Ordering

Canonical order: `day_offset`, timed before untimed, `start_time`, `created_at`, `id`. The query orders that way and
the pure sorter (`compareTimelineEntries`) is the authority. Simultaneous entries keep creation order. Untimed entries
render in a separate "Sin hora" section after the timed days (by day, then creation), never mixed into the chronology.

There is **no `sort_order`**, drag and drop or move up/down: chronology comes from times. Manual tie ordering, if ever
needed, is an additive column backfilled from `row_number() over (created_at, id)`.

Simultaneous and overlapping entries are valid: no uniqueness over time, no overlap constraint, no warnings; a vendor
or a place may have two things at once.

### 8. Phase, location, responsible, notes

- `phase` — nullable closed enum `wedding_timeline_phase`: `getting_ready` Preparación, `setup` Montaje, `ceremony`
  Ceremonia, `photos` Fotos, `cocktail` Cóctel, `reception` Recepción, `closing` Cierre. Presentation only (a text
  badge): no grouping, filtering, ordering or authority; no `other` and no custom phase.
- `location` — optional free text, 1–120, trimmed, no control characters. No venue entity, maps or geocoding.
- `responsible_name` — optional free text, 1–120. Day-of responsibles (maid of honor, venue coordinator) usually aren't
  app members; member assignment stays a checklist concept. No member, guest or polymorphic participant links.
- `notes` — optional plain text, ≤ 4000, multiline (`\n`, `\r`, `\t` only); rendered with `whitespace-pre-line`, never
  Markdown/HTML. Instructions, access details and contingency notes live here.
- No dependencies, priorities or key-moment flags.

### 9. Vendor: zero or one, same wedding, column-list SET NULL

`wedding_vendor_id uuid` with the composite FK `(wedding_vendor_id, wedding_id) → wedding_vendors (id, wedding_id)
ON DELETE SET NULL (wedding_vendor_id)` (PostgreSQL 15+; production runs 17), exactly as ADR-014 §11 recorded:

- A vendor of another wedding, an unknown id and a deleted one are relationally impossible for every role
  (`invalid_vendor` in the service, indistinguishably).
- Deleting the vendor nulls only that column: the entry, its `wedding_id`, title, time and notes survive.
- LB-22's `NO ACTION` finance FKs are unaffected: a vendor with schedule items or payments still can't be deleted.
- Deleting a wedding cascades both the vendors and the entries.

One vendor per entry. When several are involved ("Primer baile": DJ, photo, video) organizers pick the operationally
primary one and mention the others in the notes. A many-to-many junction is deferred: it would need an atomic
entry + links write (an RPC) for a need not yet validated, and it can be added later by moving the column into junction
rows.

A linked vendor that becomes "Descartado" stays linked, with a textual "Proveedor descartado" warning; nothing is
unlinked automatically.

### 10. Vendor projection

The timeline reads only `id, name, category, custom_category, status, contact_name, phone` of a linked vendor (and only
`id, name, category, custom_category, status` for the picker). Never email, Instagram, notes, currency, quoted or
contracted amounts, schedule items or payments. Members can read all vendor columns elsewhere; the timeline's select list
and its mapping (`toTimelineVendor`) are the guard, and tests pin both. The phone renders as a `tel:` link; no `mailto:`,
WhatsApp or messaging.

### 11. No execution status; current/next is derived

No `status`, `completed`, `delayed`, `started_at` or similar column. LB-23 plans the day; a live execution mode is not
designed yet, and stored state would bring transitions, concurrency and delay semantics. Adding status later is an
additive column.

"Ahora / Siguiente" is derived on the server from one clock read per request, shown only when the wedding has a date
and a zone and the wedding-local calendar day is the wedding day or the day after (never "next" months ahead):

- `currentEntries[]` — every timed entry WITH a duration whose span contains now (start inclusive, end exclusive);
  overlaps give several. A day-0 span crossing midnight is current on day 1.
- `nextEntries[]` — every timed entry sharing the earliest start after now (moments included).
- Untimed entries are neither; moments are never current. Nothing is "late": past is just past. No auto-refresh, polling
  or realtime: the panel says it reflects the time the page loaded.

No delay propagation: changing one entry never moves another.

### 12. Access, read model and exposure

PRIVATE organizer data. Owners and collaborators have identical CRUD rights through member RLS
(`private.is_wedding_member`, four policies). Column grants: INSERT `wedding_id, title, day_offset, start_time,
duration_minutes, phase, location, responsible_name, wedding_vendor_id, notes`; UPDATE the same minus `wedding_id`;
SELECT; DELETE. Never `id`, `created_by` (provenance only, `auth.uid()`, `ON DELETE SET NULL`) or timestamps. anon has
nothing. No SECURITY DEFINER function, RPC, service role, public view, RSVP or site projection; no vendor access.

Writes go through `@/lib/timeline/service` (membership first, scoped by `(id, wedding_id)`, re-validated, closed
reasons `unauthenticated | not_found | forbidden | invalid_input | invalid_target | invalid_vendor | database_error`).
The page reads in TWO queries whatever the size (the wedding with its vendors embedded for the picker; the entries with
the vendor projection embedded); everything else is derived in `@/lib/timeline/summary` (pure, no clock).

Hard delete; no history, activity events (ADR-008 unchanged) or audit trail.

### 13. Print

Basic browser printing ("Imprimir" → `window.print()`): the app chrome, forms, actions and the now panel are hidden;
the wedding name and date, day headers, times, titles, locations, vendors and responsibles print, notes print in full,
rows avoid page breaks, and the palette is light on paper. No PDF, CSV or export service.

## Future (recorded, not built)

- **Public itinerary**: a separate, explicit publication (its own projection or an opt-in per entry behind a narrow
  reader); never by exposing this table. The site's "Programa" section stays free text until then.
- **Multi-day**: widen the `day_offset` CHECK and the labels.
- **Multiple vendors**: a same-wedding junction table, `ON DELETE CASCADE` on the link, with an atomic write path.
- **Templates / "Duplicar cronograma"**: copy rows (relative day + wall-clock time make them portable) without live
  links; vendor links are dropped or remapped on copy.
- **Realtime, offline, notifications, execution status, key moments, manual tie order**: additive; nothing here needs a
  rewrite for them.
- **LB-24 dashboard**: `timelineOverview(entries, { weddingDate, timeZone, now })` already returns counts, first/last
  start, distinct vendor ids, phase counts and current/next.

## Consequences

- One small private table; the schedule follows the wedding date with zero writes.
- Midnight and the window are explicit in data and UI; a schedule can't silently spill into a third day.
- Multi-vendor moments rely on notes until a junction is justified.

## Rejected alternatives

- **`timestamptz` start/end**: shifts with the zone, needs a zone and orphans entries when the date moves.
- **Calendar `date` + `time`**: orphans entries on a date change and needs a parent-date trigger to bound them.
- **Stored end time or both end and duration**: two authorities.
- **Execution status / delay propagation**: premature without a designed live mode.
- **Member, guest or polymorphic responsibles**: most day-of responsibles aren't members or guests.
- **Junction table now**: non-atomic writes without an RPC for an unvalidated need.
- **`sort_order` / drag and drop**: chronology already orders the day.
