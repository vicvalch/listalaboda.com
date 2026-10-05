-- LB-16: checklist ↔ guest work (Constitution §4 "(links to other modules) —
-- Phase 2+, as explicit nullable FKs, not text-typed polymorphic pairs", §8
-- Phase 2 "Checklist items may link to guest-related work (explicit FKs)";
-- ADR-001 §2; ADR-009).
--
-- One addition: checklist_items.guest_invitation_id — zero or one guest
-- party (GuestInvitation) of the SAME wedding that the item is about, e.g.
-- "Confirmar transporte de la familia Pérez". It is navigation and context
-- only:
--   * it grants nothing: reading or managing the party still needs wedding
--     membership (guest_invitations RLS), and the guest's token never sees
--     the checklist;
--   * it never changes the item's status, timing, order or assignee, and
--     never touches the party, its guests, RSVPs, link or emails;
--   * nothing is copied: no party label, guest names, contact email, RSVP
--     answers, link, hash or URL. The app reads the party's CURRENT label
--     at render time and derives every route from the two ids.
-- No activity-history event: linking is checklist planning, not a
-- GuestInvitation/RSVP fact (ADR-008 §3).

alter table public.checklist_items
  add column guest_invitation_id uuid;

-- Same-wedding invariant, enforced relationally (like the LB-07 assignee):
-- the party is identified by (party id, THIS ITEM'S wedding id), so a party
-- of another wedding (or one that doesn't exist) simply isn't a valid
-- reference, whoever writes it. Null = no guest work (MATCH SIMPLE skips the
-- check). Deleting the party only clears this column: the item, its status
-- and its wedding_id stay (the column list keeps wedding_id).
alter table public.checklist_items
  add constraint checklist_items_guest_invitation_same_wedding
    foreign key (guest_invitation_id, wedding_id)
    references public.guest_invitations (id, wedding_id)
    on delete set null (guest_invitation_id);

comment on column public.checklist_items.guest_invitation_id is
  'Optional guest party (GuestInvitation) of this wedding the item is about. Navigation only, never authorization; nothing is copied from the party.';

-- Serves the party's ON DELETE SET NULL lookup and the guest page's nested
-- read of each party's related items (one query for the whole list).
create index checklist_items_guest_invitation_idx
  on public.checklist_items (guest_invitation_id, wedding_id)
  where guest_invitation_id is not null;

-- Same permission as every other checklist edit: any member of the item's
-- wedding (checklist_items_update_member already scopes the row). Update
-- only: items are created unlinked, then linked deliberately.
grant update (guest_invitation_id) on table public.checklist_items to authenticated;
