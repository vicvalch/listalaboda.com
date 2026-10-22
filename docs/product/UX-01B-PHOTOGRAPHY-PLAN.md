# UX-01B — Wedding site photography: plan, costs and tickets

Status: **design only** (UX-01B1, 2026-10-22). Architecture: [ADR-022 (Proposed)](../architecture/ADR-022-wedding-site-photography.md).
Nothing here is implemented or approved. Implementation starts only after the owner ratifies the Constitution
amendment (ADR-022 Appendix A) and accepts ADR-022.

## 1. Current architecture inventory (origin/main 9880486)

| Area | Where | Relevant fact |
|---|---|---|
| Public site page | `src/app/boda/[slug]/page.tsx` | `force-dynamic`, `noindex`, one read, identical 404s |
| Public read | `src/lib/wedding-site/public.ts` → `get_published_wedding_site` | published + visible sections + theme/customization |
| Publication | `supabase/migrations/20261005120100_lb_wedding_site_publication.sql` | owner-only SECURITY DEFINER slug/publish/unpublish; slug can change |
| Content | `supabase/migrations/20261005120000_lb_wedding_site_content.sql`, `src/lib/wedding-site/sections.ts` | fixed kinds, plain text, `is_visible` default false, no JSON |
| Design | `src/lib/wedding-site/design/{themes,customization,resolve,colors}.ts`, migrations `20261022120000`, `20261023120000`, `20261024120000` | 5 themes; closed options; presentation only |
| Renderer | `src/components/wedding-site/{WeddingSite,hero,section,parts,styles}.tsx` | Server Components, no client JS; hero variants `simple, editorial, grid, framed, banner` |
| Editor | `src/app/app/weddings/[weddingId]/site/` (`page.tsx`, `SectionForm`, `ThemeSection`, `CustomizeSection`, `PublishForm`, `SlugForm`, `preview/page.tsx`) | status card → style → header facts → sections; member-only preview |
| Palettes | `src/app/globals.css` (`data-site-palette`) | light/dark CSS variables (has an unrelated local edit in the main worktree) |
| Auth / tenancy | `@/lib/auth/session`, `@/lib/authz/wedding`, `private.is_wedding_member` | membership is the boundary; owners = collaborators for content |
| Privileged modules | ADR-002 §6; five service-role modules | a sixth (media processor) needs approval |
| Storage | `supabase/config.toml` `[storage]` | defaults only; no buckets in migrations; image transformation "Pro plan" |
| Image libs | `node_modules/next/package.json` optionalDependencies | `sharp` 0.35.5 present only as Next's optional dependency |
| Images in UI | `src/components/marketing/{ProductShot,LifestylePhoto}.tsx` | plain `<picture>`/`<img>`, no `next/image` runtime |
| Proxy | `src/proxy.ts` matcher | skips `.webp/.png/.jpg…` paths (no session refresh) |
| Headers | `next.config.ts` | `nosniff`, `frame-ancestors 'none'`, `/boda` `X-Robots-Tag: noindex`; no full CSP |
| Hosting | Vercel (Hobby team), `vercel.json` daily cron | 4.5 MB function body limit; Hobby is non-commercial |
| Drag policy | LB-20 / ADR-013 | `@dnd-kit/core` 6.3.1 pinned; no `@dnd-kit/sortable` |
| Tests | Vitest (`src/test/`), DB tests (`npm run db:verify`), Playwright (`e2e/`) | golden Classic markup in `src/test/__golden__/wedding-site-classic/` |

## 2. Workflow (storage → processing → delivery)

1. Member clicks "Subir foto" → Server Action: `requireUser`, membership, feature flag → `reserve_wedding_media`
   (quotas) → signed upload URL for `wedding-media-incoming/<id>/original` (member session).
2. Browser uploads directly (progress bar; one retry button; max 5 concurrent per wedding).
3. Browser calls "finalize" → Server Action: membership → media processor reads raw → magic bytes → `sharp` decode
   (pixel limit) → rotate → re-encode WebP master 2400 + 1600/960/480 → processor writes `wedding-media/<id>/*` →
   `complete_wedding_media` (sizes from storage) → processor deletes raw.
4. Member sets alt text (required before it can appear publicly), places it in a block, sets focal point, previews
   (member route, `no-store`).
5. Guest opens `/boda/<slug>` → page lists photos from `get_published_wedding_site.site_photos` → `<img srcset>` to
   `/boda/<slug>/fotos/<id>/<rendition>` → Vercel CDN hit, or on a miss the route re-checks publication and streams the
   object (anon key + gated storage policy).
6. Unpublish/hide/delete → new misses 404 at once; cached copies expire within the stated window (ADR-022 §7).

## 3. Editor and guest experience

Placement in the existing editor (`site/page.tsx`): a new card **"Fotos"** after "Estilo del sitio" and before the
text sections, with three parts: **Portada** (one photo, focal point, "Cambiar portada", "Quitar"), **Biblioteca**
(the up-to-20 photos, counter "12 de 20 fotos", "Subir fotos", per photo alt text and "Eliminar" with the list of blocks
using it), and **Bloques de fotos** (add gallery / carousel / photo with text; per block: variant, anchor "Después de:
<sección>", visibility toggle, items, "Mover antes / Mover después").

- Predefined components only; no free layout. Reordering with buttons and the keyboard first (LB-20); each move
  announces the new position in one polite live region.
- Focal point: click/tap on the photo or arrow keys move a marker (0–10000 grid, like the seating board); the preview
  shows the crop in desktop and phone frames side by side (the existing preview renders the real `WeddingSite`).
- "Drafts": every new block is hidden until the couple turns it on; the member preview shows hidden blocks marked as
  such. Saved and visible = live, like text today. Full site drafts stay a separate decision.
- Upload states in plain Spanish: "Subiendo… 40 %", "Preparando la foto…", "Lista", and closed failures: "Esta foto
  pesa más de 15 MB", "Usa una foto JPG, PNG o WebP", "La foto es muy pequeña para verse bien", "Llegaste al límite de
  20 fotos", "No pudimos preparar la foto. Inténtalo otra vez." Never an internal message.
- Slow networks: direct upload with progress, no page reload; an interrupted upload expires on its own (30 min).
- Guest side: cover in the hero (theme-dependent treatment), gallery as a responsive grid (2 columns phone, 3–4
  desktop), carousel with visible "Anterior/Siguiente" buttons, position "3 de 8", no autoplay, swipe only as
  progressive enhancement, `prefers-reduced-motion` respected, works without JavaScript as a scrollable list
  (CSS scroll-snap). Every `<img>` has width/height (no layout shift), `srcset`/`sizes`, `loading="lazy"` except the
  cover (`fetchpriority="high"`), and the couple's alt text; captions as visible text.

## 4. Theme compatibility (the five current themes)

Verified keys: `classic, editorial, minimal, romantic, tropical` (`WEDDING_SITE_THEME_KEYS`). Photos inherit the
theme through closed presentation values, never per-photo styling:

| Theme | Cover (by hero variant) | Gallery / carousel framing |
|---|---|---|
| Classic | `simple`: photo above the names, full content width; Classic stays pixel-identical when there is no photo | plain grid, small radius |
| Editorial | `editorial`: tall photo with names below, serif display | wide margins, thin rule between blocks |
| Minimal | `grid`: photo in the grid's second column | square crops, no radius, ruled |
| Romantic | `framed`: photo inside the frame with the flourish | soft radius, airy spacing |
| Tropical | `banner`: photo as banner, names on the band | tiles on the surface color |

- Text over photos only where the overlay contrast can be guaranteed (a solid band or scrim using palette tokens;
  never text directly on an unknown photo). Captions use the palette's text/muted tokens (WCAG AA as today).
- Custom colors (CP7) apply to frames and bands the same way as to text surfaces.
- A future theme declares its photo treatments in its `ThemeDefinition` (closed values), like hero variants today.

## 5. Quotas and cost simulations

Rendition sizes (estimates for typical photos, WebP): master 2400 px ≈ 600 KB, 1600 ≈ 300 KB, 960 ≈ 130 KB,
480 ≈ 45 KB → **≈ 1.08 MB stored per photo**; 20 photos ≈ 21.5 MB (cap 40 MB). Typical wedding assumed 12 photos
(≈ 13 MB). Provider replication is internal and not billed separately.

Traffic assumptions per wedding per month (only weddings with a published site):

| Scenario | Views / wedding / month | Image requests / view | Bytes / view |
|---|---|---|---|
| Conservative | 50 | 3 (cover + 2 thumbs, phone) | 0.3 MB |
| Typical | 300 | 11 (cover 960 + 8 × 480 + 2 × 1600) | 1 MB |
| High | 3,000 | 25 (desktop, whole gallery at 1600) | 3 MB |

Volumes (`egress = weddings × views × bytes`; stored at 13 MB typical / 40 MB cap):

| Weddings | Photos (typ.) | Stored typ. / cap | Requests / month (typ.) | Transfer cons. / typ. / high |
|---|---|---|---|---|
| 100 | 1,200 | 1.3 GB / 4 GB | 0.33 M | 1.5 GB / 30 GB / 0.9 TB |
| 1,000 | 12,000 | 13 GB / 40 GB | 3.3 M | 15 GB / 300 GB / 9 TB |
| 10,000 | 120,000 | 130 GB / 400 GB | 33 M | 150 GB / 3 TB / 90 TB |

Published prices used (read 2026-10-22; "starting at" prices may be tiered; recheck before deciding):
Vercel Pro $20/month, 1 TB Fast Data Transfer included, then from $0.15/GB, Hobby "personal, non-commercial use"
([vercel.com/pricing](https://vercel.com/pricing)); Supabase Pro from $25/month, 100 GB storage included then
$0.0213/GB, 250 GB egress included then $0.09/GB, cached egress $0.03/GB, image transformations 100 origin images
included then $5 per 1,000; Free: 1 GB storage, 5 GB egress, no image transformations
([supabase.com/pricing](https://supabase.com/pricing)); Smart CDN on Pro and above, invalidation up to 60 s, "revoking
or expiring a token does not purge its CDN cache entry" ([Smart CDN docs](https://supabase.com/docs/guides/storage/cdn/smart-cdn));
Cloudflare R2 $0.015/GB-month, egress free, Class B $0.36 per million ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)).

Incremental monthly cost on the selected design (Vercel CDN in front; Supabase origin egress ≈ cache misses, assumed
10 % of transfer), on top of the two plan bases (~$45/month, needed for a commercial launch regardless of photos):

| Weddings | Conservative | Typical | High |
|---|---|---|---|
| 100 | ≈ $0 | ≈ $0 | ≈ $0 (0.9 TB < 1 TB included) |
| 1,000 | ≈ $0 | ≈ $0 | ≈ $1,200 transfer + ≈ $60 origin |
| 10,000 | ≈ $0 | ≈ $300 transfer + ≈ $5 origin + ≈ $1 storage | ≈ $13,000+ transfer + ≈ $800 origin |

Reading: storage is negligible at every scale (≤ $10/month even at the 400 GB cap); **delivered bytes drive cost**.
"High" for every wedding is a stress bound, not a forecast; the realistic risk is a few viral sites (one wedding with
100,000 views × 3 MB ≈ 300 GB). At ~10,000 weddings or sustained high traffic, moving the byte origin to R2 behind
Cloudflare (egress free; ≈ $2 storage + ≈ $12–270 requests in the table's volumes) is the planned exit, enabled by the
ADR-022 §9 seams; it needs a domain/DNS decision and a way to keep the publication re-check (edge function or
short-lived tokens), so it is not free to build.

Runaway-bill safeguards: Supabase spend cap on, Vercel spend management with an alert at a fixed monthly amount, a
firewall rate limit on `/boda/*/fotos/*`, quotas (ADR-022 §8), and a monthly review of stored GB, transfer and the top
weddings by image requests.

## 6. Tickets

### UX-01B2 — Cover image MVP

- **Scope**: buckets, `wedding_media`, blocks/items tables (cover only enabled), reserve/complete RPCs, storage
  policies, media processor module, upload/finalize actions, member media route, public delivery route,
  `site_photos` in the public read (cover only), cover in the five hero variants, editor "Portada" with focal point
  and alt text, reconcile script, feature flag `WEDDING_SITE_PHOTOS` (off by default).
- **Prerequisites**: Constitution amendment ratified; ADR-022 accepted (incl. the sixth service-role module and the
  ADR-002 §6 note); plan decisions in §7; `sharp` added as an explicit pinned dependency (approved package install);
  hosting plans decided.
- **Migrations**: enums, three tables with RLS and grants, quota RPCs, storage buckets + policies, recreated
  `get_published_wedding_site` (+ `site_photos`), `get_published_wedding_photo`. Applied to production BEFORE the
  code deploy, with dry-run and backup (QA-03a lesson).
- **Security tests**: §14 of ADR-022 for cover paths; anon/outsider/collaborator matrices; EXIF fixture removal;
  polyglot/oversize/bomb refusal; storage write attempts by members on `wedding-media`; 404 equivalence.
- **Functional tests**: upload/replace/remove cover; focal point persists; preview shows unpublished cover; public page
  shows it only when published; Classic golden unchanged without a cover; each theme with a cover in light/dark at
  360/390/1280 px; no layout shift.
- **Rollback**: flag off (hides editor and public photos); forward migration to drop; reconcile deletes objects.
- **Acceptance**: a couple uploads a phone photo, sets alt text and focal point, previews, publishes, a guest sees the
  cover on a phone in under one image request per size, unpublishing removes it within the stated window.
- **Deploy dependencies**: storage buckets exist in production; spend caps/alerts set; flag enabled per environment
  by explicit approval.

### UX-01B3 — Gallery, carousel and photo with text (committed phase, follows UX-01B2)

- **Scope**: library UI (up to 20), block kinds `gallery` (grid/masonry), `carousel`, `photo_text`, captions, anchors,
  visibility, button reordering, delete-with-usages, public rendering for the five themes.
- **Prerequisites**: UX-01B2 in production and stable for at least one release; reconcile run once.
- **Migrations**: enable the extra kinds/variants; reorder RPC; `site_photos` extended to all kinds.
- **Security tests**: cross-wedding block items refused (composite FKs); hidden blocks never in the public read; a
  photo removed from all visible blocks 404s; quota counts a photo once across blocks.
- **Functional tests**: create each block, reorder with keyboard, caption, hide/show, delete a photo used twice; carousel
  without JS, reduced motion, screen-reader labels; Lighthouse-style checks for CLS and lazy loading.
- **Rollback**: flag per block kind off; data stays.
- **Acceptance**: a gallery of 12 photos loads on a phone at ≤ ~1 MB for the first screen; carousel fully operable by
  keyboard; no autoplay.

### UX-01C — Themes (after UX-01B3, or in parallel only for non-photo work)

- **Scope**: `floral` first, then `boho`; later candidates "classic garden", "romantic editorial" variants. Each theme
  defines its photo treatments as closed values; quality bar beyond colors: typography pairing, ornament, section
  rhythm, photo framing, light/dark AA, phone layouts.
- **Prerequisites**: ADR-019 rules; photos available to design the treatments; clean worktree (never stage the
  unrelated `globals.css` local edit).
- **Migrations**: add the enum value and extend the CHECK validator's per-theme options.
- **Tests**: AA unit test over palettes, golden Classic unchanged, theme snapshot per viewport, DB/app options parity.
- **Rollback**: a theme key is never removed; a broken theme gets fixed forward.

## 7. Owner decisions still open

1. Ratify the Constitution amendment (ADR-022 Appendix A) and accept ADR-022.
2. Accept the sixth service-role module (media processor) or choose another write authority.
3. Hosting plans: Vercel Pro (Hobby is non-commercial) and Supabase Pro (Free has 1 GB storage, no Smart CDN, no
   transformations). The production Supabase plan was not verified in UX-01B1.
4. Revocation window: `max-age=300, s-maxage=600` (recommended) vs `no-store` (instant, higher cost).
5. Limits in ADR-022 §8 (20 photos, 15 MB raw, 40 MB stored, 5 concurrent, 60/day).
6. HEIC/AVIF input (not in the MVP: the prebuilt `sharp` decoder set and patents make HEIC uncertain; iOS usually
   uploads JPEG from the browser).
7. Whether photos are part of the paid entitlement or free for every site (no gating exists today; gating is a
   separate decision, ADR-021).
8. Legal text: Terms/Privacy updates for photo content, guest likeness and removal (pending legal review).
9. Orphan cleanup: operator script only, or a scheduled job (another privileged authority).
10. Whether full site drafts are needed beyond per-block visibility.
