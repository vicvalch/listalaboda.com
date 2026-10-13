# ADR-019 — Wedding Site Design and Themes

Status: Accepted (Wedding site themes, CP0–CP7) · Date: 2026-10-12
Related: [Product Constitution §8, §10.9](../product/PRODUCT-CONSTITUTION.md), [ADR-001](ADR-001-product-domain-and-tenancy.md),
[ADR-002 §7](ADR-002-auth-and-security-boundaries.md), [ADR-003](ADR-003-donor-extraction-policy.md),
[ADR-017](ADR-017-dual-couple-planner-use.md)

## Context

LB-10 shipped one public presentation of the wedding website (`/boda/[slug]`): a fixed layout over the safe projection
`get_published_wedding_site` (name, date, city, visible sections). Couples want the site to look like their wedding,
and planners will want reusable looks. A spike evaluated an external visual page builder (PageHub SDK); it could keep
wedding data out of its documents, but only after cutting it down to a few primitives and sanitizing its raw-HTML text,
and its editor depends on external calls. For curated themes and guided customization an internal theme system is
safer and simpler. No spike code is reused.

## Decision

### 1. Content, publication and design are separate authorities

- **Wedding** stays the tenancy and security boundary. Design never changes who can read or write anything.
- **`content_sections`** stays the content authority: texts and per-section visibility.
- **`wedding_publications`** stays the only publish gate: slug and `published_at`, owner-only, unchanged.
- **Design** (`wedding_site_designs`, added in a later checkpoint) is presentation only: which theme, and later a
  closed set of customizations. It stores no wedding data (no names, dates, places, section text), no guest data and
  no RSVP capability. Changing the design never copies, rewrites or duplicates wedding data.

The renderer receives two separate inputs, never merged at rest: the content DTO (`PublishedWeddingSite`, unchanged)
and a resolved design (`ResolvedSiteDesign`).

### 2. Themes are code, selected by a closed key

A theme (`ThemeDefinition`, `@/lib/wedding-site/design/themes`) is a code-owned set of closed presentation values:
palette, typography pairing, heading scale, hero variant, width, density, alignment, section style and ornament. The
registry (`THEME_REGISTRY`) maps every `WeddingSiteThemeKey` to one definition. Themes hold no copy (Spanish labels live
in `es.ts`), no user input and no CSS, class name, markup or URL strings: the renderer (`WeddingSite` and its hero and
section variants) maps each value to its own markup, and `styles.ts` is the only place values become class names.
Ornaments are static inline SVG in the renderer.

A palette is a set of CSS variables in `globals.css`, scoped by `data-site-palette` on the page's `<main>`, with a light
and a dark variant that follows the visitor's preference. Inside the page it overrides the app color tokens, so the
same token classes draw every theme. Fonts are system stacks; self-hosted web fonts would be a separate decision, and
never a runtime third-party request. Every theme's text meets WCAG AA (4.5:1) in both variants, and decorations are
`aria-hidden` and carry no information.

The initial curated set (CP3) and its values:

| Theme | Palette | Typography | Heading scale | Hero | Width | Density | Alignment | Sections | Ornament |
|---|---|---|---|---|---|---|---|---|---|
| Classic | `app` | `system` | `regular` | `simple` | `regular` | `regular` | `center` | `plain` | `none` |
| Editorial | `ivory` | `serif` | `display` | `editorial` | `narrow` | `airy` | `center` | `editorial` | `rule` |
| Minimal | `mono` | `sans` | `compact` | `grid` | `wide` | `compact` | `start` | `ruled` | `none` |
| Romantic | `rose` | `italic` | `display` | `framed` | `regular` | `airy` | `center` | `centered` | `flourish` |
| Tropical | `sand` | `mixed` | `display` | `banner` | `regular` | `compact` | `start` | `tiles` | `frond` |

Keys are never removed (a retired theme still renders), so a stored choice always resolves. Theme refinements apply to
every wedding using the theme; a breaking redesign ships as a new key. No theme version is stored until pinning is
actually needed.

### 3. No design state = Classic

`classic` is the original LB-10 page, extracted without visible change: the same markup, spacing, column width,
system font, global color tokens and light/dark behavior. A wedding without design state, and any unknown or invalid
key, resolves to Classic (`resolveSiteDesign`), in the database (`coalesce`) and again in the application. No backfill.

### 4. Persistence: a separate `wedding_site_designs` table (CP4)

One row per wedding (`wedding_id` primary key, `ON DELETE CASCADE`), `theme_key` as a closed database enum. Not columns
on `wedding_publications`: that table is owner-only with no client write grants and exists only once a slug is chosen,
while a theme is presentation that any member may choose before an address exists. The public read adds only the
theme (and, later, the validated customization) to `get_published_wedding_site`, under the existing `published_at`
gate, with no ids or timestamps. This is the explicit product decision LB-10 requires for adding a public field.

Implemented in CP4 (`20261022120000_lb_wedding_site_designs.sql`): the enum `wedding_site_theme`; the table with only
`wedding_id`, `theme_key` (default `classic`) and timestamps; member RLS for select/insert/update with column grants
(only `theme_key` is updatable, so a design never moves between weddings) and no delete (resetting = choosing
Classic); the SECURITY INVOKER `save_wedding_site_design` upsert; and `get_published_wedding_site` recreated with one
more column, `site_theme = coalesce(theme_key, 'classic')`. The application reads it as a design next to the content
(`{ site, design }`) and falls back to Classic for a missing or unknown value, so an older database or a newer key
never breaks a page.

### 5. Authorization and lifecycle

- Owners and collaborators may change the design (same as content sections): membership checked in the service, then
  member RLS on a SECURITY INVOKER write. Publishing and unpublishing stay owner-only and unchanged.
- A saved design change on a published site applies immediately, like LB-10 content edits. A member-only preview is
  the safety step before saving. No drafts or versions yet; they arrive only with advanced custom mode.
- The preview (CP5) is a member-only page (`/app/weddings/[id]/site/preview?theme=<key>`, `noindex`) that draws the
  site with the public renderer from data the member already reads through RLS: the wedding's name, date and city and
  its visible sections, shaped by the same `toPublishedSite` as the public read (`toPreviewSite`). It works before
  publishing, never writes, and never uses or widens the public projection. An unknown `?theme=` shows the current
  theme. The selector's thumbnails are the same renderer, scaled, `aria-hidden` and `inert`; no iframe. Since CP6 it
  also previews unsaved customization choices (§9).
- No activity events (ADR-008's scope is unchanged).

### 6. Customization contract

Allowed, each as a closed value (CP6 implements the subset in §9–§10, CP7 the hex colors in §11; self-hosted fonts stay later): theme, preset palettes, hex colors (`#rrggbb` only, contrast-checked), curated
font pairings (self-hosted, never a family string), heading scale, hero variants allowed by the theme, widths, density,
alignment, section styles. Always forbidden: arbitrary HTML, Markdown or rich text in design; CSS strings or
`style` input; class name input; JavaScript, event handlers, scripts, iframes or embeds; arbitrary URLs; guest data;
RSVP capabilities; wedding domain data. Customizations are validated on write (application parser), in the database
(CHECK) and again on render, where anything invalid falls back to the theme's defaults.

### 7. Deferred, each needing an explicit decision

- **Images and media**: no uploads, storage, image URLs or media schema. A separate ADR must cover storage, metadata
  stripping and publish-gated serving first (the Constitution keeps Gallery out).
- **Section reordering**: not part of CP6; it requires an explicit amendment of the LB-10 rule (public order = the
  fixed kind order). Visibility stays in `content_sections` either way.
- **Planner presets**: a reusable design owned by its author, applied by copying it into a wedding's design through the
  normal member write; never live-linked, and granting nothing on the wedding.
- **Custom design**: the same closed, versioned schema (`schemaVersion`) with every option explicit, referencing section
  kinds, never section content. Not an arbitrary node tree, and never user code.

### 8. Rendering

`/boda/[slug]` keeps its single public read, metadata, `noindex`, `force-dynamic` and identical 404 rules. It resolves
the design and renders `WeddingSite` as a Server Component: no client JavaScript and no third-party requests. The RSVP
section stays guidance only in every theme: no form, guest lookup, `/rsvp` link or guest-specific call to action.

### 9. Safe customization V1 (CP6)

A wedding may override, among the options its THEME offers, eight presentation values: palette preset, type pairing,
heading scale, hero variant, width, density, alignment and section style. The ornament is the theme's and never
changes. Every option is a closed key; nothing is free-form (no hex, CSS, class names, fonts, URLs or text).

- **Registry = capabilities.** `ThemeDefinition` keeps its defaults (what an uncustomized site draws) and adds
  `options`: per field, the theme's default first, then the alternatives that keep its character. A field with one
  option is fixed (Minimal's and Romantic's alignment). Hero variants are not offered everywhere (the framed hero is
  Editorial's and Romantic's; the band and tiles only Tropical's, whose palettes define their colors). The organizer
  controls, the parser and the preview read only this list; the database mirrors it, and a test compares the two value
  by value.
- **Palettes.** Each theme offers its own palette and two presets (Classic: warm, slate; Editorial: parchment, charcoal;
  Minimal: stone, ink; Romantic: wine, champagne; Tropical: forest, sunset), as CSS variables in `globals.css` with a
  light and a dark variant. The key is stored, never a color. Every text color passes WCAG AA (4.5:1) against its
  background in both schemes (unit test over the stylesheet; browser check per preset).
- **Stored document.** `wedding_site_designs.customization jsonb not null default '{}'`, overrides only, versioned:
  `{"schemaVersion":1, "palette":{"kind":"preset","key"}, "typography":{"pairing","headingScale"},
  "hero":{"variant"}, "layout":{"width","density","alignment","sectionStyle"}}`. Every group is optional and never
  empty; `{}` means no overrides. Resolved values are never stored; a choice equal to the theme's default is not an
  override and is dropped.
- **Three validation layers.** (1) `parseCustomization` on write, strict: refuses the whole document for an unknown
  key, a wrong or missing version, a non-object group (array, string, null), an empty group, an extra nested key, a
  palette that isn't `{kind: "preset", key}`, or any value outside the theme's options. (2) The CHECK
  `private.wedding_site_customization_is_valid(theme_key, customization)`: the same rules, for every writer, including a
  direct theme change that would leave an unsupported override. Executable by `authenticated` only because a CHECK runs
  with the writer's privileges (members write through SECURITY INVOKER); the `private` schema is not exposed by the
  Data API, so no client can call it as an RPC. This grant is an accepted decision (CP6 review): do not make the save
  RPC SECURITY DEFINER just to avoid it. (3) `readCustomization` / `resolveSiteDesign` before every render,
  lenient: anything that isn't a version-1 document is no customization; a field outside the theme's options keeps the
  default; an unknown theme is uncustomized Classic. A bad row never breaks a page.
- **Size cap: 1024 bytes** of JSON text, checked first. The largest valid version-1 document is about 300 bytes, so
  the cap leaves room without inviting abuse; the ~8 KB envisaged for a future custom mode is not needed while every
  value is a short closed key, and a later schema version raises it in its own migration.
- **One write path.** `save_wedding_site_design(wedding, theme, customization)` saves both together (the 2-argument
  CP4 form is replaced). Owners and collaborators; publishing stays owner-only; a saved change on a published site is
  live at once. No new activity events.
- **Resolution.** `resolveSiteDesign(themeKey, overrides)` returns the same complete, closed `ResolvedSiteDesign`
  (no optionals, no raw JSON or user strings); the renderer is unchanged.
- **Preview.** `?theme=<key>&customize=1&<field>=<key>…`: closed values only, one parameter per override, each checked
  against the theme (anything else is the default, never echoed). Without `customize=1` the preview shows what choosing
  that theme would keep (§10). Never JSON in the URL; never a write.

### 10. Theme change and reset (CP6)

- Choosing another theme KEEPS only the overrides the new theme also offers; any other falls back to the new theme's
  default and is removed from the stored document in the same save, so stored state never accumulates invalid
  overrides (the CHECK would refuse it anyway). Palette presets belong to one theme, so a palette never carries over.
  The member is told when choices were dropped. Example: Romantic with an editorial hero → Minimal: the hero becomes
  Minimal's grid; a regular density stays.
- Reset one group (palette, typography, hero, layout) removes it from the STORED customization; reset all stores `{}`.
  The theme never changes (resetting never goes back to Classic). Unsaved choices in the form play no part.

### 11. Custom colors (CP7)

A wedding may set six semantic colors instead of a palette preset. Still a closed, validated presentation value: never
CSS, a class name, a variable name, a function or a URL.

- **Contract.** An optional `colors` group in the SAME version-1 document (compatible: every CP6 document stays valid
  and means the same): `{"background","surface","text","muted","accent","accentText"}`. All six or none: a partial
  palette is invalid, absent means the preset/theme palette. Each value is exactly `#` + six LOWERCASE hex digits
  (7 characters). Refused everywhere: 3/4/8-digit hex, uppercase, whitespace or newlines, named colors, `rgb()`,
  `hsl()`, `color()`, `var()`, `currentColor`, `transparent`, `url()`, gradients, any function or markup, and
  non-strings. Documents are never normalized; only the form layer lowercases an uppercase code (`#A1B2C3`), repairing
  nothing else (no trimming, no added `#`, no short forms).
- **Presets.** `palette` and `colors` are mutually exclusive (refused together by the parser and the CHECK). Saving
  custom colors removes the preset; choosing a preset removes the colors; there is never contradictory palette state.
- **Contrast (WCAG AA, 4.5:1)** for every text/background pair the renderer draws with custom colors: text and muted
  on background and on surface; accent on background and on surface (Romantic's and Tropical's accent headings);
  accentText on accent. The same WCAG 2.x luminance formula, pairs and threshold in `colors.ts` (`CONTRAST_PAIRS`) and
  in the database validator; a DB test compares the two on 3,000 generated palettes and at the 4.5 boundary.
- **Theme surfaces are derived, not guessed.** In light mode the custom colors replace every site token by fixed
  mappings onto checked pairs: Tropical's tiles draw on the surface (`--accent-soft` = surface), its band is the accent
  with accent text (`--site-band`/`--site-band-text`), the focus ring is the accent. Borders (a `color-mix` of muted and
  background) and ornaments (muted) are decorative and `aria-hidden`. Because every theme draws the same roles, every
  theme accepts custom colors.
- **Light mode only.** `globals.css` applies the custom properties under `@media not (prefers-color-scheme: dark)`;
  with a dark preference nothing custom applies and the theme's OWN palette (its `data-site-palette`, which stays on the
  page) draws its normal dark variant. No dark palette is inferred or generated. The organizer form says so.
- **Rendering safety.** The renderer never emits user-authored style strings. `resolveSiteDesign` re-validates the
  palette (shape, format, contrast); `customColorStyle` builds a style object whose six property names are constants
  (`--site-custom-background`, …) and whose values are checked again against `^#[0-9a-f]{6}$`. A canonical hex string
  can't end a declaration, add a property or a selector, or reach a class, `href`, `src` or text. (A future nonce-based
  CSP must allow style attributes, e.g. `style-src-attr 'unsafe-inline'`, or move these six values into a nonce'd
  `<style>`; the values stay the same closed set.)
- **Validation.** (1) `parseCustomization`: closed reasons `invalid_customization`, `invalid_color`,
  `insufficient_contrast` (the service returns `invalid` / `invalid_color` / `insufficient_contrast`; nothing else
  leaves it). (2) The CHECK validator (`20261024120000_lb_wedding_site_custom_colors.sql`, replaced in place, same
  signature and privileges): exact keys, exact shape, contrast, mutual exclusion, the unchanged 1024-byte cap (the
  largest valid document is now about 450 bytes). (3) Render time: a stored palette that isn't complete, canonical and
  AA-compliant, or that sits next to a preset, is ignored WHOLE (the saved preset or the theme's palette applies);
  never part of a palette.
- **Preview.** `palette=custom` plus six fixed parameters (`colorBackground`, …), each a canonical color (7 characters,
  no repeats), the palette checked for contrast; anything else is ignored whole. Never JSON; never a write.
- **Theme change.** Custom colors carry over unchanged to any theme (same roles, same checks). **Reset.** "Restablecer:
  Colores personalizados" removes them (the theme's palette applies: the preset was cleared when the colors were
  saved); "Restablecer todo" stores `{}` and keeps the theme.
- **Organizer UX.** "Colores personalizados" is one more palette option; it opens six labelled colors, each a native
  picker plus the visible `#rrggbb` code the form sends. Contrast problems are shown live next to the fields (with the
  current ratio as secondary text), tied to them with `aria-describedby`/`aria-invalid` and summarized in one polite
  status; preview and save are disabled while the palette is invalid, and the server refuses it anyway.

## Consequences

- New themes are additive: a key, a definition, the variants it needs, tests.
- The public projection gains presentation fields only, under the existing publication gate.
- Design data can never become a second source of wedding truth, because it has no field that could hold it.

## Implementation checkpoints

- **CP0**: this ADR and the product rules.
- **CP1**: the theme types, registry, resolver and renderer, with Classic as the only theme and pixel/markup parity with
  the LB-10 page. No migration.
- **CP2**: the shared presentation vocabulary and primitives, and the Editorial and Minimal themes, in code only. The
  public page still always renders Classic: nothing stores or selects a theme. No migration.
- **CP3**: the Romantic and Tropical themes, completing the initial set of five, in code only. No migration.
- **CP4**: `wedding_site_designs`, the member save RPC and the theme in the public read; `/boda/[slug]` renders the
  stored theme. No organizer UI.
- **CP5**: "Estilo del sitio" in the site editor (one card per registry theme, real thumbnails, "Usar este estilo"
  through the CP4 save) and the member-only preview. No migration.
- **CP6**: safe customization V1 (§9–§10): `wedding_site_designs.customization` with its CHECK validator, the
  3-argument save, the customization in the public read (`site_customization`), the ten palette presets, "Personalizar"
  in "Estilo del sitio" with per-group and full reset, and the preview of unsaved choices
  (`20261023120000_lb_wedding_site_customization.sql`).
- **CP7**: custom colors (§11): the optional `colors` group with WCAG AA checks in the parser, the CHECK validator and
  at render time, light mode only, mutually exclusive with presets, live contrast feedback in "Personalizar" and the
  preview of unsaved colors (`20261024120000_lb_wedding_site_custom_colors.sql`, the validator only).
- **Later**: self-hosted fonts, section reordering, planner presets, images, drafts.

## Rejected alternatives

- **An external visual page builder** (PageHub SDK): workable only after removing most of its features. Its text
  component emits raw HTML and its editor depends on external calls, while it is pre-1.0 and single-maintainer.
- **`wedding_publications.template_key`**: mixes presentation into the owner-only publication boundary.
- **Free-form theme JSON, CSS or class names**: no safe way to validate it, and it would allow injection.
