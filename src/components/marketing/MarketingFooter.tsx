import Link from "next/link";

import { containerClass } from "@/components/marketing/classes";
import { textLinkClass } from "@/components/ui/styles";
import { getMessages } from "@/lib/i18n";
import { MARKETING_CONTACT_EMAIL, MARKETING_LINKS } from "@/lib/marketing/links";

/** The marketing footer (Marketing Landing V1): only destinations that exist today. */
export function MarketingFooter() {
  const { marketing } = getMessages();
  const groups = [
    {
      title: marketing.footer.product,
      links: [
        { href: MARKETING_LINKS.HOW_IT_WORKS, label: marketing.nav.howItWorks },
        { href: MARKETING_LINKS.WEDDING_SITES, label: marketing.nav.weddingSites },
      ],
    },
    { title: marketing.footer.account, links: [{ href: MARKETING_LINKS.LOGIN, label: marketing.nav.login }] },
  ];
  return (
    <footer className="border-t border-border">
      <div className={`${containerClass} grid gap-10 py-12 sm:grid-cols-[1.5fr_1fr_1fr_1.4fr]`}>
        <div className="space-y-2">
          <p className="text-lg font-semibold tracking-tight">{marketing.brand}</p>
          <p className="text-muted text-sm">{marketing.footer.tagline}</p>
        </div>
        {groups.map((group) => (
          <div key={group.title} className="space-y-3">
            <h2 className="text-sm font-semibold">{group.title}</h2>
            <ul className="space-y-2">
              {group.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-muted text-sm hover:text-foreground hover:underline">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div className="min-w-0 space-y-3">
          <h2 className="text-sm font-semibold">{marketing.footer.contact}</h2>
          <p className="text-sm break-words">
            <a href={MARKETING_LINKS.CONTACT} className={textLinkClass}>
              {MARKETING_CONTACT_EMAIL}
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
