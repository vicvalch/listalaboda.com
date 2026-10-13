import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { Notice } from "@/components/ui/Notice";
import { WeddingSite } from "@/components/wedding-site/WeddingSite";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveSiteDesign } from "@/lib/wedding-site/design/resolve";
import { getPublishedWeddingSite } from "@/lib/wedding-site/public";

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
 * detected. The content is drawn by `WeddingSite` in the wedding's theme
 * (ADR-019): plain text only, and an RSVP section that only explains how to
 * answer with the personal link each party received.
 */
export default async function PublicWeddingSitePage({ params }: PageProps<"/boda/[slug]">) {
  const { slug } = await params;
  const result = await loadSite(slug);
  const { common } = getMessages();

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

  // No design state is stored or selected yet (ADR-019 CP2): every site is Classic.
  return <WeddingSite site={result.site} design={resolveSiteDesign(null)} />;
}
