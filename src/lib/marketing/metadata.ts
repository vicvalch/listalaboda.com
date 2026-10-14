import type { Metadata } from "next";

import { getMessages } from "@/lib/i18n";

/**
 * The metadata of every marketing page (Marketing Landing V1): its title and
 * description, also as Open Graph text for shared links, and never indexed.
 *
 * While `listalaboda.com` isn't owned and connected there is no canonical, no
 * `metadataBase` and no Open Graph image or URL: each would need an absolute
 * address, and the only one available (the Vercel deployment's) must never
 * become the canonical host. Per-page `noindex, nofollow` is the authority;
 * `robots.txt` only keeps crawlers out of private surfaces.
 */
export function marketingMetadata({ title, description }: Readonly<{ title: string; description: string }>): Metadata {
  return {
    title,
    description,
    robots: { index: false, follow: false },
    openGraph: { title, description, siteName: getMessages().marketing.brand, locale: "es", type: "website" },
  };
}
