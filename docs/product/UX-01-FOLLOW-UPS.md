# UX-01 follow-ups: site media (UX-01B) and more themes (UX-01C)

Status: **documented, not implemented.** UX-01A (brand and navigation labels) shipped without any of this. Each item
below needs its own explicit approval; UX-01B also needs a Constitution amendment and a new ADR first.

Brand reminder (owner-confirmed): "Lista la boda" means *the wedding is ready*. It is not "a list". Navigation uses
"Mi boda" for a couple's wedding home, "Pendientes" for the checklist, "Invitados" for guests and "Sitio web" for the
couple-facing site editor.

## Where things stand (2026-10-22)

- Public site: `/boda/[slug]` renders `WeddingSite` (`src/components/wedding-site/`) from two inputs side by side:
  content (`PublishedWeddingSite`: name, date, city, visible sections) and design (`ResolvedSiteDesign`). The only
  public read is `get_published_wedding_site(slug)`, gated by `wedding_publications.published_at` + `is_visible`.
- Content: `content_sections`, one row per fixed kind (`intro, ceremony, reception, schedule, dress_code, faq, rsvp`),
  plain text only, fixed public order (LB-10). No reordering, no custom kinds.
- Design (ADR-019): five code-defined themes (`WEDDING_SITE_THEME_KEYS` = classic, editorial, minimal, romantic,
  tropical) in `src/lib/wedding-site/design/themes.ts`; per-theme closed options; custom colors (six AA-checked
  `#rrggbb`); persisted in `wedding_site_designs` (`theme_key` enum + `customization` jsonb, CHECK-validated).
  Palettes are CSS variables in `src/app/globals.css`, scoped by `data-site-palette`.
- Media: **none.** The Constitution keeps Gallery OUT ("media storage + privacy cost"); ADR-019 §7 defers images and
  requires a separate ADR (storage, metadata stripping, publish-gated serving). No Supabase Storage bucket is used
  (local `[storage]` is just the CLI default), no image library is installed and `next/image` is not used on the site.
- Dependencies relevant later: `@dnd-kit/core` 6.3.1 is pinned exactly; LB-20 forbids `@dnd-kit/sortable` and other
  drag libraries, so reorderable media would need that decision revisited (or a button-based reorder).
- Security headers: `next.config.ts` sets `frame-ancestors 'none'`; no full CSP yet, so `img-src` must be designed
  together with any media serving.

## UX-01B: photo blocks, cover image, carousel, gallery, safe upload

> **Superseded by UX-01B1 (2026-10-22):** the owner made photography a core product feature. The architecture is
> [ADR-022 (Accepted 2026-10-22)](../architecture/ADR-022-wedding-site-photography.md) and the stages (UX-01B2 cover, UX-01B3 gallery/carousel/photo-text, UX-01B4 QA and smoke), free-tier limits and open decisions are in
> [UX-01B-PHOTOGRAPHY-PLAN.md](UX-01B-PHOTOGRAPHY-PLAN.md). The notes below are kept as the original sketch.

Decisions needed before code (in this order):

1. **Constitution amendment**: move Gallery (or a narrower "site photos") from OUT to IN, with the privacy cost stated.
2. **New ADR (media)**, covering at least:
   - Storage: a private Supabase Storage bucket, never public-by-URL; objects keyed by wedding id + random id, never
     by file name. RLS on `storage.objects` from wedding membership (owners and collaborators, like content).
   - Schema: a `wedding_site_media` table (wedding-scoped, RLS in the same migration) with id, wedding, storage path,
     dimensions, byte size, MIME type, alt text (required, plain text), created_by and timestamps. Never a user URL.
   - Upload safety: server-side size and type allowlist (JPEG/PNG/WebP), decode and re-encode to strip EXIF/GPS
     (adds an image dependency such as `sharp`: its own approval), per-wedding quota, no SVG.
   - Serving: publish-gated. The public page may only show media of a published wedding in a visible section, via
     short-lived signed URLs or an app proxy route, `noindex`, no hotlinkable permanent URLs. Unpublishing hides them.
   - Placement: either a new fixed section kind (`gallery`, amends LB-10's closed kind set) and a `cover` slot in the
     hero, referencing media ids (never content text inside design, per ADR-019).
   - Ordering: a stored `position` per media row; reordering by explicit buttons first (accessible, no new drag
     library), drag later only if the LB-20 rule is amended.
   - Deletion: wedding → cascade (rows and objects); orphan cleanup for objects whose row is gone.
3. **UX**: cover image in hero variants that support it; a responsive gallery grid; a carousel only as progressive
   enhancement (works without JS as a list, respects `prefers-reduced-motion`). Alt text is mandatory.

Recommended first slice: ADR + Constitution amendment only, then a cover image (one per wedding) before any gallery.

## UX-01C: more reusable themes (floral, boho, and refinements)

Fits ADR-019 without a new ADR:

- Already exist: classic, minimal (minimalist), romantic. New keys: `floral`, `boho`.
- Each new theme = a new `WEDDING_SITE_THEME_KEYS` entry (keys are never removed) + `ThemeDefinition` of closed values
  + palette presets in `globals.css` (light and dark, WCAG AA 4.5:1, tested) + `es.site.themes` copy + a migration
  adding the value to the `wedding_site_theme` enum and to the CHECK validator's per-theme option list.
- Decorations must be CSS-only, `aria-hidden`, information-free; no images until UX-01B lands (so "floral" means
  palette, typography and CSS ornament, not photos). System font stacks only (self-hosted fonts are deferred).
- Classic stays pixel-identical (golden tests in `src/test/__golden__/wedding-site-classic/`).
- Note: `src/app/globals.css` has an unrelated local modification in the main worktree; theme work must start from a
  clean worktree and never stage that file by accident.

Recommended first slice: the `floral` theme alone (enum migration + definition + palettes + tests), then `boho`.
