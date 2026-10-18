import Link from "next/link";

import { textLinkClass } from "@/components/ui/styles";
import { getMessages, interpolate } from "@/lib/i18n";
import { LEGAL_LINKS } from "@/lib/legal/links";

export type LegalSection = Readonly<{ id: string; title: string; paragraphs: readonly string[] }>;

/**
 * A legal page's body (Batch 1): a title, the update date and its sections,
 * each with a stable id so it can be linked (`/terminos#reembolsos-y-cancelaciones`).
 * Catalog copy only, rendered as React text: `values` fills `{placeholders}`
 * (support address, display prices), never markup.
 */
export function LegalDocument({
  title,
  intro,
  sections,
  values,
}: Readonly<{
  title: string;
  intro: string;
  sections: readonly LegalSection[];
  values: Readonly<Record<string, string>>;
}>) {
  const { legal } = getMessages();
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
      <header className="space-y-3">
        <h1 className="font-serif text-4xl leading-tight tracking-tight sm:text-5xl">{title}</h1>
        <p className="text-muted">{intro}</p>
        <p className="text-muted text-sm">{legal.updated}</p>
      </header>
      <nav aria-label={title} className="mt-8">
        <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <li>
            <Link href={LEGAL_LINKS.TERMS} className={textLinkClass}>
              {legal.links.terms}
            </Link>
          </li>
          <li>
            <Link href={LEGAL_LINKS.REFUNDS} className={textLinkClass}>
              {legal.links.refunds}
            </Link>
          </li>
          <li>
            <Link href={LEGAL_LINKS.PRIVACY} className={textLinkClass}>
              {legal.links.privacy}
            </Link>
          </li>
        </ul>
      </nav>
      <div className="mt-10 space-y-10">
        {sections.map((section) => (
          <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`} className="scroll-mt-24 space-y-3">
            <h2 id={`${section.id}-title`} className="text-xl font-semibold">
              {section.title}
            </h2>
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph} className="leading-7">
                {interpolate(paragraph, values)}
              </p>
            ))}
          </section>
        ))}
      </div>
    </article>
  );
}
