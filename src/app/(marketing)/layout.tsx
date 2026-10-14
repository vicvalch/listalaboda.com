import type { ReactNode } from "react";

import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { MarketingHeader } from "@/components/marketing/MarketingHeader";
import { getMessages } from "@/lib/i18n";

/**
 * The marketing pages' shell (Marketing Landing V1): skip link, header,
 * `<main id="contenido">` and footer. Static: no cookies, session, Supabase
 * or database. The app (`/app`), auth, RSVP and wedding sites keep their own
 * layouts.
 */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  const { marketing } = getMessages();
  return (
    <>
      <a
        href="#contenido"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2 focus:font-semibold"
      >
        {marketing.skipToContent}
      </a>
      <MarketingHeader />
      <main id="contenido" data-marketing="" className="flex-1">
        {children}
      </main>
      <MarketingFooter />
    </>
  );
}
