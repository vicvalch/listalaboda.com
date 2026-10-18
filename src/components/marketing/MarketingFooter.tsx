import Link from "next/link";

import { BrandSignature } from "@/components/brand/BrandLogo";
import { containerClass } from "@/components/marketing/classes";
import { textLinkClass } from "@/components/ui/styles";
import { getMessages } from "@/lib/i18n";
import { LEGAL_LINKS } from "@/lib/legal/links";
import { MARKETING_CONTACT_EMAIL, MARKETING_LINKS } from "@/lib/marketing/links";

/** The marketing footer (Marketing Landing V1): only destinations that exist today, plus the legal pages (Batch 1). */
export function MarketingFooter() {
  const { marketing, legal } = getMessages();
  const groups = [
    {
      title: marketing.footer.product,
      links: [
        { href: MARKETING_LINKS.PLANNERS, label: marketing.nav.planners },
        { href: MARKETING_LINKS.COUPLES, label: marketing.nav.couples },
        { href: MARKETING_LINKS.HOW_IT_WORKS, label: marketing.nav.howItWorks },
      ],
    },
    { title: marketing.footer.account, links: [{ href: MARKETING_LINKS.LOGIN, label: marketing.nav.login }] },
    {
      title: marketing.footer.legal,
      links: [
        { href: LEGAL_LINKS.TERMS, label: legal.links.terms },
        { href: LEGAL_LINKS.REFUNDS, label: legal.links.refunds },
        { href: LEGAL_LINKS.PRIVACY, label: legal.links.privacy },
      ],
    },
  ];
  return (
    <footer className="border-t border-border">
      <div className={`${containerClass} grid gap-10 py-12 sm:grid-cols-3 lg:grid-cols-[1.4fr_1fr_1fr_1.2fr_1.4fr]`}>
        <div className="space-y-2">
          <p>
            <BrandSignature alt={marketing.brand} className="h-11" />
          </p>
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
          <ul className="space-y-2">
            {[
              { href: MARKETING_LINKS.DEMO, label: marketing.cta.demo },
              { href: MARKETING_LINKS.ACCESS, label: marketing.cta.access },
            ].map((link) => (
              <li key={link.href}>
                <a href={link.href} className="text-muted text-sm hover:text-foreground hover:underline">
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
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
