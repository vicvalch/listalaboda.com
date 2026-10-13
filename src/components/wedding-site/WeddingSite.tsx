import { SiteHero } from "@/components/wedding-site/hero";
import { SiteFooter } from "@/components/wedding-site/parts";
import { SiteSection } from "@/components/wedding-site/section";
import { cx, DENSITY, PALETTE_SURFACE, TYPOGRAPHY, WIDTH } from "@/components/wedding-site/styles";
import { getMessages } from "@/lib/i18n";
import type { ResolvedSiteDesign } from "@/lib/wedding-site/design/resolve";
import type { PublishedWeddingSite } from "@/lib/wedding-site/sections";

/**
 * The public wedding website, drawn from two separate inputs: the published
 * content (`site`, from the public read boundary) and its presentation
 * (`design`, closed theme values). Each design value selects markup and
 * classes defined in code (`styles.ts`, the hero and section variants); no
 * class, style or markup ever comes from data. A Server Component with no
 * client JavaScript.
 *
 * User text is rendered as plain text (React escapes it; line breaks are
 * kept with CSS), never as HTML. The RSVP section only explains how to
 * answer, with the personal link each party received: no form, guest search,
 * guest data or link to an RSVP page.
 *
 * `element` is the page landmark: `main` on the public page; `div` where the
 * site is drawn inside another page (the organizer's preview and theme
 * thumbnails), which already has its own `main`.
 */
export function WeddingSite({
  site,
  design,
  element: Root = "main",
}: {
  site: PublishedWeddingSite;
  design: ResolvedSiteDesign;
  element?: "main" | "div";
}) {
  const { publicSite } = getMessages();
  // Classic draws with the app palette and sets no palette scope, which keeps
  // its markup identical to the original page.
  const palette = design.palette === "app" ? undefined : design.palette;
  return (
    <Root
      className={cx(
        "flex flex-1 flex-col items-center px-4",
        DENSITY[design.density].page,
        PALETTE_SURFACE[design.palette],
        TYPOGRAPHY[design.typography].body,
      )}
      data-site-palette={palette}
    >
      <article className={cx("w-full", WIDTH[design.width], DENSITY[design.density].stack)} data-testid="public-site">
        <SiteHero site={site} design={design} />
        {site.sections.map((section) => (
          <SiteSection key={section.kind} section={section} design={design} />
        ))}
      </article>
      <SiteFooter design={design} text={publicSite.footer} />
    </Root>
  );
}
