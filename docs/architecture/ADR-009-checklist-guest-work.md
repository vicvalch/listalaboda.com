# ADR-009 — Checklist ↔ guest work

Status: Accepted (LB-16) · Date: 2026-10-05
Related: [Product Constitution §4, §8, §14](../product/PRODUCT-CONSTITUTION.md), [ADR-001 §2, §5, §7](ADR-001-product-domain-and-tenancy.md), [ADR-002 §3, §4, §8](ADR-002-auth-and-security-boundaries.md), [ADR-008](ADR-008-basic-activity-history.md)

## Context

The checklist is the product, and every other module exists to help complete items on the list (Constitution §4,
§14.1). Phase 2 built the guest modules (parties, guests, RSVP, emails, recoverable links, reminders, history), but
a checklist item like "Confirmar el transporte de la familia Pérez" had no way to point at that party, and the
party card had no way to show the planning work about it. Organizers jumped between two pages by memory.

The authoritative documents already decide the shape:

- Constitution §4 lists, among a ChecklistItem's conceptual fields, "(links to other modules) — Phase 2+, as
  explicit nullable FKs, not text-typed polymorphic pairs".
- Constitution §8 (Phase 2): "Checklist items may link to guest-related work (explicit FKs)."
- ADR-001 §2: "Links from checklist items to other modules use **explicit nullable FKs**, not text-typed
  polymorphic `(linked_entity_type, linked_entity_id)` pairs, so that referential integrity and RLS both hold",
  and cross-entity references "must stay within the same wedding (composite FKs `(wedding_id, id)`)". Its
  rejected alternatives include "Polymorphic text links from checklist items".
- ADR-001 §7 / Constitution §6: the guest domain's first-class, organizer-facing unit is the **GuestInvitation**
  (household/party); Guests and RSVPs hang off it.

So "guest-related work" means a checklist item that is *about* guest-list work, linked by an explicit FK to the
existing guest entity. Neither document defines a separate "GuestWork" entity, a wedding-level guest target, or
automation.

## Decision

### 1. Model: one nullable FK on the item

```
checklist_items.guest_invitation_id uuid null
  FOREIGN KEY (guest_invitation_id, wedding_id)
    REFERENCES guest_invitations (id, wedding_id)
    ON DELETE SET NULL (guest_invitation_id)
```

- **Target = GuestInvitation (party).** It is the unit organizers manage, the card on "Invitados", and the only
  guest entity with a stable organizer-facing identity. A Guest is a row inside a party; an RSVP is the guest's own
  answer, never organizer work.
- **Null = no guest work.** No sentinel rows, no magic ids. Most items stay unlinked and look exactly as before.
- No new table, no `GuestWork` entity, no `entity_type`/`entity_id`, no JSON, no stored URL/route/href.

### 2. Cardinality: an item → zero or one party; a party ← many items

The checklist item owns the relationship (it is the item's context, like its assignee), so the column lives on
`checklist_items`. One column makes "linked to two parties at once" unrepresentable: changing the party is a
single-column `UPDATE`, atomic, with no transient state and no duplicate rows. A party can be the subject of
several items ("Confirmar transporte", "Reservar hotel"), which needs nothing extra.

Many-to-many (an item about several parties) was not chosen: no current workflow needs it (an item about the
whole guest list is simply unlinked, or links to the guests page in its description), and a join table would be
a speculative generalization. It can be added later, additively, if real use demands it.

### 3. Tenant enforcement in the database

The composite FK references `(party id, THIS ITEM'S wedding id)`. A party of another wedding — or an id that
doesn't exist — is not a valid reference for any role, including privileged writes. Rows never move between
weddings (`wedding_id` stays non-updatable), so the pair can't drift. The service additionally scopes the update
to (authorized wedding, item id); that is defense in depth, not the guarantee.

A forged cross-wedding link gets the same `23503` as an unknown id, so the failure says nothing about whether the
other wedding's party exists; the app maps both to the same "that group is no longer on the list" message.

### 4. Permissions: exactly checklist editing

Owners and collaborators both edit checklist content (Constitution §3), so both may link, change or remove the
party: `GRANT UPDATE (guest_invitation_id)` to `authenticated`, scoped by the existing
`checklist_items_update_member` RLS policy, after the service's `requireWeddingMembership`. No new role, RPC or
policy. Non-members (other weddings' members, outsiders) are denied by RLS (zero rows → `item_not_found`, or 404
at the page). `anon` has no privileges on `checklist_items`, and a guest's token functions never read the
checklist (Constitution §3: "No checklist").

A plain column grant is enough because the FK carries the same-wedding rule. A narrow RPC would add a second
write door without adding a guarantee (the LB-07 assignee follows the same shape).

### 5. The link grants nothing

The relation is navigation and context, never a capability. Seeing a linked party's label still requires
`SELECT` on `guest_invitations` (members only); following "Ver grupo" lands on the member-only "Invitados" page,
which re-checks membership. Being linked doesn't let anyone rotate, revoke, email or read anything new, and
guest-link permissions (owner-only rotate/revoke) are unchanged.

### 6. No copied guest data, no capability material

The checklist stores only the party id. Never copied or returned through the checklist: the party label (read
current at render time), guest names, contact email, RSVP answers, dietary notes, email metadata, tokens,
`token_hash`, envelopes, or RSVP URLs. The checklist page loads party options as `id, label` only. The guest page
loads each party's related items as `id, title, status` only.

### 7. Status and guest-state independence

Linking, changing or unlinking writes only `guest_invitation_id`. The completion trigger keeps `completed_at` /
`completed_by` when the status doesn't change, so a `done` item stays `done` with its stamps. Nothing completes,
reopens, creates or deletes items from guest events (RSVPs, emails, reminders, every guest answering): checklist
status remains the organizer's manual decision. Guest-side functions don't read the column at all.

### 8. Deletion

| Deleted | Effect |
|---|---|
| Checklist item | The relation goes with the row. Party, guests, RSVPs, link, emails and activity are untouched. |
| Party (GuestInvitation) | `ON DELETE SET NULL (guest_invitation_id)`: the item stays, with its status, content and wedding; it just shows as unlinked. No retargeting, no new party. |
| Wedding | Items and parties cascade with their tenant, as before. |

### 9. Navigation (derived, never stored)

- Checklist → party: `/app/weddings/<weddingId>/guests#party-<partyId>`. The party card got a stable DOM id.
- Party → item: `/app/weddings/<weddingId>#item-<itemId>`, the row's existing DOM id. The bare checklist URL is the
  default "list / todos" view, so every item is rendered there.
- Built by `@/lib/checklist/guest-work` from ids and app constants only; no user-controlled href, no query
  string state, no tokens.
- A link whose party is gone (deleted between reads) renders as unlinked: no broken link.

### 10. UX

- Checklist row, linked: "Relacionado con: <current label>" with "Ver grupo"; under "Cambiar vínculo", a select of
  the wedding's parties (labels only) and an explicit "Guardar", plus "Quitar vínculo". Unlinked:
  "Vincular con invitados", with a pointer to "Invitados" when there are no parties yet. Never a warning.
- Party card: "Pendientes relacionados" (wedding language, Constitution §14.2 — not "tareas") lists each linked
  item's title and status, linking back to it. No edit controls are duplicated there.

### 11. Reads stay batched

The checklist page adds one bounded query (`id, label` of the wedding's parties), run in parallel with the existing
reads. The guest page reads related items inside its existing single nested select
(`guest_invitations → checklist_items(id, title, status, sort_order, created_at)`), never per party. Index
`(guest_invitation_id, wedding_id) where guest_invitation_id is not null` serves both that embed and the party
FK's `SET NULL`.

### 12. Activity history: not extended

ADR-008 records durable GuestInvitation/RSVP facts. Linking an item is checklist planning metadata, like
assignment (which isn't recorded either); viewing or following a link is not a fact at all. The event taxonomy is
unchanged.

### 13. Still deferred

Automatic or scheduled reminders, cron, queues, jobs, reminder policy, dedupe or locks; auto-created checklist
items; status automation from guest events; links to other modules (vendors, budget: Phase 3, each its own
explicit FK).

## Consequences

- Organizers move between an item and the party it concerns in one click, both ways.
- One nullable column, one FK, one partial index and one column grant; no new function, policy or table.
- A deleted party silently unlinks its items; the items' history of having been linked is not kept.
- An item can't be about two parties at once; that's a deliberate limit until real use says otherwise.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Polymorphic `(linked_entity_type, linked_entity_id)` | Forbidden by ADR-001 §2: no FK integrity, easy cross-wedding leakage. |
| Stored `href`/`url`/`route` text | Arbitrary, unvalidated targets; routes are derived from typed ids. |
| JSON metadata column | Untyped, invites PII/capability copies; nothing needs it. |
| A `GuestWork` entity or `checklist_item_guest_invitations` join table | Speculative; no current workflow needs many parties per item. |
| A wedding-level "guest work" flag/target | Not defined by the documents; an unlinked item already covers general guest-list work. |
| Linking to a Guest or RSVP | Not the organizer's unit of work; RSVPs belong to the guest. |
| `ON DELETE CASCADE` from the party | Deleting a party would silently delete planning work. |
| A SECURITY DEFINER `set_checklist_guest_work_link` RPC | Adds a second write door; the composite FK + RLS already guarantee scope. |
| Auto-completing items from RSVP/email/reminder events | Status is the organizer's decision; guest state and checklist state stay separate. |
| Activity events for link/unlink | Not a GuestInvitation/RSVP fact (ADR-008 §3). |
