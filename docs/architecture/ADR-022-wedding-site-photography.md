# ADR-022 — Wedding Site Photography (Managed, Publication-Gated Media)

Status: **Proposed** (UX-01B1, 2026-10-22). Not accepted, not effective. It becomes effective only when the owner
ratifies the Constitution amendment in Appendix A and accepts this ADR in a reviewed change; until then the
Constitution's "Gallery: OUT" stands and nothing here may be implemented.
Related: [Product Constitution §1, §8, §10](../product/PRODUCT-CONSTITUTION.md), [ADR-001](ADR-001-product-domain-and-tenancy.md),
[ADR-002 §4, §6, §7](ADR-002-auth-and-security-boundaries.md), [ADR-013](ADR-013-visual-seating-planner-layout-model.md)
(LB-20 drag policy), [ADR-017](ADR-017-dual-couple-planner-use.md), [ADR-019](ADR-019-wedding-site-design-and-themes.md),
[ADR-021](ADR-021-stripe-billing-entitlements.md). Plan and cost model: [UX-01B photography plan](../product/UX-01B-PHOTOGRAPHY-PLAN.md).

## Context

"Lista la boda" means *the wedding is ready*. The couple-facing website is where that promise is visible to guests,
and the owner has decided that wedding photographs are a core part of it: one cover photo, personal photos, a
responsive gallery, at least one carousel and photo-with-text compositions, under wedding-level publication and
privacy controls and compatible with the current themes. This is a curated wedding website, not a photo backup,
post-event album or digital-asset manager.

Today (`origin/main` 9880486) there is no media of any kind:

- The Constitution keeps **Gallery OUT** ("media storage + privacy cost", §8) and says images stay deferred with it.
  ADR-019 §7 requires a separate ADR covering storage, metadata stripping and publish-gated serving first.
- No migration touches `storage.buckets` or `storage.objects`; `supabase/config.toml` only has the CLI defaults
  (`[storage] enabled`, `file_size_limit = "50MiB"`, buckets and image transformation commented out, the latter noted as
  "available to Supabase Pro plan"). Production buckets were not inspected (no production access in UX-01B1).
- No image library is a direct dependency. `sharp` 0.35.5 is present only as Next.js's **optional** dependency
  (`node_modules/next/package.json` `optionalDependencies`); using it in our code requires declaring it explicitly.
- `next/image` is not used: marketing images are plain `<picture>`/`<img>` from static imports
  (`src/components/marketing/ProductShot.tsx`, `LifestylePhoto.tsx`). The public site (`src/components/wedding-site/`)
  renders text only, as Server Components with no client JavaScript.
- The public site `/boda/[slug]` (`src/app/boda/[slug]/page.tsx`) is `force-dynamic`, `noindex, nofollow` (also the
  `X-Robots-Tag` header for `/boda/:path*` in `next.config.ts`) and reads only `get_published_wedding_site(slug)`
  (`src/lib/wedding-site/public.ts`), gated by `wedding_publications.published_at` and per-section `is_visible`.
  Slugs can be changed by the owner (`set_wedding_site_slug`), so nothing may depend on a slug staying stable.
- Content: `content_sections` (one row per fixed kind, plain-text `title`/`body`, `is_visible` default false; migration
  `20261005120000_lb_wedding_site_content.sql`); there is no JSON content. Design: `wedding_site_designs`
  (`theme_key` + `customization` jsonb, presentation only, ADR-019).
- Hosting: Vercel (team on **Hobby**, per the LB-17A.2 cron decision; Vercel states Hobby is "for personal,
  non-commercial use"). Functions accept request bodies up to **4.5 MB**. `src/proxy.ts` excludes paths ending in
  `.webp/.png/.jpg/...` from the session proxy. Security headers: `nosniff`, `frame-ancestors 'none'`, no full CSP.

## Decision

### 1. Product scope (what "photography" means here)

- A wedding has a **media library of at most 20 photos** (cover included). Photos are placed by **predefined blocks**:
  `cover` (one), `gallery`, `carousel` and `photo_text`. One photo may appear in several blocks; it counts once.
- Blocks are curated components with closed variants; never a free-form page builder, user HTML/CSS, embeds or URLs.
- Photos are wedding CONTENT (like `content_sections`), never design: `wedding_site_designs` never stores media, and a
  theme only decides how photos are framed (ADR-019 §1 stays intact).
- Owners and collaborators manage photos (same as content sections). Publishing stays owner-only and unchanged.

### 2. Options considered

| | A. Supabase Storage (managed) | B. Object storage + image CDN (R2, Cloudflare Images, Vercel Image Optimization) | C. BYOS (couple's Drive/Photos/other) | D. Hybrid A + optional BYOS |
|---|---|---|---|---|
| Fit with current stack | Same project, same auth, RLS on `storage.objects` | New vendor, new credentials, sync between DB and bucket | OAuth per couple, tokens to store | Both |
| Tenant isolation | RLS + our policies | App-enforced only (no RLS) | Provider-enforced, outside our model | Mixed |
| Publication gating / revocation | Our policy decides every read | Our proxy decides; CDN copies outlive it | Provider sharing decides; links break or leak | Mixed |
| Metadata stripping | Ours (server re-encode) | Ours, or provider transform | Not ours unless we copy (then it is A) | Mixed |
| Cost at launch | Included in plan quotas | Low, but another bill and integration | "Free" storage, but we still proxy bytes | Highest build cost |
| Ops burden | Lowest | Medium | Highest (OAuth, quotas, broken links, support) | Highest |
| Exit path | Objects are plain files; export by script | Same | Couple keeps originals | — |

**Selected: A for the MVP**, with delivery through our own cached route so that **B can replace the byte origin
later** (§9). **C rejected for the MVP; D deferred** with a re-evaluation trigger (§12).

BYOS findings (why not now):

- **Google Photos**: since 2025-03-31 the Library API only reaches media the app itself uploaded; reading a user's
  library requires the Picker API, whose `baseUrl`s expire after **60 minutes** (sooner if the user revokes access).
  Officially unusable for long-lived public embedding; we would have to copy the bytes, which is option A plus OAuth.
- **Google Drive**: the Drive API serves file content to an authorized app (`drive.file` scope, OAuth consent, refresh
  tokens to store and rotate). "Anyone with the link" share URLs are document viewers, not image endpoints;
  hotlinking them is unsupported, rate-limited and breaks when the owner changes sharing. Again we would proxy or copy.
- **Image-oriented storage** (Cloudflare R2/Images, S3 + CDN, Cloudinary-style services) is technically viable, but
  as storage owned by *us* (option B), not by couples: no nontechnical couple will provision a bucket.
- In every BYOS variant guests' browsers would hit either a third party (privacy, broken links, no metadata control)
  or our proxy (so our transfer cost stays). BYOS does not remove egress cost, adds OAuth token custody, SSRF surface
  and support load, and only saves storage, which is the cheap part (§10).

### 3. Selected architecture

Two private Supabase Storage buckets, a metadata model in Postgres, server-side processing, and a public delivery
route that re-checks publication on every cache miss.

1. **`wedding-media-incoming`** (private): raw uploads only. Bucket `file_size_limit = 15 MB`,
   `allowed_mime_types = image/jpeg, image/png, image/webp`. Object name fixed by the server:
   `<media id>/original`. Members may INSERT only into the name of their own unexpired reservation (policy below); no
   client SELECT/UPDATE/DELETE. Bytes never leave this bucket unprocessed.
2. **`wedding-media`** (private): processed WebP renditions only, `<media id>/<rendition>.webp`, written ONLY by the
   media processor (§5). No client write policy at all, so every stored public byte was produced by our encoder.
   Object names contain the random media id, never a wedding id, slug or file name.
3. **Upload** (browser → storage directly, because Vercel caps function bodies at 4.5 MB): a Server Action, after
   `requireUser` + `requireWeddingMembership`, calls `reserve_wedding_media(wedding)` (quota-checked, §8) and returns a
   short-lived **signed upload URL** for exactly `<media id>/original`, created with the member's own session. The
   browser PUTs the file there. No storage credential, bucket name choice or path choice reaches the client.
4. **Processing** (Server Action "finalize", member session first): read the raw object, verify magic bytes, decode
   with `sharp` under `limitInputPixels`, apply EXIF orientation, **re-encode** (drops EXIF/GPS/XMP/ICC except an sRGB
   conversion), write the renditions through the media processor, then `complete_wedding_media(id, ...)` records
   dimensions; the byte total is read from `storage.objects` metadata inside the function, never trusted from the
   caller. Finally the raw object is deleted. Failure at any step → `failed` state, raw deleted, friendly message.
5. **Public delivery**: `GET /boda/[slug]/fotos/[mediaId]/[rendition]` (route handler, no cookies, outside the session
   proxy). It calls an anon-executable SECURITY DEFINER read, `get_published_wedding_photo(slug, media_id, rendition)`,
   that returns the object path only if the wedding is published, the media is `ready` and it is placed in a visible
   block; otherwise every case is the same 404. The bytes are read with the anon key under a storage SELECT policy
   that applies the same predicate (`private.wedding_media_object_is_public(name)`), so even a direct Storage API call
   with the public anon key only reaches published photos. Response: `Content-Type: image/webp` (fixed),
   `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`, `Cross-Origin-Resource-Policy:
   same-origin`, `X-Robots-Tag: noindex`, and `Cache-Control: public, max-age=300, s-maxage=600` (§7).
6. **Member preview**: `/app/weddings/[id]/site/fotos/[mediaId]/[rendition]` with the member session (storage SELECT
   policy for members of the media's wedding), `Cache-Control: private, no-store`. The editor and the member preview
   use it; unpublished photos never pass through a public URL.
7. **Public read**: `get_published_wedding_site` gains one field, `site_photos` (visible blocks with `ready` media
   only: block kind, anchor, variant, position, and per item the media id, width, height, alt text, caption, focal
   point). No paths, wedding ids, uploader, timestamps or byte sizes. This is the explicit product decision LB-10
   requires for a new public field. The renderer receives photos as part of the content DTO, never inside the design.

### 4. Data model (smallest extensible)

- `public.wedding_media`: `id uuid` (random; the only public identifier), `wedding_id` (FK, cascade), `state`
  (`wedding_media_state`: `pending | ready | failed | deleting`), `created_by` (provenance only), `width`, `height`
  (master, 1–10000), `bytes_total` (from storage), `alt_text` (plain text ≤ 250; required before a photo can be placed
  in a visible block), `focal_x`, `focal_y` (integers 0–10000, default 5000; crop is derived at render with
  `object-position`, never stored as pixels), `reserved_until`, `created_at`, `ready_at`. `UNIQUE (id, wedding_id)`
  for composite FKs. No storage provider column: one provider; a later provider move is a migration (§9).
- `public.wedding_site_photo_blocks`: `id`, `wedding_id`, `kind` (`cover | gallery | carousel | photo_text`),
  `variant` (closed per kind, e.g. gallery `grid | masonry`), `anchor` (`content_section_kind` or null = after the
  hero; the cover ignores it), `position` (int, order among blocks sharing an anchor), `is_visible` (default false),
  `title`/`body` (plain text, `photo_text` only, same limits as `content_sections`), timestamps. Partial unique index:
  one `cover` per wedding.
- `public.wedding_site_photo_block_items`: `block_id` + `media_id` (both same-wedding composite FKs, cascade),
  `position`, `caption` (plain text ≤ 200). PK `(block_id, media_id)`. Cover and `photo_text` hold exactly one item
  (trigger), gallery/carousel 1–20.
- Why not JSON: `content_sections` has no JSON to extend, and ADR-019 keeps design JSON free of wedding data.
  Relational rows give same-wedding FKs, cascades and RLS for free; a JSON array of media ids would reintroduce
  dangling references and cross-wedding ids. Media are referenced by id only, never by URL.
- RLS in the same migration for all three tables: member SELECT/INSERT/UPDATE/DELETE through
  `private.is_wedding_member`, column grants only for editable columns; anon nothing (the public read is the function).

### 5. Privileged access: one narrow media-processor module

Members may write only raw bytes into their own reservation. Writing renditions and deleting objects of a wedding
needs an authority no client role should hold (otherwise a member could place unsanitized bytes behind a public URL).
Proposed: a **sixth** server-only service-role module, `src/lib/media/media-store.ts`, with exactly these operations:
`readIncoming(mediaId)`, `writeRenditions(mediaId, renditions)`, `deleteObjects(mediaId)`. Its authority is the app's
own processing result after the member session authorized the action (the same shape as the ADR-004 recorder). It
never authorizes, never takes a wedding id or path from input (paths derive from the media id), exposes no generic
client, and ESLint keeps `SUPABASE_SERVICE_ROLE_KEY` out of every other file. Accepting it amends ADR-002 §6 in the
same reviewed change. Orphan cleanup (§6) reuses it; a scheduled sweep would be a separate, later approval.

### 6. Lifecycle and transaction boundaries

- **Reserve**: one transaction under the wedding row lock: quota checks (§8), insert `pending` with
  `reserved_until = now() + 30 min`. Expired reservations of the same wedding are swept first (rows to `deleting`).
- **Upload**: outside any transaction (browser → storage). A reservation that never finalizes expires.
- **Finalize**: no database lock is held while decoding or uploading. `complete_wedding_media` (member session,
  membership-checked) moves `pending → ready` only if the row is still pending, unexpired and every rendition object
  exists; it reads their sizes and re-checks the byte budget. On any failure: `failed`, raw deleted.
- **Place / reorder / caption / visibility**: ordinary member writes; reorder is one RPC that rewrites a block's
  positions in one transaction (no position gaps assumed).
- **Publish / unpublish**: unchanged functions; photos follow automatically because every public read re-checks
  `published_at`. Nothing is copied on publish, so there is nothing to sync or roll back.
- **Replace the cover**: upload a new media, then one transaction points the cover item at it; the old media stays in
  the library (the couple deletes it explicitly). Media are immutable: a new photo is a new id, so URLs never serve a
  changed image under an old cache entry.
- **Delete a photo used in several blocks**: the UI lists where it is used and asks once; the transaction sets
  `deleting` and removes its block items (cascade); then the processor deletes the objects; then the row is deleted.
  A crash between steps leaves `deleting` rows, which the next sweep (reserve, or a later scheduled job) finishes.
- **Delete a wedding or an account**: rows cascade; objects become orphans whose media id has no row. A reconcile
  (list `wedding-media`/`wedding-media-incoming` prefixes without a row → delete) is required before launch; first as
  an operator script, later as a scheduled job (owner decision, §12).
- **Retries**: every step is idempotent by media id (fixed object names, state checks), so retrying a failed finalize or
  delete is safe.

### 7. Privacy and public delivery model

- Public = published wedding AND visible block AND `ready` media, re-checked by the database on every cache miss.
  Unpublished photos are reachable only by members, through the member route with `no-store`.
- **CDN caching vs revocation (explicit tradeoff).** A public cache cannot be revoked instantly. With the recommended
  `max-age=300, s-maxage=600`, after unpublishing, hiding a block or deleting a photo a copy may keep being served for
  **up to ~10 minutes at the Vercel edge plus up to 5 minutes in a browser that already loaded it**. Deleting a photo
  additionally removes the object, after which no new cache miss can succeed. Immediate revocation is **not**
  promised; the UI says "puede tardar unos minutos en dejar de verse". Best-effort purge by cache tag on unpublish may
  be added if verified on Vercel, but the guarantee stays "within minutes". `no-store` (instant) is the alternative
  at a cost of one function invocation and one storage read per image request (§10); it is rejected as default.
- Public URLs contain the slug and the random media id, never a wedding id. The site stays public by address and
  `noindex`; photos inherit that (not discoverable, not secret). Changing the slug breaks old photo URLs, by design.
- Metadata: re-encoding removes EXIF/GPS/XMP and camera data; nothing from the file (name, date, device) is stored.
- Consent: couples upload only photos they have the right to share. Guests appear in photos without an account; the
  editor reminds couples to ask before publishing other people's faces, and deleting a photo removes it within the
  window above. The legal text (Terms/Privacy) needs a reviewed update before launch; this ADR does not change it.

### 8. Quotas and limits (enforced in the database and storage, mirrored in the UI)

| Limit | Value | Enforced by |
|---|---|---|
| Photos per wedding (pending + ready, cover included) | 20 | `reserve_wedding_media` under the wedding lock |
| Pending reservations per wedding at once | 5 (upload concurrency) | same |
| Reservations per wedding per day | 60 (failed and deleted ones count) | same (counter by day) |
| Raw upload per file | 15 MB | bucket `file_size_limit` + server check |
| Accepted inputs | JPEG, PNG, WebP (magic bytes verified; HEIC/AVIF/GIF/SVG refused) | bucket MIME list + signature + decoder |
| Input pixels | ≤ 50 MP and each side ≤ 10000 px; min 600 px short side | `sharp` `limitInputPixels` + check |
| Master rendition (private, for re-cropping) | WebP, long edge 2400 px, quality 82 | processor |
| Public renditions | WebP 1600 / 960 / 480 px long edge, quality 78 | processor |
| Stored bytes per wedding | ≤ 40 MB (expected ~22 MB at 20 photos) | `complete_wedding_media` from storage metadata |
| Alt text / caption | ≤ 250 / ≤ 200 chars, plain text | CHECK |

Originals are not kept: the 2400 px master is enough to re-derive every web crop and size; focal-point crops are
applied at render. Stored size (GB-month) and delivered bytes (egress/transfer) are separate cost drivers (§10).

### 9. Provider abstraction (the only one worth keeping)

Keep exactly two seams: object names derived from the media id (`<id>/<rendition>.webp`), and every public byte served
through our delivery route. Then moving the origin to R2 or another store is a migration of objects plus a change
inside `media-store.ts` and the route, with no URL, schema or renderer change. No generic "storage provider"
framework, no provider column, no BYOS interfaces.

### 10. Operational and cost guardrails

- Plan prerequisites (owner decision): Vercel Hobby is non-commercial, so a paid product needs Vercel Pro anyway;
  Supabase Free includes 1 GB of storage, which ~45 weddings with full libraries would exhaust.
- Every image request after the first per edge region is a Vercel CDN hit (transfer only, no function, no storage
  read). Cache misses cost a function invocation and storage egress.
- Safeguards before launch: Supabase spend cap / billing alerts; Vercel spend management and an alert on transfer;
  a Vercel Firewall rate limit on `/boda/*/fotos/*` per IP; quotas above; renditions sized to the viewport through
  `srcset`/`sizes` and `loading="lazy"` below the fold, so a gallery view never downloads masters.
- Metrics: total stored bytes and photo count (one aggregate query), monthly transfer on `/boda/*/fotos/*` and cache
  hit ratio from Vercel observability, top weddings by image requests (to spot a viral or abusive site). No
  per-request application logging (consistent with the existing routes).

### 11. Threat model (summary)

| Threat | Control |
|---|---|
| Cross-wedding access (read, write, delete) | Media ids map to one wedding; RLS on rows; storage policies derive the wedding from the media row; composite FKs keep blocks/items in one wedding |
| Unpublished photo leaks | Every public read re-checks publication; member route `no-store`; no public bucket; bounded cache window (§7) |
| Malformed/malicious file, polyglot, decompression bomb | Size cap, MIME allowlist, magic bytes, decode under pixel limit, full re-encode; only processor-written WebP is served, with fixed type, `nosniff`, `default-src 'none'` |
| EXIF/GPS leakage | Re-encode drops metadata; nothing from the file is stored |
| Members bypassing processing | No client write policy on `wedding-media`; incoming objects are never served |
| Path/credential leakage | Server derives names from ids; no wedding id/slug/file name in object names; no keys in the client; 404 for every failure |
| Quota abuse / runaway bills | DB quotas, bucket caps, daily reservation cap, rate limit, spend caps, metrics |
| Orphans and abandoned uploads | Reservation expiry, sweep on reserve, `deleting` state, reconcile before launch |
| SSRF | No URL import in scope. Any future remote fetch (BYOS) requires an allowlisted provider API, never a user-supplied URL |
| Error disclosure | Closed reasons mapped to Spanish copy; no bucket, path or provider text reaches users |

### 12. Alternatives rejected or deferred

- **Public bucket**: no revocation except deletion, and URLs would outlive unpublishing; rejected.
- **Members writing renditions directly**: would allow unsanitized public bytes; rejected.
- **Supabase image transformations / Vercel Image Optimization on the fly**: paid per origin image or per
  transformation, and harder to bound; pre-rendering three sizes at upload is cheaper and predictable. Revisit if
  AVIF or more sizes are needed.
- **Storing originals**: no product need; higher storage and privacy cost; rejected.
- **BYOS (Google Drive, Google Photos)**: rejected for the MVP (§2). **Hybrid**: deferred; re-evaluate only on real
  demand (for example planners asking to bring a photographer's delivery), as "import by copy" through an official API,
  never hotlinking.
- **`@dnd-kit/sortable` or another drag library for reordering**: not added (LB-20 rule). Reordering uses
  keyboard-accessible "Mover antes / Mover después" buttons; drag could be added later only by amending that rule.
- **General drafts/versions of the whole site**: not part of this ADR. Draft-like control comes from per-block
  `is_visible` (default false) plus the member preview; full drafts remain a separate decision (ADR-019 §5).

### 13. Rollout and reversal

- Phases: UX-01B2 (cover), UX-01B3 (gallery, carousel, photo-text) as committed phases, then UX-01C themes; specs in
  the plan document. Each migration ships before its code (production lesson from QA-03a), behind a server-side
  feature flag `WEDDING_SITE_PHOTOS` (env, default off) that hides the editor and makes the public read return no
  photos until enabled.
- Reversal: turning the flag off hides every photo immediately on the next cache miss (bounded window §7). Removing
  the feature: drop the public field, delete objects with the reconcile script, drop the tables in a forward migration.
- Vendor exit: objects are plain WebP files under media-id names; a script copies them to another S3-compatible store,
  then `media-store.ts` and the delivery route switch origin. No public URL changes.

### 14. Acceptance requirements (for the implementation tickets)

- Database tests: RLS for both roles and outsiders on all tables; anon sees nothing; same-wedding FKs; quota and
  reservation limits under concurrency; `complete_wedding_media` refuses missing renditions and reads sizes itself;
  `get_published_wedding_photo` returns the same 404 for missing, unpublished, hidden, pending, deleted and foreign ids.
- Storage policy tests: members cannot write `wedding-media`; cannot write another reservation's name; anon reads only
  published, visible, ready renditions.
- Processor unit tests with fixture files: EXIF/GPS removed (verified by reading the output), orientation applied,
  oversized/undersized/polyglot/truncated/wrong-signature files refused.
- E2E: upload → preview → publish → public image → unpublish → 404 after the cache window (tested with caching off),
  replace cover, delete a photo used twice, quota messages, keyboard reordering, no layout shift (width/height set).
- No production data in fixtures; images are generated test patterns.

## Consequences

- Photos become first-class wedding-site content with the same publication gate as text.
- One more privileged module, narrowly scoped, if accepted.
- Paid hosting plans become a prerequisite for a commercial launch with photos.

## Appendix A — Proposed Constitution amendment (draft, not ratified)

To be applied to `docs/product/PRODUCT-CONSTITUTION.md` only after owner ratification, in the same change that marks
this ADR Accepted.

1. Header: add "Amended: Wedding site photography (YYYY-MM-DD, ADR-022) — curated photos on the published wedding
   website: §8, §10."
2. §8, Post-MVP, Phase 2: add "Curated wedding-site photography (ADR-022): a cover photo and up to a fixed number of
   photos per wedding, placed in predefined blocks (gallery, carousel, photo with text)."
3. §8, DEFERRED: replace "gallery" with "large photo albums, photo backup or post-event photographer delivery".
4. §8 table: replace "Gallery | OUT for now (media storage + privacy cost)" with "Photos (cover, gallery, carousel,
   photo with text) | POST-MVP (Phase 2), ADR-022: curated, quota-limited, publication-gated; no albums or backup".
5. §8 paragraph: replace "Images and media stay deferred with Gallery;" with "Photos are wedding content governed by
   ADR-022, never design;".
6. §10, visibility table: add to PRIVATE "unpublished photos" and to PUBLIC "photos placed in visible blocks of a
   published site".
7. §10, new principle 11: "Media is private by default, processed (re-encoded, metadata removed) before it can ever
   be public, limited by server-enforced quotas, and served only while its wedding is published; revocation is bounded
   by a stated cache window, never promised as instant."
