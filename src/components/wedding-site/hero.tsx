import { DetailsLine, Ornament } from "@/components/wedding-site/parts";
import { ALIGN, cx, HEADING_SCALE, TYPOGRAPHY } from "@/components/wedding-site/styles";
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
  }
}

/** Classic: the name over its details, closed by a rule. */
function HeroSimple({ site, design }: HeroProps) {
  return (
    <header className={cx("space-y-3 border-b border-border pb-8", ALIGN[design.alignment])}>
      <h1 className={HEADING_SCALE[design.headingScale].name}>{site.name}</h1>
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
      <h1 className={HEADING_SCALE[design.headingScale].name}>{site.name}</h1>
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
      <h1 className={HEADING_SCALE[design.headingScale].name}>{site.name}</h1>
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
