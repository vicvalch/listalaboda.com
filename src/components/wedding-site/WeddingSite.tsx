import { getMessages } from "@/lib/i18n";
import type { ContentWidth, HeroVariant, SectionStyle } from "@/lib/wedding-site/design/themes";
import type { ResolvedSiteDesign } from "@/lib/wedding-site/design/resolve";
import type { PublishedSection, PublishedWeddingSite } from "@/lib/wedding-site/sections";
import { formatWeddingDate } from "@/lib/weddings/format";

/**
 * The public wedding website, drawn from two separate inputs: the published
 * content (`site`, from the public read boundary) and its presentation
 * (`design`, closed theme values). Each design value selects markup and
 * classes defined here; no class, style or markup ever comes from data.
 *
 * User text is rendered as plain text (React escapes it; line breaks are
 * kept with CSS), never as HTML. The RSVP section only explains how to
 * answer, with the personal link each party received: no form, guest search,
 * guest data or link to an RSVP page.
 */
export function WeddingSite({ site, design }: { site: PublishedWeddingSite; design: ResolvedSiteDesign }) {
  const { publicSite } = getMessages();
  return (
    <main className="flex flex-1 flex-col items-center px-4 py-10 sm:py-16">
      <article className={`w-full ${WIDTH_CLASS[design.width]} space-y-10`} data-testid="public-site">
        <SiteHero variant={design.hero} site={site} />
        {site.sections.map((section) => (
          <SiteSection key={section.kind} style={design.sectionStyle} section={section} />
        ))}
      </article>
      <footer className="mt-16">
        <p className="text-muted text-sm">{publicSite.footer}</p>
      </footer>
    </main>
  );
}

const WIDTH_CLASS: Record<ContentWidth, string> = {
  regular: "max-w-2xl",
};

function SiteHero({ variant, site }: { variant: HeroVariant; site: PublishedWeddingSite }) {
  switch (variant) {
    case "centered":
      return (
        <header className="space-y-3 border-b border-border pb-8 text-center">
          <h1 className="text-3xl font-semibold tracking-tight break-words sm:text-4xl">{site.name}</h1>
          <SiteDetails site={site} />
        </header>
      );
  }
}

/** "date · city", whichever of the two the wedding has; nothing if neither. */
function SiteDetails({ site }: { site: PublishedWeddingSite }) {
  const details = [
    site.weddingDate ? (
      <time key="date" dateTime={site.weddingDate}>
        {formatWeddingDate(site.weddingDate)}
      </time>
    ) : null,
    site.city ? <span key="city">{site.city}</span> : null,
  ].filter(Boolean);
  if (details.length === 0) return null;
  return (
    <p className="text-muted text-lg break-words" data-testid="public-site-details">
      {details.map((detail, index) => (
        <span key={index}>
          {index > 0 ? " · " : null}
          {detail}
        </span>
      ))}
    </p>
  );
}

function SiteSection({ style, section }: { style: SectionStyle; section: PublishedSection }) {
  switch (style) {
    case "plain":
      return (
        <section
          id={section.kind}
          aria-labelledby={`public-${section.kind}-title`}
          className="space-y-3"
          data-testid="public-site-section"
          data-kind={section.kind}
        >
          <h2 id={`public-${section.kind}-title`} className="text-2xl font-semibold tracking-tight break-words">
            {section.title}
          </h2>
          <p className="leading-relaxed break-words whitespace-pre-line">{section.body}</p>
        </section>
      );
  }
}
