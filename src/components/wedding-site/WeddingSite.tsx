import { Fragment, type ReactNode } from "react";

import { SiteHero } from "@/components/wedding-site/hero";
import { SiteFooter } from "@/components/wedding-site/parts";
import { SitePhotoBlockView } from "@/components/wedding-site/photos";
import { SiteSection } from "@/components/wedding-site/section";
import { customColorStyle, cx, DENSITY, PALETTE_SURFACE, TYPOGRAPHY, WIDTH } from "@/components/wedding-site/styles";
import { getMessages } from "@/lib/i18n";
import type { ResolvedSiteDesign } from "@/lib/wedding-site/design/resolve";
import { blocksAt, coverBlock, type SitePhotoBlock, type SitePhotos } from "@/lib/wedding-site/photos/model";
import { SECTION_KINDS, type PublishedWeddingSite, type SectionKind } from "@/lib/wedding-site/sections";

/**
 * The public wedding website, drawn from two separate inputs: the published
 * content (`site`, from the public read boundary) and its presentation
 * (`design`, closed theme values). Each design value selects markup and
 * classes defined in code (`styles.ts`, the hero and section variants); no
 * class or markup ever comes from data. The one style is a custom palette
 * (CP7): six fixed custom properties set to re-validated canonical hex
 * colors (`customColorStyle`), applied in light mode only by `globals.css`.
 * A Server Component with no client JavaScript.
 *
 * User text is rendered as plain text (React escapes it; line breaks are
 * kept with CSS), never as HTML. The RSVP section only explains how to
 * answer, with the personal link each party received: no form, guest search,
 * guest data or link to an RSVP page.
 *
 * `element` is the page landmark: `main` on the public page; `div` where the
 * site is drawn inside another page (the organizer's preview and theme
 * thumbnails), which already has its own `main`.
 *
 * `photos` (UX-01B, ADR-022) is a third, optional input: the cover goes into
 * the opening and every other photo block sits at its slot in the FIXED
 * section order (after the opening, or after a section kind's place),
 * whether or not that section is shown. No photos = the text-only page,
 * markup unchanged.
 *
 * `studio` (STUDIO-01) is only for the member-only Studio canvas: hooks that
 * wrap each element in authoring chrome and add insertion points, around
 * the very same markup. Public pages never pass it, and without it the
 * output is exactly the page above (golden tests).
 */
export type SiteStudioHooks = Readonly<{
  /** The opening: names, date, city and the cover. */
  hero: (node: ReactNode) => ReactNode;
  /** A text section at its fixed place; `node` is null where the page draws nothing there. */
  section: (kind: SectionKind, node: ReactNode) => ReactNode;
  /** A photo block other than the cover, with its rendered markup. */
  block: (block: SitePhotoBlock, node: ReactNode) => ReactNode;
  /** Stable member-only identity keeps drag handles/focus attached to their block. */
  blockKey?: (block: SitePhotoBlock) => string | undefined;
  /** The end of a slot: after the opening (null) or after a section kind's place. */
  slotEnd: (anchor: SectionKind | null) => ReactNode;
}>;

export function WeddingSite({
  site,
  design,
  photos,
  element: Root = "main",
  studio,
}: {
  site: PublishedWeddingSite;
  design: ResolvedSiteDesign;
  photos?: SitePhotos;
  element?: "main" | "div";
  studio?: SiteStudioHooks;
}) {
  const { publicSite } = getMessages();
  // Classic draws with the app palette and sets no palette scope, which keeps
  // its markup identical to the original page.
  const palette = design.palette === "app" ? undefined : design.palette;
  // Custom colors paint their own background (Classic's app palette paints
  // none); dark mode falls back to the theme's palette scope.
  const custom = design.colors ? customColorStyle(design.colors) : null;
  const blocks = photos?.blocks ?? [];
  const cover = coverBlock(blocks);
  // Each non-cover block's place among all of them (unique carousel ids).
  const order = new Map<SitePhotoBlock, number>(blocks.filter((b) => b.kind !== "cover").map((b, i) => [b, i]));
  const photoBlocks = (anchor: (typeof SECTION_KINDS)[number] | null) =>
    photos
      ? blocksAt(blocks, anchor).map((block) => {
          const view = (
            <SitePhotoBlockView
              key={`photos-${order.get(block)}`}
              block={block}
              basePath={photos.basePath}
              design={design}
              index={order.get(block) ?? 0}
            />
          );
          return studio ? <Fragment key={studio.blockKey?.(block) ?? `photos-${order.get(block)}`}>{studio.block(block, view)}</Fragment> : view;
        })
      : null;
  const hero = (
    <SiteHero site={site} design={design} cover={cover && photos ? { block: cover, basePath: photos.basePath } : null} />
  );
  return (
    <Root
      className={cx(
        "flex flex-1 flex-col items-center px-4",
        DENSITY[design.density].page,
        custom ? "bg-background text-foreground" : PALETTE_SURFACE[design.palette],
        TYPOGRAPHY[design.typography].body,
      )}
      data-site-palette={palette}
      data-site-custom-colors={custom ? "" : undefined}
      style={custom ?? undefined}
    >
      <article className={cx("w-full", WIDTH[design.width], DENSITY[design.density].stack)} data-testid="public-site">
        {studio ? studio.hero(hero) : hero}
        {photoBlocks(null)}
        {studio?.slotEnd(null)}
        {SECTION_KINDS.map((kind) => {
          const section = site.sections.find((s) => s.kind === kind);
          const view = section ? <SiteSection section={section} design={design} /> : null;
          return (
            <Fragment key={kind}>
              {studio ? studio.section(kind, view) : view}
              {photoBlocks(kind)}
              {studio?.slotEnd(kind)}
            </Fragment>
          );
        })}
      </article>
      <SiteFooter design={design} text={publicSite.footer} />
    </Root>
  );
}
