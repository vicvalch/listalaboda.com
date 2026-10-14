import { WeddingSite } from "@/components/wedding-site/WeddingSite";
import { getMessages } from "@/lib/i18n";
import { SHOWCASE_SITE } from "@/lib/marketing/showcase";
import { resolveSiteDesign } from "@/lib/wedding-site/design/resolve";
import { WEDDING_SITE_THEME_KEYS } from "@/lib/wedding-site/design/themes";

/**
 * The five wedding site themes (Marketing Landing V1), drawn by the REAL
 * renderer (`WeddingSite` + `resolveSiteDesign`) from fictional content in
 * code (`SHOWCASE_SITE`): no database, public read, network or real
 * wedding, and always exactly what the product draws (dark mode included).
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
            <div
              aria-hidden="true"
              inert
              className="relative aspect-[3/4] overflow-hidden rounded-lg border border-border bg-background text-foreground"
            >
              {/* At least as tall as the box (×4 before scaling), so the site's
                  own background fills it (its root grows with flex-1). */}
              <div className="pointer-events-none absolute top-0 left-0 flex min-h-[400%] w-[400%] origin-top-left scale-25 flex-col select-none">
                <WeddingSite site={SHOWCASE_SITE} design={resolveSiteDesign(key)} element="div" />
              </div>
            </div>
            <h3 className="mt-4 font-serif text-xl">{themes[key].name}</h3>
            <p className="text-muted mt-1 text-sm leading-6">{themes[key].description}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
