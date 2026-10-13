import type { ReactNode } from "react";

import { cx, DENSITY, TYPOGRAPHY, WIDTH } from "@/components/wedding-site/styles";
import type { ResolvedSiteDesign } from "@/lib/wedding-site/design/resolve";
import type { Alignment, Ornament as OrnamentKind } from "@/lib/wedding-site/design/themes";
import type { PublishedSection, PublishedWeddingSite } from "@/lib/wedding-site/sections";
import { formatWeddingDate } from "@/lib/weddings/format";

/** "date · city", whichever of the two the wedding has; nothing if neither. */
export function DetailsLine({ site, className }: { site: PublishedWeddingSite; className: string }) {
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
    <p className={className} data-testid="public-site-details">
      {details.map((detail, index) => (
        <span key={index}>
          {index > 0 ? " · " : null}
          {detail}
        </span>
      ))}
    </p>
  );
}

/** A static, decorative mark in the theme's accent color. Hidden from assistive technology. */
export function Ornament({ kind, alignment }: { kind: OrnamentKind; alignment: Alignment }) {
  switch (kind) {
    case "none":
      return null;
    case "rule":
      return (
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 120 10"
          fill="none"
          className={cx("block h-2.5 w-30 text-accent", alignment === "center" && "mx-auto")}
          data-testid="public-site-ornament"
        >
          <path d="M0 5H50M70 5H120" stroke="currentColor" strokeWidth="1" />
          <path d="M60 1L64 5L60 9L56 5Z" fill="currentColor" />
        </svg>
      );
  }
}

/**
 * The element every section style draws into: its anchor, its accessible
 * name (the heading) and the test hooks. The style decides what goes inside.
 */
export function SectionBlock({
  section,
  className,
  children,
}: {
  section: PublishedSection;
  className: string;
  children: ReactNode;
}) {
  return (
    <section
      id={section.kind}
      aria-labelledby={sectionTitleId(section)}
      className={className}
      data-testid="public-site-section"
      data-kind={section.kind}
    >
      {children}
    </section>
  );
}

export function sectionTitleId(section: PublishedSection): string {
  return `public-${section.kind}-title`;
}

export function SiteFooter({ design, text }: { design: ResolvedSiteDesign; text: string }) {
  // A start-aligned footer spans the content column so it lines up with it;
  // a centered one is centered by the page.
  const lined = design.alignment === "start";
  return (
    <footer className={cx(DENSITY[design.density].footer, lined && cx("w-full", WIDTH[design.width], "text-start"))}>
      <p className={cx("text-muted text-sm", TYPOGRAPHY[design.typography].label)}>{text}</p>
    </footer>
  );
}
