import Link from "next/link";

import { containerClass } from "@/components/marketing/classes";
import { primaryButtonClass } from "@/components/ui/styles";
import { getMessages } from "@/lib/i18n";
import { MARKETING_LINKS } from "@/lib/marketing/links";

const navLinkClass = "rounded-md px-1 py-2 text-sm font-semibold hover:text-accent";

/**
 * The marketing header (Marketing Landing V1): the brand (home), the two
 * audience pages, how it works, login and the primary call to action. Phones
 * get a native `<details>` menu (no client JavaScript), and so does any
 * screen narrower than `lg`, where five entries no longer fit in a row.
 */
export function MarketingHeader() {
  const { marketing } = getMessages();
  const links = [
    { href: MARKETING_LINKS.PLANNERS, label: marketing.nav.planners },
    { href: MARKETING_LINKS.COUPLES, label: marketing.nav.couples },
    { href: MARKETING_LINKS.HOW_IT_WORKS, label: marketing.nav.howItWorks },
    { href: MARKETING_LINKS.LOGIN, label: marketing.nav.login },
  ];
  return (
    <header className="relative border-b border-border/70">
      <div className={`${containerClass} flex min-h-16 items-center justify-between gap-6`}>
        <Link href={MARKETING_LINKS.HOME} className="py-2 text-lg font-semibold tracking-tight">
          {marketing.brand}
        </Link>
        <nav aria-label={marketing.nav.label}>
          <ul className="hidden items-center gap-6 lg:flex">
            {links.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className={navLinkClass}>
                  {link.label}
                </Link>
              </li>
            ))}
            <li>
              <a href={MARKETING_LINKS.DEMO} className={primaryButtonClass}>
                {marketing.cta.demo}
              </a>
            </li>
          </ul>
          <details className="group lg:hidden">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-semibold [&::-webkit-details-marker]:hidden">
              {marketing.nav.menu}
              <span aria-hidden="true" className="text-xs transition-transform group-open:rotate-180">
                ▾
              </span>
            </summary>
            <ul className="absolute inset-x-0 top-full z-20 space-y-1 border-b border-border bg-background px-4 pt-2 pb-5 shadow-sm">
              {links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="flex min-h-11 items-center text-base font-semibold">
                    {link.label}
                  </Link>
                </li>
              ))}
              <li className="pt-2">
                <a href={MARKETING_LINKS.DEMO} className={`${primaryButtonClass} w-full`}>
                  {marketing.cta.demo}
                </a>
              </li>
            </ul>
          </details>
        </nav>
      </div>
    </header>
  );
}
