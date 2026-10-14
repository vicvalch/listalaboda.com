import type { ReactNode } from "react";

import { cx } from "@/components/marketing/classes";

/**
 * The one layout primitive of the marketing pages (Marketing Landing V1): an
 * eyebrow, a heading, body text and an optional visual.
 *
 *   * `text-first`: text, then the visual (side by side from `lg`, text left);
 *   * `visual-first`: the same, visual left from `lg` (text still first on
 *     phones and in reading order);
 *   * `stacked`: text above, the visual (or `children`) full width below.
 *
 * `actions` (links or buttons) follow the text; `headingLevel` keeps one h1
 * per page and a logical outline.
 */
export function Section({
  id,
  eyebrow,
  title,
  headingLevel = 2,
  body,
  layout = "stacked",
  visual,
  actions,
  children,
  className,
}: {
  id?: string;
  eyebrow?: string;
  title: string;
  headingLevel?: 1 | 2 | 3;
  body?: string | readonly string[];
  layout?: "text-first" | "visual-first" | "stacked";
  visual?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const Heading = (`h${headingLevel}` as const);
  const titleId = id ? `${id}-titulo` : undefined;
  const paragraphs = body === undefined ? [] : typeof body === "string" ? [body] : body;
  const split = layout !== "stacked" && visual !== undefined;

  const text = (
    <div className={cx("min-w-0 space-y-5", split ? "lg:col-span-5" : "max-w-3xl")}>
      {eyebrow ? <p className="text-accent text-sm font-semibold tracking-[0.16em] uppercase">{eyebrow}</p> : null}
      <Heading id={titleId} className={HEADING[headingLevel]}>
        {title}
      </Heading>
      {paragraphs.map((paragraph) => (
        <p key={paragraph} className={cx("text-muted max-w-prose leading-8", headingLevel === 3 ? "text-base sm:text-lg" : "text-lg")}>
          {paragraph}
        </p>
      ))}
      {actions ? <div className="pt-3">{actions}</div> : null}
    </div>
  );

  return (
    <section id={id} aria-labelledby={titleId} className={cx("scroll-mt-20", className)}>
      {split ? (
        <div className="grid items-center gap-10 lg:grid-cols-12 lg:gap-14">
          {text}
          <div className={cx("min-w-0 lg:col-span-7", layout === "visual-first" && "lg:order-first")}>{visual}</div>
        </div>
      ) : (
        <div className="space-y-10 sm:space-y-12">
          {text}
          {visual}
          {children}
        </div>
      )}
      {split ? children : null}
    </section>
  );
}

const HEADING = {
  1: "font-serif text-[2.6rem] leading-[1.05] tracking-tight text-balance sm:text-6xl lg:text-7xl",
  2: "font-serif text-3xl leading-tight tracking-tight text-balance sm:text-4xl lg:text-5xl",
  3: "font-serif text-2xl leading-snug tracking-tight text-balance sm:text-3xl",
} as const;
