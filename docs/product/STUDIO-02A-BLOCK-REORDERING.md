# STUDIO-02A: reliable same-slot photo-block reordering

Existing gallery, carousel, photo-with-text and single-photo blocks can be dragged before another block or to the end of their current slot. The cover and fixed text sections cannot move. Palette insertion stays click-only at slot ends. Cross-slot moves, palette dragging and new templates are deferred.

Use the drag handle with a mouse or a held touch, or select a block and use **Mover antes / Mover después** with keyboard or tap. Escape cancels a drag. Invalid targets and no-op drops do not issue mutations. Selection and unsaved text drafts survive reordering. If the existing properties panel has an unsaved slot change, save or discard that placement change before reordering; controls explain why they are disabled. Only confirmed server data changes the canvas order; there is no optimistic placement to mistake for a save.

## Persistence and concurrency

`reorder_wedding_site_photo_block` is an additive SECURITY INVOKER RPC under existing RLS and member grants. The caller supplies the wedding, block, original slot, expected slot order and destination-before ID (omitted means end). It shares the insertion trigger's per-wedding advisory lock, then locks all wedding block rows in UUID order (maximum 12). Locking all slots also excludes concurrent anchor edits from entering the target slot during the transaction. The expected order is checked after locks are obtained.

One transaction changes only positions. Photo membership, IDs, visibility and content remain unchanged. Stale/cross-slot/cover/invalid requests are rejected. No-ops do not update timestamps. An error rolls the entire transaction back. Legacy adjacent swaps use row locks but a different acquisition order: contention may abort either transaction with a deadlock. That is a complete failure, never a partial move; the UI refreshes and the user can retry. No automatic replay is safe.

The action reads authoritative editor data after success or failure. If the browser loses the action response it refreshes the route, preserving React draft state. Movement is blocked until fresh data arrives; if reconciliation also fails, the message asks the user to save their text and reload. A network error can follow a committed operation, so the UI never claims it rolled the database back.

Preview and public pages keep their existing renderer and position ordering. Publication is unchanged: saving visible content on an already published site changes what guests see immediately.

## Validation and deployment boundary

Tests run only in GitHub Actions. Existing CI starts disposable local Supabase stacks; DB and E2E helpers reject non-local URLs. No hosted database credentials or remote migration commands are used. The feature branch is excluded from automatic Vercel deployment in `vercel.json`.

Coverage includes order intent/no-ops, action reconciliation, member/outsider access, forced mid-update rollback, competing reorders, insertion/legacy-swap contention, browser cancellation/invalid drops, keyboard/tap alternatives, lost action responses, unsaved drafts, reload and preview/public order.

Before any separately approved application deployment, apply `20261029120000_lb_studio_atomic_reorder.sql` through the approved migration process. This PR does not apply it to production, staging or any hosted database. The generated types contract is checked in CI. There are no columns, data backfills, RLS changes or changes to the legacy RPC.

Rollback: revert the application first. The unused RPC can remain without affecting Studio-01. Once callers are gone, a separately reviewed migration can drop only `public.reorder_wedding_site_photo_block(uuid, uuid, text, uuid[], uuid)`. Saved positions remain valid; no data rollback is needed.

Manual acceptance in an authorized test environment: drag first/last blocks in a populated slot; cancel with Escape and drop on a fixed section; reorder with keyboard and tap at mobile width; leave text unsaved while moving; open two editors to provoke a stale request; interrupt a response; reload and compare member preview and public order. Check focus, screen-reader announcements and touch scrolling on actual devices.
