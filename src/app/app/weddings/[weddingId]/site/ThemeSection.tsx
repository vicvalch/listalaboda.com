import Link from "next/link";

import { cardClass, secondaryButtonClass } from "@/components/ui/styles";
import { WeddingSite } from "@/components/wedding-site/WeddingSite";
import { getMessages } from "@/lib/i18n";
import { resolveSiteDesign } from "@/lib/wedding-site/design/resolve";
import { WEDDING_SITE_THEME_KEYS, type WeddingSiteThemeKey } from "@/lib/wedding-site/design/themes";
import { sitePreviewPath, toThumbnailSite } from "@/lib/wedding-site/preview";
import type { PublishedWeddingSite } from "@/lib/wedding-site/sections";

import { ThemeForm, ThemeSubmitButton } from "./ThemeForm";

/**
 * "Estilo del sitio" (ADR-019, CP5): one card per theme of the registry,
 * each with a real thumbnail of this wedding's site drawn by the public
 * renderer, the current choice marked in words, a link to the member-only
 * preview and "Usar este estilo". Any member may choose; choosing never
 * publishes and never changes the content.
 */
export function ThemeSection({
  weddingId,
  site,
  current,
  isPublished,
}: {
  weddingId: string;
  /** The site as it would be published (`toPreviewSite`). */
  site: PublishedWeddingSite;
  current: WeddingSiteThemeKey;
  isPublished: boolean;
}) {
  const copy = getMessages().site;
  const thumbnail = toThumbnailSite(site);

  return (
    <section className={`${cardClass} space-y-5`} aria-labelledby="site-theme-title" data-testid="site-theme">
      <header className="space-y-2">
        <h2 id="site-theme-title" className="text-xl font-semibold">
          {copy.design.title}
        </h2>
        <p className="text-muted">{copy.design.intro}</p>
        <p className="text-sm font-semibold">{copy.design.contentNote}</p>
        <p className="text-muted text-sm">{isPublished ? copy.design.liveNote : copy.design.unpublishedNote}</p>
      </header>

      <ThemeForm weddingId={weddingId}>
        <ul aria-label={copy.design.listLabel} className="grid gap-4 sm:grid-cols-2">
          {WEDDING_SITE_THEME_KEYS.map((key) => {
            const theme = copy.themes[key];
            const selected = key === current;
            const nameId = `site-theme-${key}-name`;
            return (
              <li
                key={key}
                aria-current={selected ? "true" : undefined}
                data-testid="site-theme-option"
                data-theme={key}
                className={`min-w-0 space-y-3 rounded-xl border bg-surface p-3 ${
                  selected ? "border-accent ring-2 ring-accent" : "border-border"
                }`}
              >
                <ThemeThumbnail site={thumbnail} themeKey={key} />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 id={nameId} className="text-lg font-semibold">
                    {theme.name}
                  </h3>
                  {selected ? (
                    <p
                      className="inline-flex items-center gap-1 rounded-full bg-accent px-2.5 py-0.5 text-sm font-semibold text-accent-foreground"
                      data-testid="site-theme-selected"
                    >
                      <span aria-hidden="true">✓</span>
                      {copy.design.selected}
                    </p>
                  ) : null}
                </div>
                <p className="text-muted text-sm">{theme.description}</p>
                <div className="flex flex-wrap gap-3">
                  <Link
                    href={sitePreviewPath(weddingId, key)}
                    aria-label={`${copy.design.preview}: ${theme.name}`}
                    className={`${secondaryButtonClass} w-full sm:w-auto`}
                  >
                    {copy.design.preview}
                  </Link>
                  {selected ? null : (
                    <ThemeSubmitButton
                      theme={key}
                      label={copy.design.use}
                      pendingLabel={copy.design.saving}
                      name={theme.name}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </ThemeForm>
    </section>
  );
}

/**
 * A theme thumbnail: the real renderer (`WeddingSite` + `resolveSiteDesign`)
 * drawn four times wider (and at least four times taller) than the box and
 * scaled to a quarter, clipped to the top of the page. Purely visual: hidden from assistive technology,
 * inert (nothing focusable or clickable) and no markup of its own.
 */
export function ThemeThumbnail({ site, themeKey }: { site: PublishedWeddingSite; themeKey: WeddingSiteThemeKey }) {
  return (
    <div
      aria-hidden="true"
      inert
      data-testid="site-theme-thumbnail"
      className="relative aspect-[4/3] overflow-hidden rounded-lg border border-border bg-background text-foreground"
    >
      {/* At least as tall as the box (×4 before scaling), so a short site still
          fills it with its own background: the site's root grows (flex-1). */}
      <div className="pointer-events-none absolute top-0 left-0 flex min-h-[400%] w-[400%] origin-top-left scale-25 flex-col select-none">
        <WeddingSite site={site} design={resolveSiteDesign(themeKey)} element="div" />
      </div>
    </div>
  );
}
