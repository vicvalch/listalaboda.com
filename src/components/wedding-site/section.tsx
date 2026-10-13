import { SectionBlock, sectionTitleId } from "@/components/wedding-site/parts";
import { cx, sectionHeadingClass } from "@/components/wedding-site/styles";
import type { ResolvedSiteDesign } from "@/lib/wedding-site/design/resolve";
import type { PublishedSection } from "@/lib/wedding-site/sections";

type SectionProps = { section: PublishedSection; design: ResolvedSiteDesign };

/**
 * One published section in the theme's section style. The title and body
 * are plain text (React escapes them; `whitespace-pre-line` keeps the line
 * breaks), never HTML.
 */
export function SiteSection(props: SectionProps) {
  switch (props.design.sectionStyle) {
    case "plain":
      return <SectionPlain {...props} />;
    case "editorial":
      return <SectionEditorial {...props} />;
    case "ruled":
      return <SectionRuled {...props} />;
    case "centered":
      return <SectionCentered {...props} />;
    case "tiles":
      return <SectionTile {...props} />;
  }
}

/** Classic: heading over body. */
function SectionPlain({ section, design }: SectionProps) {
  return (
    <SectionBlock section={section} className="space-y-3">
      <h2 id={sectionTitleId(section)} className={sectionHeadingClass(design.headingScale, design.typography)}>
        {section.title}
      </h2>
      <p className="leading-relaxed break-words whitespace-pre-line">{section.body}</p>
    </SectionBlock>
  );
}

/** Editorial: a short accent rule, a light heading and roomy reading text. */
function SectionEditorial({ section, design }: SectionProps) {
  return (
    <SectionBlock section={section} className="space-y-4">
      <span aria-hidden="true" className="block h-px w-10 bg-accent" />
      <h2 id={sectionTitleId(section)} className={sectionHeadingClass(design.headingScale, design.typography)}>
        {section.title}
      </h2>
      <p className="text-lg leading-8 break-words whitespace-pre-line">{section.body}</p>
    </SectionBlock>
  );
}

/** Minimal: a hairline above, then a label column and a text column (stacked on phones). */
function SectionRuled({ section, design }: SectionProps) {
  return (
    <SectionBlock
      section={section}
      className="grid gap-3 border-t border-border pt-6 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-8"
    >
      <h2 id={sectionTitleId(section)} className={cx(sectionHeadingClass(design.headingScale, design.typography), "min-w-0 sm:pt-1.5")}>
        {section.title}
      </h2>
      <p className="min-w-0 leading-7 break-words whitespace-pre-line">{section.body}</p>
    </SectionBlock>
  );
}

/** Romantic: a centered heading in the accent color, a short rule, and centered text in a comfortable measure. */
function SectionCentered({ section, design }: SectionProps) {
  return (
    <SectionBlock section={section} className="space-y-4 text-center">
      <h2 id={sectionTitleId(section)} className={cx(sectionHeadingClass(design.headingScale, design.typography), "text-accent")}>
        {section.title}
      </h2>
      <span aria-hidden="true" className="mx-auto block h-px w-8 bg-border" />
      <p className="mx-auto max-w-lg text-lg leading-8 break-words whitespace-pre-line">{section.body}</p>
    </SectionBlock>
  );
}

/** Tropical: a tinted tile with a short ornament-colored bar and a heading in the accent color. */
function SectionTile({ section, design }: SectionProps) {
  return (
    <SectionBlock section={section} className="space-y-3 bg-accent-soft px-6 py-8 sm:px-10 sm:py-10">
      <span aria-hidden="true" className="block h-1 w-8 bg-(--site-ornament)" />
      <h2 id={sectionTitleId(section)} className={cx(sectionHeadingClass(design.headingScale, design.typography), "text-accent")}>
        {section.title}
      </h2>
      <p className="leading-7 break-words whitespace-pre-line">{section.body}</p>
    </SectionBlock>
  );
}
