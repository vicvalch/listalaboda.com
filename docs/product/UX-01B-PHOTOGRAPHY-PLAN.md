# UX-01B — Wedding site photography: plan, limits and tickets (zero-cost MVP)

Status: **approved** (owner ratification 2026-10-22). Architecture: [ADR-022 (Accepted)](../architecture/ADR-022-wedding-site-photography.md),
including its §13 implementation decisions, which win over this plan where they differ. Photos, including the gallery,
are part of this MVP. Production migrations, storage resources and turning `WEDDING_SITE_PHOTOS` on remain separate,
explicitly approved steps.

## 1. Current architecture inventory (origin/main 9880486)

| Area | Where | Relevant fact |
|---|---|---|
| Public site page | `src/app/boda/[slug]/page.tsx` | `force-dynamic`, `noindex`, one read, identical 404s |
| Public read | `src/lib/wedding-site/public.ts` → `get_published_wedding_site` | published + visible sections + theme/customization |
| Publication | `supabase/migrations/20261005120100_lb_wedding_site_publication.sql` | owner-only slug/publish/unpublish; the slug can change |
| Content | `supabase/migrations/20261005120000_lb_wedding_site_content.sql`, `src/lib/wedding-site/sections.ts` | fixed kinds, plain text, `is_visible` default false, no JSON |
| Design | `src/lib/wedding-site/design/{themes,customization,resolve,colors}.ts` | 5 themes; closed options; presentation only |
| Renderer | `src/components/wedding-site/{WeddingSite,hero,section,parts,styles}.tsx` | Server Components, no client JS; hero variants `simple, editorial, grid, framed, banner` |
| Editor | `src/app/app/weddings/[weddingId]/site/` (`page.tsx`, `SectionForm`, `ThemeSection`, `CustomizeSection`, `PublishForm`, `SlugForm`, `preview/page.tsx`) | status → style → header facts → sections; member-only preview |
| Auth / tenancy | `@/lib/auth/session`, `@/lib/authz/wedding`, `private.is_wedding_member` | owners = collaborators for content; publishing owner-only |
| Privileged modules | ADR-002 §6 (five service-role modules) | ADR-022 proposes a sixth, read-only |
| Storage | `supabase/config.toml` `[storage]` | CLI defaults only; no buckets in migrations; production not inspected |
| Image libs | `node_modules/next/package.json` optionalDependencies | `sharp` 0.35.5 only as Next's optional dependency |
| Proxy | `src/proxy.ts` matcher | excludes `.webp/.png/.jpg…` paths only |
| Headers | `next.config.ts` | `nosniff`, `frame-ancestors 'none'`, `/boda` `X-Robots-Tag: noindex` |
| Hosting | Vercel Hobby, `vercel.json` | 4.5 MB function body limit |
| Drag policy | LB-20 / ADR-013 | `@dnd-kit/core` 6.3.1 pinned; no `@dnd-kit/sortable` |
| Tests | `src/test/` (Vitest), `npm run db:verify`, `e2e/` (Playwright) | golden Classic markup `src/test/__golden__/wedding-site-classic/` |

## 2. Free-tier limits (read 2026-10-22 from the vendors' own pages)

| Provider | Storage | Files | Delivery / month | Requests / ops | Over the limit |
|---|---|---|---|---|---|
| Pinata Free | 1 GB | 500 | 10 GB (dedicated gateway) | 10,000 gateway requests; API 60/min | uploads and dedicated gateway blocked once 25 % over |
| Supabase Free | 1 GB | — | 5 GB uncached + 5 GB cached egress, shared with all API/database traffic | — (max file 50 MB) | grace period, then Fair Use restrictions on the whole organization: pausing, read-only database, 402 responses; lifted next cycle or by upgrading |
| Vercel Blob (Hobby) | 1 GB | — | 10 GB Blob transfer | 10,000 simple ops (cache misses), 2,000 advanced ops (uploads) | Blob unusable for 30 days |
| Vercel Hobby (CDN, functions) | — | — | 100 GB Fast Data Transfer (whole app) | 1 M function invocations; purge by tag 50 calls/s per team | Hobby is "for personal, non-commercial use" |

Sources: [Pinata pricing](https://pinata.cloud/pricing) and [Pinata free plan](https://pinata.cloud/blog/pinatas-new-free-plan/)
(500 files, 10 GB, 10,000 requests), [Pinata limits](https://docs.pinata.cloud/account-management/limits);
[Supabase pricing](https://supabase.com/pricing), [Supabase billing FAQ](https://supabase.com/docs/guides/platform/billing-faq)
(Fair Use restrictions); [Vercel pricing](https://vercel.com/pricing),
[Vercel Blob pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing),
[Vercel CDN purge](https://vercel.com/docs/caching/cdn-cache/purge) (purge on all plans, tag rules). Pinata's comparison
table was partly unreadable; its free figures come from Pinata's own free-plan post and match third-party listings.
Pinata publishes no statement on commercial use of the free plan.

Capacity of the selected design inside free tiers (≈ 370 KB stored per photo: 1600 px ≈ 300 KB + 640 px ≈ 70 KB):

| Measure | Value | Bound by |
|---|---|---|
| Weddings with 20 photos | ≈ 108 | 800 MB storage breaker |
| Weddings with 12 photos (typical) | ≈ 180 | same |
| Page views with photos / month | ≈ 100,000 at ≈ 1 MB per view | Vercel Hobby 100 GB transfer, shared with the app |
| Origin downloads / month | 3 GB (≈ 10,000 distinct renditions re-fetched) | origin breaker, inside Supabase's 5 GB |

For comparison, Pinata Free would hold about 12 full weddings (500 files ÷ 2 renditions ÷ 20) and about 900 typical
page views a month (10,000 requests ÷ 11 images per view).

Beyond the free tiers: Supabase Pro (from $25/month: 100 GB storage, 250 GB egress) and Vercel Pro ($20/month: 1 TB
transfer, commercial use). Storage stays cheap at any scale; delivered bytes are the cost driver (see the previous
revision's simulations, kept in git history of this file).

## 3. Workflow

1. Couple picks photos → the editor checks ≤ 15 MB and type, shows a thumbnail, downsizes in the browser
   (≤ 2400 px, ≤ 4 MB JPEG) and posts each one to the Server Action, at most 3 at a time, with progress.
2. Server: auth + membership + flag → `create_wedding_photo` (quotas, breakers, stale-pending sweep) → magic bytes →
   `sharp` decode with pixel limits → orientation → re-encode 1600/640 WebP without metadata → upload with the member's
   session → `complete_wedding_photo` (sizes from storage) → `ready`.
3. Couple adds alt text, places the photo in the cover or a block, sets the focal point, previews (member route).
4. Guest opens `/boda/<slug>` → `site_photos` from the public read → `<img srcset>` to `/boda/<slug>/fotos/<id>/<size>`
   → Vercel CDN hit, or on a miss `photo-origin.ts` checks the gate and the meter, validates and streams.
5. Unpublish / hide / delete → the gate closes at once; tags `lb-photo-<id>` purged; browsers may keep a copy ≤ 10 min.

## 4. Editor and guest experience

- New card **"Fotos"** in `site/page.tsx` after "Estilo del sitio": **Portada** (one photo, focal point, "Cambiar
  portada", "Quitar"), **Biblioteca** ("12 de 20 fotos", "Subir fotos", alt text, "Eliminar"), **Secciones con fotos**
  (add gallery / carousel / photo with text; variant; "Después de: <sección>"; visible toggle; "Mover antes / Mover
  después" buttons with a polite live region). Predefined components only; no free layout, no drag library.
- New blocks start hidden; the member preview shows hidden blocks marked as such. That is the MVP's "draft".
- A fixed notice near "Publicar" and in "Fotos": "Cualquier persona con el enlace del sitio puede ver y descargar las
  fotos publicadas. Si quitas una foto, deja de mostrarse en pocos minutos, pero no podemos borrar copias que alguien
  ya haya guardado."
- Plain Spanish states and closed errors: "Subiendo…", "Preparando la foto…", "Lista"; "La foto pesa más de 15 MB",
  "Usa una foto JPG, PNG o WebP", "La foto es muy pequeña para verse bien", "Llegaste al límite de 20 fotos",
  "Las fotos están en pausa por mantenimiento", "No pudimos preparar la foto. Inténtalo otra vez."
- Guests: cover in the hero; gallery as a responsive grid; carousel with visible "Anterior/Siguiente", "3 de 8", no
  autoplay, `prefers-reduced-motion`, CSS scroll-snap so it works without JavaScript (swipe comes free on touch).
  Every `<img>` has width/height (no layout shift), `srcset` (640/1600) and `sizes`, `loading="lazy"` except the cover,
  and the couple's alt text; captions as visible text.

## 5. Theme compatibility

Verified keys: `classic, editorial, minimal, romantic, tropical` (`WEDDING_SITE_THEME_KEYS`). Photos inherit the theme
through closed values; no per-photo styling.

| Theme | Cover (hero variant) | Gallery / carousel |
|---|---|---|
| Classic | `simple`: photo above the names; pixel-identical page when there is no cover | plain grid, small radius |
| Editorial | `editorial`: tall photo, serif names below | wide margins, thin rules |
| Minimal | `grid`: photo in the second column | square crops, no radius |
| Romantic | `framed`: photo inside the frame with the flourish | soft radius, airy |
| Tropical | `banner`: photo as banner, names on the band | tiles on the surface color |

Text never sits directly on a photo: it uses a solid band or scrim from palette tokens so WCAG AA holds; custom
colors (CP7) apply to frames and bands as to any surface. UX-01C (after UX-01B4): `floral` first, then `boho`, later
"classic garden" and "romantic editorial" variants, each declaring its photo treatments as closed theme values; no
theme change in UX-01B.

## 6. Terms and Privacy changes required before photos go live (legal review pending)

- Terms: the couple must own or have permission for every photo and the consent of the people shown; published photos
  can be viewed and downloaded by anyone with the link; we cannot recall copies others saved; prohibited content
  (illegal, sexual, violent, others' private data) and our right to remove it; limits (20 photos, 15 MB); a takedown
  request goes to `soporte@listalaboda.com`.
- Privacy: what we store (two processed copies, no originals, no location or camera data), where (our storage and CDN
  providers as processors), who sees it (members; anyone with the link once published), how long (until deleted by the
  couple or the account is removed; CDN copies purged within minutes, browser copies briefly), and guests' requests to
  remove a photo of themselves (via the couple or support).
- The current documents must not be edited in UX-01B; the texts above are inputs for the legal review.

## 7. Required migrations and components (none created yet)

- Migration (UX-01B2): enums `wedding_photo_state`, `wedding_site_photo_block_kind`, variant enum; tables
  `wedding_photos`, `wedding_site_photo_blocks`, `wedding_photo_origin_usage` with RLS and column grants; functions
  `create_wedding_photo`, `complete_wedding_photo` (member, SECURITY INVOKER where possible), `claim_published_wedding_photo`
  (service_role only); storage bucket `wedding-photos` (private, 1 MB, `image/webp`) and its policies (member
  INSERT on own pending names, member SELECT/DELETE for own wedding, no anon); recreated `get_published_wedding_site`
  with `site_photos`. Indexes: `(wedding_id, state)`, `(block_id, position)`, `(wedding_id, anchor, position)`.
- Code: `src/lib/wedding-site/photos/` (service, processing with `sharp`, quotas mapping), `photo-origin.ts`
  (service role, ESLint allow-list entry), the public route and the member route, the proxy matcher exclusion, editor
  components, renderer blocks per theme, `es.site.photos` copy, flag `WEDDING_SITE_PHOTOS`.
- Dependency: `sharp` declared explicitly and pinned (an approved package install in UX-01B2).
- Operator runbook: reconcile query (objects whose photo id has no row → delete), breaker levels, how to raise them.
- No queues, cron jobs, edge functions or new vendors.

## 8. Implementation stages

### UX-01B2 — Secure image storage and cover photo

- **Scope**: §7 migration, upload/process/complete, member route, public route with `photo-origin.ts`, breakers,
  cover block only, cover in the five hero variants, editor "Portada" + "Biblioteca", disclosure copy, flag off.
- **Prerequisites**: amendment ratified; ADR-022 accepted (incl. the sixth module and the ADR-002 §6 note); `sharp`
  install approved; production Supabase plan and bucket absence verified read-only.
- **Rollback**: flag off; forward migration to drop after deleting objects.
- **Acceptance**: a couple uploads a 12 MB phone JPEG and gets a cover with alt text and focal point; the stored
  objects are WebP with no EXIF/GPS (checked by reading them); the cover shows in the member preview before publishing
  and on the public site only after; unpublishing returns 404 on the next uncached request and the CDN copy is purged;
  a member of another wedding cannot read, write or delete it; the Classic golden markup is unchanged without a cover.

### UX-01B3 — Gallery, carousel and photo with text

- **Scope**: block kinds gallery (grid, masonry), carousel, photo_text; captions; anchors; visibility; button
  reordering; library management up to 20; renderer per theme; `site_photos` for all kinds.
- **Prerequisites**: UX-01B2 merged and its migration in production.
- **Acceptance**: 20 photos across cover, a gallery, a carousel and a photo-with-text block; the 21st upload is
  refused by the server even when the UI is bypassed; keyboard reordering announces positions; carousel operable by
  keyboard and without JavaScript, no autoplay, reduced motion respected; first screen of a 12-photo gallery on a
  phone ≤ ≈ 1 MB; no layout shift.

### UX-01B4 — QA, privacy, quotas and production smoke

- **Scope**: the full test matrix (§9), breaker drills, legal texts approved and published, operator runbook, then a
  production smoke with an owner-approved QA wedding and generated test images (no personal photos), flag enabled only
  by explicit approval.
- **Acceptance**: every item in §9 passes; Supabase egress/storage and Vercel transfer dashboards checked after the
  smoke; disclosure visible; the flag can be turned off and photos disappear within the stated window.

## 9. Tests and validations (definition of done for B2–B4)

- Database: RLS matrix (owner, collaborator, outsider, anon) on all tables and storage policies; anon and members
  cannot call `claim_published_wedding_photo`; quotas and breakers under concurrency; `complete_wedding_photo` refuses
  missing objects and reads sizes itself; the claim returns nothing for unpublished, hidden, pending, deleted, foreign
  and wrong-slug ids.
- Processing (Vitest, generated fixtures): EXIF/GPS/XMP removed; orientation applied; oversized, undersized, > 50 MP,
  truncated, wrong-signature and polyglot files refused; delivery validation refuses a member-uploaded WebP with EXIF.
- Route: query string → 404; every failure identical; headers exact; no cookies set; cache tag present.
- E2E: upload → preview → publish → public → unpublish → 404; replace cover; delete; quota messages; reorder by
  keyboard; each theme at 360/390/1280 px, light and dark; Classic golden unchanged.
- Regression: billing, QA personas, site editor, themes and publication flows unchanged (`npm run verify`,
  `npm run db:verify`, the existing Playwright journeys).

## 10. Owner decisions

1. ~~Ratify the Constitution amendment and accept ADR-022.~~ Done 2026-10-22.
2. ~~Accept the read-only sixth service-role module (`photo-origin.ts`).~~ Done 2026-10-22 (ADR-002 §6 later note).
3. Approve the Terms/Privacy texts (§6) after legal review, before UX-01B4's production smoke. **Still open.**

Not blocking but standing: the Vercel team is on Hobby, which Vercel defines as non-commercial; this predates photos
and applies to the whole paid product.
