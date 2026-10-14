import { SiteRender } from "@/components/marketing/SiteRender";
import { getMessages } from "@/lib/i18n";
import { WEDDING_SITE_THEME_KEYS } from "@/lib/wedding-site/design/themes";

/**
 * The five wedding site themes (Marketing Landing V1), drawn by the REAL
 * renderer (`SiteRender`: `WeddingSite` + `resolveSiteDesign`) from fictional
 * content in code (`SHOWCASE_SITE`): no database, public read, network or
 * real wedding, and always exactly what the product draws (dark mode included).
 *
 * Each render is decorative (`aria-hidden`, `inert`); the theme's name and
 * description are the real text beside it. Phones scroll the row sideways
 * (snap points, a focusable labelled region); wider screens show a grid.
 * `staggered` drops every other theme a little on wide screens, for a page
 * that ends on the themes as a composition rather than a row.
 */
export function ThemeShowcase({ label, staggered = false }: { label: string; staggered?: boolean }) {
  const themes = getMessages().site.themes;
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="-mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:overflow-visible sm:px-0 sm:pb-0"
      data-testid="theme-showcase"
    >
      <ul className="flex snap-x snap-mandatory gap-4 sm:grid sm:grid-cols-3 sm:gap-6 lg:grid-cols-5">
        {WEDDING_SITE_THEME_KEYS.map((key) => (
          <li
            key={key}
            className={`w-[72%] shrink-0 snap-start sm:w-auto${staggered ? " lg:even:mt-16" : ""}`}
            data-testid="theme-showcase-item"
            data-theme={key}
          >
            <SiteRender theme={key} className="aspect-[3/4] rounded-lg border border-border" />
            <h3 className="mt-4 font-serif text-xl">{themes[key].name}</h3>
            <p className="text-muted mt-1 text-sm leading-6">{themes[key].description}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
