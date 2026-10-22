# ADR-022 — Wedding Site Photography (Zero-Cost MVP)

Status: **Accepted** · Date: 2026-10-22 (proposed in UX-01B1; ratified by the product owner on 2026-10-22, who
ratified the Constitution amendment in Appendix A, accepted this ADR including its §13 implementation decisions, the
read-only sixth service-role module (§4, amending ADR-002 §6) and a direct, version-pinned `sharp` dependency).
Authorization covers building and testing; production migrations, storage resources and activation of the
`WEDDING_SITE_PHOTOS` flag each remain separate, explicitly approved steps (§11).
Related: [Product Constitution §1, §8, §10](../product/PRODUCT-CONSTITUTION.md), [ADR-002 §4, §6, §7](ADR-002-auth-and-security-boundaries.md),
[ADR-013](ADR-013-visual-seating-planner-layout-model.md) (LB-20 drag policy), [ADR-019](ADR-019-wedding-site-design-and-themes.md),
[ADR-021](ADR-021-stripe-billing-entitlements.md). Plan, limits and tickets: [UX-01B photography plan](../product/UX-01B-PHOTOGRAPHY-PLAN.md).

## Context

"Lista la boda" means *the wedding is ready*. The owner has decided that photographs are essential to the couple's
website and set the priorities: beautiful simple sites, **zero incremental infrastructure cost during market
validation**, upload inside ListaLaBoda, no third-party accounts for couples, and practical, proportional privacy.

MVP scope (owner): one cover photo; up to 20 photos per wedding in total; gallery, carousel and photo-with-text
sections; 15 MB maximum per uploaded file; 40 MB maximum stored per wedding; server-side processing with EXIF/GPS
removal; the five current themes; the couple controls publication; guests open published sites by link, without
authentication; sites stay `noindex`; and a clear disclosure that **anyone with the link can view and download
published photos**.

Current state (`origin/main` 9880486): no media anywhere. No migration touches `storage.*`; `supabase/config.toml`
has only CLI storage defaults. `sharp` 0.35.5 exists only as Next.js's optional dependency. The public site
(`src/app/boda/[slug]/page.tsx`) is dynamic, `noindex`, and reads only `get_published_wedding_site`. Hosting is Vercel
(team on Hobby) with a 4.5 MB request-body limit for functions; Supabase holds the database, Auth and (unused) Storage.

## Decision

### 1. Provider: Supabase Storage in the existing project, delivered through Vercel's CDN

Measured against the free tiers (sources and dates in the plan, §2):

| | Pinata Free (public IPFS) | Supabase Storage Free (existing project) | Vercel Blob Hobby (existing team) |
|---|---|---|---|
| Storage | 1 GB | 1 GB | 1 GB |
| File count | **500 files** | not limited | not limited |
| Delivery | 10 GB and **10,000 requests / month** (dedicated gateway) | 5 GB uncached + 5 GB cached egress, **shared with all database/API traffic** | 10 GB Blob transfer, 10,000 cache misses, 2,000 uploads (advanced ops) / month |
| Over the limit | uploads and gateway blocked at +25 % | Fair Use restrictions on the **whole organization** (pausing, read-only database, 402) | Blob unavailable for 30 days (only Blob) |
| Tenant isolation | none (app-only) | Postgres RLS on `storage.objects` with member sessions | app-only, one store token |
| Revocation | **impossible** (content addressed by CID; copies may persist anywhere) | delete the object | delete the blob |
| New vendor / secret | yes / yes | no / no | no / yes (`BLOB_READ_WRITE_TOKEN`) |

- **Pinata Free is rejected.** 10,000 gateway requests a month is about 900 typical page views across all weddings,
  and 500 files is about a dozen full weddings. Public IPFS also contradicts the privacy promise: anything published
  is reachable by CID through any gateway, unpinning does not delete it from the network, and third-party copies can
  persist indefinitely; erasure could never be offered. (If IPFS were ever reconsidered: never originals, never
  metadata, and no revocation or erasure promise.)
- **Vercel Blob Hobby** is viable and its failure is contained, but it adds a store token with full write power
  (a privileged credential in app code), no RLS, and a 2,000-uploads-a-month ceiling.
- **Selected: Supabase Storage** in the project we already run, because uploads and changes can stay under Postgres RLS
  with the member's own session (no new write credential), the data stays with the wedding it belongs to, and nothing
  new is provisioned or paid. Its one dangerous property, organization-wide restrictions if a free quota is exceeded,
  is neutralized by design: guests never download from Supabase directly (§4), Vercel's CDN serves repeat views, the
  origin traffic is metered and capped by the app (§6), and storage is capped globally (§6).

### 2. One private bucket, two renditions, no originals

- Bucket **`wedding-photos`**, private, `file_size_limit = 1 MB`, `allowed_mime_types = image/webp`.
- Each photo is stored only as two processed WebP renditions: `<photo id>/1600.webp` (long edge 1600 px, quality 80,
  ≈ 300 KB) and `<photo id>/640.webp` (≈ 70 KB). No original, no master, no metadata. Cropping is a focal point applied
  at render (`object-position`), so no re-cropping source is needed. Object names hold the random photo id only, never
  a wedding id, slug or file name.

### 3. Upload and processing (one member request, member session)

1. The editor (client component) checks the chosen file: ≤ **15 MB**, JPEG/PNG/WebP (HEIC accepted only where the
   browser can decode it), then decodes and downsizes it in the browser to ≤ 2400 px and ≤ 4 MB JPEG. This is a
   transport step only (Vercel's 4.5 MB body limit); it is never trusted.
2. Member upload request (§13.1; `requireUser` → `requireWeddingMembership` → feature flag): calls `create_wedding_photo(wedding)`,
   which locks the wedding row and enforces the quotas (§6), first deleting this wedding's stale `pending` rows (their
   objects are removed just before, §13.3), and inserts a `pending` row.
3. The server verifies the magic bytes, decodes with `sharp` under `limitInputPixels` (≤ 50 MP, each side ≤ 10,000 px,
   short side ≥ 600 px), applies the orientation and **re-encodes** both renditions; EXIF, GPS, XMP and ICC profiles are
   dropped (sRGB output).
4. It uploads both renditions **with the member's session**. The storage INSERT policy allows exactly
   `<id>/1600.webp` and `<id>/640.webp` of a `pending` row of a wedding the caller belongs to, created by the caller in
   the last 15 minutes; no UPDATE policy (no overwrite).
5. `complete_wedding_photo(id)` marks it `ready` only if both objects exist; it reads their sizes from
   `storage.objects` (never from the caller) and re-checks the 40 MB budget. Any failure: objects and row deleted,
   one closed error.

A member could bypass steps 1–3 by calling the Storage API with their own session; the bucket caps size and type,
and **delivery re-validates every object** (§4): only a decodable WebP of the expected size with no EXIF/XMP/ICC
chunk is ever served. The worst a member can do is break their own wedding's photo.

### 4. Public delivery (the only privileged piece)

- Route `GET /boda/[slug]/fotos/[photoId]/[1600|640]`: reads and sets no cookies and is excluded explicitly from the
  session proxy matcher in `src/proxy.ts` (the path has no file extension, so today's `.webp` exclusion does not cover
  it). Any query string → 404, so the CDN cache cannot be bypassed with `?x=`.
- It calls the server-only module **`src/lib/wedding-site/photo-origin.ts`** (the **sixth service-role module**,
  read-only, one operation): `fetchPublishedPhoto(slug, photoId, rendition)` → service_role-only RPC
  `claim_published_wedding_photo` (returns the object path only if the wedding is published, the photo is `ready`
  and placed in a visible block, and the monthly origin budget allows it; it adds the object's size to the month's
  counter) → downloads the object → validates it (format WebP, dimensions, no metadata chunks) → streams it.
- **Why a privileged reader is justified:** with an anon storage policy, anyone holding the public anon key could
  download published photos straight from Supabase, bypassing the CDN and the meter, and exhaust the free egress that
  the whole product (Auth, billing, RSVP) shares. The module never writes, never authorizes members, takes no wedding
  id or path from input, and exposes no client. Its acceptance amends ADR-002 §6 (later note, 2026-10-22).
- Response headers: `Content-Type: image/webp` (fixed), `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'`, `Cross-Origin-Resource-Policy: same-origin`, `X-Robots-Tag: noindex`,
  `Cache-Control: public, max-age=600` (browsers: 10 minutes), `Vercel-CDN-Cache-Control: public, max-age=2592000`
  (edge: 30 days), `Vercel-Cache-Tag: lb-photo-<photoId>`. Every failure is the same 404 (`no-store`, §13.6).
- **Member preview**: `/app/weddings/[id]/site/photos/[photoId]/[rendition]` with the member session (storage SELECT
  policy for members of the photo's wedding), `private, no-store`.
- The public read `get_published_wedding_site` gains one field, `site_photos`: visible blocks with `ready` photos
  (kind, variant, anchor, position; per photo id, width, height, alt text, caption, focal point). No paths, wedding ids,
  uploader, timestamps or sizes. This is the explicit product decision LB-10 requires for a new public field.

### 5. Data model (two tables)

- `public.wedding_photos`: `id uuid` (random; the only public identifier), `wedding_id` (cascade), `state`
  (`pending | ready`), `block_id` (nullable = in the library, not shown; same-wedding composite FK, `ON DELETE SET NULL
  (block_id)`), `position`, `alt_text` (plain text ≤ 250, required to place the photo in a visible block), `caption`
  (≤ 200), `focal_x`, `focal_y` (0–10000, default 5000), `width`, `height`, `bytes`, `created_by` (provenance),
  `created_at`. A photo is in at most one block; showing the same picture twice means uploading it twice (it counts
  twice). This removes a join table and multi-use deletion rules.
- `public.wedding_site_photo_blocks`: `id`, `wedding_id`, `kind` (`cover | gallery | carousel | photo_text`), `variant`
  (closed per kind), `anchor` (`content_section_kind`, null = right after the hero; the fixed LB-10 section order is
  untouched), `position`, `is_visible` (default false), `title`/`body` (plain text, `photo_text` only), timestamps. One
  `cover` per wedding (partial unique index); cover and `photo_text` hold one photo, gallery/carousel up to 20.
- `public.wedding_photo_origin_usage`: one row per month, `origin_bytes` (bigint); written only by the claim RPC.
- RLS in the same migration: members SELECT/INSERT/UPDATE/DELETE on the first two through `private.is_wedding_member`
  with column grants; anon and authenticated nothing on the third. Media are referenced by id in relational columns,
  never by URL or JSON (there is no section JSON to extend, and ADR-019 keeps design JSON free of wedding data).

### 6. Quotas and cost circuit breakers (server-enforced)

| Limit | Value | Where |
|---|---|---|
| Photos per wedding (pending + ready, cover included) | 20 | `create_wedding_photo` under the wedding lock |
| Uploads per wedding per day | 60 | same (deleted photos count) |
| Concurrent pending per wedding | 3 | same |
| Upload file | ≤ 15 MB, JPEG/PNG/WebP; ≤ 50 MP | editor check + server decode limits |
| Stored per wedding | ≤ 40 MB (expected ≈ 7.4 MB at 20 photos) | bucket 1 MB/object × 2 × 20 bounds it; `complete_wedding_photo` re-checks |
| Stored in total (free tier) | stop new uploads at **800 MB** of the 1 GB | `create_wedding_photo` (sum over the bucket) |
| Origin downloads per month | stop serving new cache misses at **3 GB** of the 5 GB shared egress | `claim_published_wedding_photo` |

When a breaker trips, uploads say "Las fotos están en pausa por mantenimiento" and uncached photos return 404 while the
site itself keeps working; the operator raises the limit only together with a plan upgrade (Supabase Pro: 100 GB
storage, 250 GB egress). Stored size and delivered bytes are different costs: storage is fixed per photo, delivery
grows with views and is absorbed by Vercel's CDN (Hobby: 100 GB/month of transfer for the whole app).

### 7. Privacy model (proportional and truthful)

- Unpublished or hidden photos: members only (member route, `no-store`). Published photos in visible blocks: anyone
  with the site's address, like the site itself; `noindex`, not discoverable, **not secret**.
- Removal: unpublishing, hiding a block or deleting a photo stops new deliveries at once and purges the CDN copies by
  tag (`revalidateTag`, Next 16 on Vercel: delete by tag); browsers that already loaded a photo may keep showing it up
  to 10 minutes, and **anyone may have saved a copy, which we cannot recall**. The editor and the Terms say exactly
  that. Deleting a photo deletes its stored objects immediately.
- Metadata: re-encoding removes EXIF/GPS/camera data; nothing from the file (name, date, device) is stored.
- The couple is responsible for having the right to publish each photo and for the consent of people shown in it.

### 8. Lifecycle and cleanup (no background jobs)

- Failed or abandoned uploads: `pending` rows older than 15 minutes (and their objects) are deleted by the next upload
  of the same wedding, with the member's session; they are never public (only `ready` photos are served).
- Delete a photo: objects, then the row (member session; retried by the editor; a leftover object without a row is
  never served).
- Replace the cover: upload, then one write moves the cover block to the new photo; the old one stays in the library.
- Unpublish/republish: nothing is copied or moved; the gate is checked on each origin request.
- Wedding or account deletion: rows cascade; objects of rows that no longer exist are removed by an operator
  reconcile query/script (documented in the plan), run after any manual account deletion. No wedding deletion exists in
  the product today.

### 9. Migration path (when the free tiers are outgrown)

Upgrade in place first (Supabase Pro, Vercel Pro: no code change, raise the breakers). Later, the byte origin can move
to another object store (for example Cloudflare R2) by copying `<photo id>/*` objects and changing only
`photo-origin.ts` and the upload step; public URLs, tables and the renderer stay the same. No provider abstraction
layer is built now.

### 10. Threat model (summary)

| Threat | Control |
|---|---|
| Cross-wedding access | RLS on rows; storage policies derive the wedding from the photo row; composite FKs |
| Unpublished photo leaks | Gate re-checked on every origin request; member route `no-store`; no anon storage access |
| Malformed or malicious files, decompression bombs | Size/type caps, magic bytes, pixel limits, full re-encode; delivery re-validation; fixed type, `nosniff`, `default-src 'none'` |
| EXIF/GPS leakage | Re-encode; delivery refuses objects with metadata chunks |
| Free-tier exhaustion taking the whole product down | No direct anon downloads; CDN; query strings refused; storage and origin breakers; per-wedding quotas |
| Credential leakage | No storage credential in the browser; service role only in `photo-origin.ts` (read-only) |
| Error disclosure | Closed reasons, Spanish copy, no bucket/path/provider text |
| SSRF | No URL import of any kind |

### 11. Rollout and reversal

UX-01B2 (storage + cover), UX-01B3 (gallery, carousel, photo with text), UX-01B4 (QA, privacy, quotas, production
smoke), all behind the server flag `WEDDING_SITE_PHOTOS` (default off). Migrations are applied to production before the
code that needs them (QA-03a lesson). Reversal: flag off hides the editor and returns no `site_photos` and 404 for
photo routes; a forward migration can drop the tables after deleting the bucket's objects.

### 12. Alternatives rejected or deferred

Public bucket or anon storage reads (egress bypass, weak revocation); Pinata/IPFS (limits, irrevocable); BYOS
(Google Drive/Photos: Photos `baseUrl`s expire after 60 minutes since the 2025 API change, Drive share links are not
image endpoints, couples would need accounts; deferred indefinitely); storing originals or a 2400 px master; image
transformation services (paid); a join table for multi-block photos; `@dnd-kit/sortable` (LB-20: reordering with
"Mover antes/después" buttons); full site drafts (per-block visibility plus the member preview instead); background
cleanup jobs.

### 13. Implementation decisions (recorded at ratification, 2026-10-22)

Reconciliations of the text above with the platform, none weaker than the decision they refine:

1. **Upload transport.** One member-authenticated `POST /app/weddings/[weddingId]/site/photos/upload` route handler
   (multipart, one photo per request) instead of a Server Action: Server Actions cannot report upload progress and
   default to a 1 MB body. It runs the same checks in the same order (`requireUser` → `requireWeddingMembership` →
   flag) and adds the CSRF check Server Actions do implicitly: the `Origin` header must be present and match the
   request's host; the session cookies are `SameSite=Lax`. The body is refused above 4.5 MB before decoding.
2. **Daily upload count.** "Deleted photos count" needs a durable counter: `private.wedding_photo_upload_days`
   (wedding, UTC day, count), written only by `create_wedding_photo`, no client privilege. It is a rate limit, not
   wedding-planning time, so UTC is correct here.
3. **Stale pending sweep.** Supabase Storage refuses SQL deletes of `storage.objects` ("use the Storage API"). The
   upload request therefore removes the objects of this wedding's stale `pending` rows through the Storage API with
   the member's session first; `create_wedding_photo` then deletes the stale rows. A failed object removal leaves an
   orphan object without a row, which is never served and is removed by the operator reconcile (§8).
4. **Alt text.** A photo without alt text is never public: the public read (`site_photos`) and the origin claim use
   one shared predicate (`private.public_wedding_photos`) that requires `ready`, non-empty alt text and a visible
   block of a published wedding. The editor marks such photos ("Falta la descripción: no se mostrará").
5. **Variants (closed per kind).** `cover`: `standard` (the theme's hero variant decides the treatment, plan §5);
   `gallery`: `grid | masonry`; `carousel`: `standard`; `photo_text`: `image_start | image_end`.
6. **Purge and failures.** Purges use Next 16's `revalidateTag("lb-photo-<id>", { expire: 0 })` (delete semantics on
   Vercel's CDN, no stale copy served) for the affected photos after hiding, removing or deleting them, and for every
   photo of the wedding after unpublishing or changing the address. 404s are `no-store` (a photo made visible is
   served at once; misses cost an invocation, never storage egress).
7. **Renditions.** Long edge `min(1600, source)` and `min(640, source)` (never upscaled), WebP quality 80, stepping
   down to 70 and 60 only if a rendition would exceed the bucket's 1 MB object limit; otherwise the upload fails with
   the closed "No pudimos preparar la foto" error. Delivery validation parses the RIFF container (VP8/VP8L/VP8X, no
   `EXIF`/`XMP `/`ICCP` chunks, long edge within the rendition's bound) without decoding.
8. **Carousel without JavaScript.** The public site ships no client JavaScript (ADR-019). The carousel is a focusable
   CSS scroll-snap region (keyboard arrows scroll it natively, swipe on touch) with "Anterior/Siguiente" as in-page
   links to the neighbouring slide, "3 de 8" text, no autoplay and smooth scrolling only without
   `prefers-reduced-motion`.
9. **Member preview of hidden blocks.** The member preview shows visible blocks normally and hidden ones marked
   "Oculta"; the public read never returns hidden blocks.
10. **Reordering.** "Mover antes / Mover después" buttons call one SECURITY INVOKER function per move that swaps two
    positions under the member's RLS; no drag library (LB-20).

## Consequences

- Photos become wedding-site content under the existing publication gate, at zero incremental cost while the
  breakers hold.
- One narrow, read-only privileged module is added (the sixth; ADR-002 §6).
- Free-tier capacity is finite (plan §2); growth means a paid plan, not a redesign.

## Appendix A — Constitution amendment (ratified 2026-10-22)

Applied to `docs/product/PRODUCT-CONSTITUTION.md` in the same change that marked this ADR Accepted.

1. Header: add "Amended: Wedding site photography (2026-10-22, ADR-022) — curated photos on the published wedding
   website: §8, §10."
2. §8, Phase 2: add "Curated wedding-site photography (ADR-022): one cover photo and up to 20 photos per wedding in
   predefined sections (gallery, carousel, photo with text), processed on the server, quota-limited and shown only on
   a published site."
3. §8, DEFERRED: replace "gallery" with "photo albums, photo backup or post-event photographer delivery".
4. §8 table: replace "Gallery | OUT for now (media storage + privacy cost)" with "Photos (cover, gallery, carousel,
   photo with text) | POST-MVP (Phase 2), ADR-022: curated and limited; never an album or backup".
5. §8 paragraph: replace "Images and media stay deferred with Gallery;" with "Photos are wedding content governed by
   ADR-022, never design;".
6. §10 visibility table: PRIVATE gains "unpublished or hidden photos"; PUBLIC gains "photos in visible sections of a
   published site (anyone with the link can view and download them)".
7. §10, new principle 11: "Photos are processed (re-encoded, metadata removed) before they can be public, limited by
   server-enforced quotas, and served only while their wedding is published. We never promise that a published photo
   can be recalled from people who already saw or saved it."
