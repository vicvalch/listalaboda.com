import { DetailsLine, Ornament } from "@/components/wedding-site/parts";
import { ALIGN, cx, nameClass, TYPOGRAPHY } from "@/components/wedding-site/styles";
import type { ResolvedSiteDesign } from "@/lib/wedding-site/design/resolve";
import type { PublishedWeddingSite } from "@/lib/wedding-site/sections";

type HeroProps = { site: PublishedWeddingSite; design: ResolvedSiteDesign };

/** The site's opening (the couple's name, date and city), in the theme's hero variant. */
export function SiteHero(props: HeroProps) {
  switch (props.design.hero) {
    case "simple":
      return <HeroSimple {...props} />;
    case "editorial":
      return <HeroEditorial {...props} />;
    case "grid":
      return <HeroGrid {...props} />;
    case "framed":
      return <HeroFramed {...props} />;
    case "banner":
      return <HeroBanner {...props} />;
  }
}

/** Classic: the name over its details, closed by a rule. */
function HeroSimple({ site, design }: HeroProps) {
  return (
    <header className={cx("space-y-3 border-b border-border pb-8", ALIGN[design.alignment])}>
      <h1 className={nameClass(design.headingScale, design.typography)}>{site.name}</h1>
      <DetailsLine
        site={site}
        className={cx("text-muted text-lg break-words", TYPOGRAPHY[design.typography].label)}
      />
    </header>
  );
}

/** Editorial: a large name, the theme's ornament, then the details in spaced small capitals. */
function HeroEditorial({ site, design }: HeroProps) {
  return (
    <header className={cx("space-y-6 sm:space-y-8", ALIGN[design.alignment])}>
      <h1 className={nameClass(design.headingScale, design.typography)}>{site.name}</h1>
      <Ornament kind={design.ornament} alignment={design.alignment} />
      <DetailsLine
        site={site}
        className={cx(
          "text-muted text-xs tracking-[0.25em] break-words uppercase sm:text-sm",
          TYPOGRAPHY[design.typography].label,
        )}
      />
    </header>
  );
}

/** Minimal: the name and a compact details line, aligned to the content grid. */
function HeroGrid({ site, design }: HeroProps) {
  return (
    <header className={cx("space-y-4", ALIGN[design.alignment])}>
      <h1 className={nameClass(design.headingScale, design.typography)}>{site.name}</h1>
      <Ornament kind={design.ornament} alignment={design.alignment} />
      <DetailsLine
        site={site}
        className={cx(
          "text-muted text-sm tracking-[0.08em] break-words uppercase tabular-nums",
          TYPOGRAPHY[design.typography].label,
        )}
      />
    </header>
  );
}

/** Romantic: the name, a flourish and the details inside a fine double frame. */
function HeroFramed({ site, design }: HeroProps) {
  return (
    <header className={cx("border border-border p-1.5 sm:p-2", ALIGN[design.alignment])}>
      <div className="space-y-6 border border-border px-5 py-12 sm:space-y-8 sm:px-12 sm:py-16">
        <h1 className={nameClass(design.headingScale, design.typography)}>{site.name}</h1>
        <Ornament kind={design.ornament} alignment={design.alignment} />
        <DetailsLine
          site={site}
          className={cx(
            "text-muted text-sm tracking-[0.2em] break-words uppercase",
            TYPOGRAPHY[design.typography].label,
          )}
        />
      </div>
    </header>
  );
}

/** Tropical: the theme's ornament, the name and the details on a solid color band. */
function HeroBanner({ site, design }: HeroProps) {
  return (
    <header
      className={cx(
        "space-y-5 bg-(--site-band) px-6 py-12 text-(--site-band-text) sm:space-y-6 sm:px-12 sm:py-16",
        ALIGN[design.alignment],
      )}
    >
      <Ornament kind={design.ornament} alignment={design.alignment} />
      <h1 className={nameClass(design.headingScale, design.typography)}>{site.name}</h1>
      <DetailsLine
        site={site}
        className={cx(
          "text-sm tracking-[0.14em] break-words uppercase tabular-nums",
          TYPOGRAPHY[design.typography].label,
        )}
      />
    </header>
  );
}
