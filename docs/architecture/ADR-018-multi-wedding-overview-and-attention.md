# ADR-018 — Multi-Wedding Overview Read Model and Derived Attention

Status: Accepted (LB-24B) · Date: 2026-10-11
Related: [Product Constitution §6, §17](../product/PRODUCT-CONSTITUTION.md), [ADR-002 §6](ADR-002-auth-and-security-boundaries.md),
[ADR-009](ADR-009-checklist-guest-work.md), [ADR-012](ADR-012-seating-plan-domain-model.md),
[ADR-014](ADR-014-wedding-vendor-engagement-model.md), [ADR-015](ADR-015-wedding-budget-and-payment-model.md),
[ADR-016](ADR-016-wedding-run-of-show-model.md), [ADR-017 §3, §5](ADR-017-dual-couple-planner-use.md)

## Context

LB-24A (ADR-017) let one account hold any number of wedding memberships and made `/app` ("Mis bodas") the account
level. A planner with many weddings needs to see which ones need attention without opening each. Every domain read
today is one-wedding (`.eq("wedding_id", …)`), and each domain already owns its rules: checklist overdue (LB-08),
RSVP counts (LB-09), seating conflicts (LB-19), vendor totals (LB-21), budget and payment timing (LB-22) and the run of
show (LB-23).

LB-24B builds only the read model and the derived attention, as a library with a tested contract. LB-24C renders it.

## Decision

### 1. Read-only, derived per request

`loadWeddingsOverview(supabase, userId, now)` (`@/lib/weddings/overview/service`, `server-only`) reads and derives on
every call. Nothing is written: no attention table, snapshot, event, cache, notification or schedule. There is no
migration, RLS or grant change. Generated database types are unchanged.

### 2. Authorized weddings come only from memberships

Query 1 is `listMyWeddings` (`wedding_memberships` → `weddings`, the caller's RLS client), which now also projects
`time_zone`. Its ids are the only input to every other read (`.in("id", ids)`). `weddings.created_by`, persona,
`user_metadata`/`app_metadata`, subscriptions, entitlements and organizations are never consulted. RLS
(`private.is_wedding_member`) stays the backstop on every embedded table: a foreign id forced into `.in` returns nothing.

### 3. Fixed, batched queries; no N+1

Six requests, whatever the number of weddings:

1. memberships + wedding core (`listMyWeddings`);
2. checklist: `weddings` → `checklist_items(status, timing_mode, relative_days, due_date)`;
3. guests: `weddings` → `guest_invitations(id, guests(id, rsvps(attending), seating_assignments(seating_table_id)))`;
4. budget and vendors: `weddings` → totals, allocations, `wedding_vendors(id, name, category, custom_category, status,
   currency, contracted_amount_minor, <items>(id, amount_minor, due_on), <payments>(id, amount_minor, paid_on,
   schedule_item_id))`;
5. timeline: `weddings` → `wedding_timeline_entries(id, title, day_offset, start_time, duration_minutes, phase,
   wedding_vendor_id, created_at)`;
6. the exact number of parties of those weddings (`guest_invitations`, `count: "exact"`, `head: true`).

Request 1 runs first; 2–6 run in parallel. Each loader takes the whole id array; the pure builder receives loaded rows
and has no client, so it cannot query. Tests count requests for 1, 10 and 50 weddings (always 6) and assert that every
read is filtered by exactly the authorized ids. The planning target was 5; the sixth exists because of §4.

### 4. PostgREST `max_rows` truncation: measured, then detected

The LB-24B gate measured (local PostgREST v16.4, `max_rows = 1000`, Supabase's default) that the cap applies to
top-level rows **and to every embedded child array, per parent row**: 1,500 embedded checklist items, 1,100 vendors and
1,100 timeline entries each came back as exactly 1,000, silently; arrays under the cap came back whole. Embedding alone
is therefore not safe, and the approved flat fallback (one shared 1,000-row cap across every wedding) would mark most
domains unavailable at ordinary volumes (25 weddings ≈ 2,500 checklist items, 7,500 guests).

Decision: keep the embedded reads, and read an exact count next to every child array that could pass the cap, in the
same statement (`checklist_item_count:checklist_items(count)`, `guest_count:guests(count)`,
`vendor_count:wedding_vendors(count)`, `item_count:…(count)`, `payment_count:…(count)`,
`timeline_entry_count:…(count)`). An array shorter than its count makes that domain `unavailable` for that wedding.
Totals and allocations are bounded by their unique keys and need no count; RSVPs and seat assignments are at most one
per guest.

PostgREST's `(count)` is a whole-row count, which needs table-level SELECT. `guest_invitations` grants columns only (the
token hash is withheld, LB-09), so its count is refused (`42501`). Parties are checked instead against request 6: if the
parties returned for all weddings differ from the exact total, guests is `unavailable` for every wedding of that request.
Both statements read under the caller's RLS; a concurrent party insert or delete between them can only make guests
unavailable for that request, never summarize partial rows.

`tests/db/wedding-overview-max-rows.test.ts` keeps this as a permanent regression: the flat control (1,000 rows, exact
count 1,500), every embedded cap with its exact count, the refused party count, and the service failing closed per
wedding and domain. If a future PostgREST stops capping embeds, the test says so; the counts stay correct either way.

### 5. 100-wedding hard limit

More than 100 authorized weddings → `{status: "over_limit", weddingCount, limit: 100}` after request 1, with no domain
read. Weddings are never sliced or silently dropped. This bounds the top-level rows of requests 2–5 (≤ 100, below
`max_rows`) and the embedded volume. 0 weddings → a `ready`, complete, empty result after request 1 only.

### 6. One request clock; each wedding's own time zone

The library never reads the clock; the caller reads it once and passes `now`. Each wedding's local today is
`weddingLocalToday(time_zone, now)` (never server, browser or UTC time). Without a (known) zone: no checklist overdue,
no payment overdue/due soon, countdown `no_time_zone`, timeline "now" null — the existing domain rules, not guesses.
Without a date: countdown `undated`; relative checklist items have no due date.

### 7. Per-wedding summary

`WeddingOverview` = wedding core (`listMyWeddings` row), `countdown` (`undated | no_time_zone | before n | today |
after n`), and per domain a `DomainResult` (`ok` + value, or `unavailable`):

- checklist: `summarizeProgress`, `overdueCount` (`isOverdue`), `oldestOverdueOn`;
- guests: `summarizeGuests` and `summarizeSeatingGuests` (`confirmed, seated, confirmedUnseated, seatedDeclined`);
- vendors: `summarizeVendors` + `bookedWithoutAmount` (same read as budget);
- budget: `summarizeBudget` projected per currency (total, committed, paid, remaining, unscheduled, overdue, due soon,
  total variance) + `overdueCount, dueSoonCount, unbookedPaidVendorCount, timingUnavailable, isEmpty`;
- timeline: `timelineOverview` → `entryCount, timedCount, untimedCount, now {time, current, next} | null`;
- `attention`, `attentionLevel` (the highest present, or null), `unavailableDomains`.

Every number comes from the existing domain helper; the overview only projects. Seven behavior-preserving widenings
let those helpers take the overview's minimal rows: `isOverdue` (status + timing), `summarizeVendors`, budget facts
without `label`/`note` (defaulted generics), the extracted `summarizeSeatingGuests`, `TimelineSlot`, `listMyWeddings`'
`timeZone`, and `daysBetweenIsoDates`.

### 8. Attention taxonomy (closed)

| kind | trigger (existing rule) | level | destination |
|---|---|---|---|
| `payment_overdue` | `summarizeBudget.overdue` non-empty | overdue | budget |
| `checklist_overdue` | `isOverdue` count > 0 | overdue | checklist `?view=plan` |
| `payment_due_soon` | `summarizeBudget.dueSoon` (LB-22's 14 days, today included) | due_soon | budget |
| `seated_declined` | `seatedDeclined > 0` | review | seating |
| `payment_to_unbooked_vendor` | `summarizeBudget.attention` non-empty | review | budget |
| `budget_total_over` | `totalVariance.kind === "over"` in any currency | review | budget |
| `wedding_date_missing` | `wedding_date` null | setup | settings (owner) / wedding home (collaborator) |
| `wedding_time_zone_missing` | `time_zone` null | setup | same |

Levels are labels with fixed meanings, not severities: `overdue` (a domain date passed), `due_soon` (the domain's own
window), `review` (a contradiction the domain already flags), `setup` (missing wedding facts). Not attention (summary
only, or not loaded): pending RSVPs (no deadline exists), checklist due soon (no such concept), unseated attending
guests, booked vendors without an amount, category overruns, timeline gaps, site and activity state. A zone that is
set but unknown to the runtime is not `wedding_time_zone_missing` (the trigger is exactly `time_zone` null).

A domain that is `unavailable` derives none of its kinds; the two setup kinds come from request 1.

### 9. Items, ids, order

`AttentionItem = {id, weddingId, kind, level, count, amounts, since, destination}`; one item per wedding and kind.
`id = ${weddingId}:${kind}` (derived, never persisted, never random). `amounts` are per-currency buckets, CRC then USD,
never summed across currencies or converted; `count` counts the kind's records. `since` is the oldest overdue / earliest
due-soon date. `attentionPath(weddingId, destination, role)` builds only existing routes.

Global order, key by key: `LEVEL_RANK` (overdue, due_soon, review, setup); wedding proximity (today/upcoming by days,
then past by days, then dated without zone by date, then undated); `KIND_RANK` (table order); `since` ascending, nulls
last; wedding name (`Intl.Collator("es", {sensitivity: "base"})`); wedding id. `(weddingId, kind)` is unique, so no tie
survives. Weddings stay in `listMyWeddings` order.

### 10. Explicit partial / error semantics

`WeddingsOverview` is `error` (request 1 failed), `over_limit`, or `ready` with `weddings`, global `attention`,
`weddingsNeedingAttention`, `unavailableDomains` (union, fixed order), `complete` (no domain unavailable anywhere) and
`allClear = complete && attention.length === 0`. A failed or thrown read, a wedding missing from a response, a
truncated array or a drifted row (the timeline page's own rule) is `unavailable` — never `[]`, never zero. There is no
retry beyond the client's own.

### 11. No score

There is no score, health, readiness, percent-ready or risk number. The domains measure different things; one number
would hide which one needs work. The type contract has no field for it (an exact-keys test guards this).

### 12. LB-24C contract

LB-24C calls `loadWeddingsOverview` once per request (after `decideWeddingEntry` decides `list`), renders, formats money
on the server (`formatMoney`) before anything reaches a client component, adds the catalog copy and deep-links with
`attentionPath`. It may choose display caps. It never recomputes a summary, a trigger, a level or the order.

## Consequences

- Measured locally (WSL Docker, 50 weddings × 100 checklist items, 300 guests, 15 vendors with 5 items and 5
  payments, 50 timeline entries; 25 weddings for a colleague): always 6 requests, complete, about 0.85–1.6 s end-to-end
  for 25 weddings and 1.4–2.3 s for 50. The guests read dominates (≈ 0.8 s SQL without the counts, ≈ 1.0 s with them:
  the per-row RLS membership check, as planned). No index is missing; no migration.
- Known latent issue, out of scope: single-wedding pages that read more than 1,000 rows of one kind (top-level or
  embedded) still truncate silently today.
- Collaborators' setup items point to the wedding home; they cannot fix the date or zone themselves.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Persisted attention / alerts table | A second source of truth that drifts; nothing needs it. |
| A global readiness score | Mixes incomparable domains; hides what needs work. |
| Service role or SECURITY DEFINER overview | Bypasses the membership boundary (ADR-002 §6, ADR-017 §3). |
| One query per wedding | N+1; 5N requests at 50 weddings. |
| Trusting embedded arrays | Measured: silently capped at 1,000 per parent. |
| Flat reads + `count: "exact"`, fail closed | One cap shared by all weddings: unavailable at ordinary volumes. |
| Flat reads paged with `.range()` | Request count grows with row volume. |
| Raising `max_rows` | A project-wide setting; still needs detection. |
| Pending RSVPs / checklist due soon as attention | No deadline or window exists in those domains. |
