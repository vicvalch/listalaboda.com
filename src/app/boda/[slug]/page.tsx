import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { Notice } from "@/components/ui/Notice";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPublishedWeddingSite } from "@/lib/wedding-site/public";
import { formatWeddingDate } from "@/lib/weddings/format";

// Publication changes (unpublish, hidden sections, a new address) must
// apply at once: read on every request, never prerendered or cached.
export const dynamic = "force-dynamic";

/** One public read per request, shared by the metadata and the page. */
const loadSite = cache(async (slug: string) =>
  getPublishedWeddingSite(await createSupabaseServerClient(), slug),
);

export async function generateMetadata({ params }: PageProps<"/boda/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const result = await loadSite(slug);
  return {
    title: result.ok ? result.site.name : getMessages().notFound.title,
    // Public by address, not discoverable through search engines.
    robots: { index: false, follow: false },
  };
}

/**
 * A published wedding website. No account, no token: it is content the
 * couple explicitly published. Everything comes from the public read
 * boundary (`get_published_wedding_site`): the wedding's name, date and
 * city and its visible sections — nothing else. An unknown, unpublished or
 * malformed address is the same 404, so an unpublished wedding can't be
 * detected. User text is rendered as plain text (React escapes it; line
 * breaks are kept with CSS), never as HTML.
 *
 * The RSVP section only explains how to answer: with the personal link each
 * party received. There is no form, guest search or guest data here.
 */
export default async function PublicWeddingSitePage({ params }: PageProps<"/boda/[slug]">) {
  const { slug } = await params;
  const result = await loadSite(slug);
  const { common, publicSite } = getMessages();

  if (!result.ok) {
    if (result.reason === "unavailable") notFound();
    return (
      <main className="flex flex-1 items-center justify-center px-4 py-16">
        <div className="w-full max-w-md">
          <Notice tone="error">{common.unexpectedError}</Notice>
        </div>
      </main>
    );
  }

  const { site } = result;
  const details = [
    site.weddingDate ? (
      <time key="date" dateTime={site.weddingDate}>
        {formatWeddingDate(site.weddingDate)}
      </time>
    ) : null,
    site.city ? <span key="city">{site.city}</span> : null,
  ].filter(Boolean);

  return (
    <main className="flex flex-1 flex-col items-center px-4 py-10 sm:py-16">
      <article className="w-full max-w-2xl space-y-10" data-testid="public-site">
        <header className="space-y-3 border-b border-border pb-8 text-center">
          <h1 className="text-3xl font-semibold tracking-tight break-words sm:text-4xl">{site.name}</h1>
          {details.length > 0 ? (
            <p className="text-muted text-lg break-words" data-testid="public-site-details">
              {details.map((detail, index) => (
                <span key={index}>
                  {index > 0 ? " · " : null}
                  {detail}
                </span>
              ))}
            </p>
          ) : null}
        </header>

        {site.sections.map((section) => (
          <section
            key={section.kind}
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
        ))}
      </article>
      <footer className="mt-16">
        <p className="text-muted text-sm">{publicSite.footer}</p>
      </footer>
    </main>
  );
}
