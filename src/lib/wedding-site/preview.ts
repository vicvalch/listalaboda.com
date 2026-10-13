import { DEFAULT_WEDDING_SITE_THEME, isWeddingSiteThemeKey, type WeddingSiteThemeKey } from "@/lib/wedding-site/design/themes";
import {
  toPublishedSite,
  type EditorSection,
  type PublishedSiteRow,
  type PublishedWeddingSite,
} from "@/lib/wedding-site/sections";

/**
 * The member-only preview of the wedding website (ADR-019, CP5): what the
 * public page would show, built from data the member already reads through
 * RLS (the wedding header and the editor's sections), so an unpublished site
 * can be previewed too. The public projection stays the only public read and
 * is not involved.
 *
 * The preview goes through the SAME shaping as the public page
 * (`toPublishedSite`), fed with rows that mirror `get_published_wedding_site`:
 * the wedding's name, date and city, and only VISIBLE sections. Nothing else
 * can reach it, because nothing else is passed in.
 */

/** The wedding fields the public site shows; nothing else. */
export type SiteHeader = Readonly<{ name: string; weddingDate: string | null; city: string | null }>;

/**
 * The site as it would look if published. Mirrors the public read: one row
 * per visible section (the database also requires content for a visible
 * section; `toPublishedSite` keeps only sections with something to show), or
 * a single header-only row when none is visible.
 */
export function toPreviewSite(
  header: SiteHeader,
  sections: readonly EditorSection[],
  slug: string,
): PublishedWeddingSite {
  const base = { wedding_name: header.name, wedding_date: header.weddingDate, wedding_city: header.city };
  const rows: PublishedSiteRow[] = sections
    .filter((section) => section.isVisible)
    .map((section) => ({
      ...base,
      section_kind: section.kind,
      section_title: section.title,
      section_body: section.body,
    }));
  if (rows.length === 0) rows.push({ ...base, section_kind: null, section_title: null, section_body: null });
  // One or more rows always give a site.
  return toPublishedSite(slug, rows) as PublishedWeddingSite;
}

/** How many sections, and how much of each, a theme thumbnail draws. */
export const THUMBNAIL_SECTIONS = 2;
export const THUMBNAIL_BODY_LENGTH = 280;

/**
 * A short excerpt of the site for the theme thumbnails: the same header and
 * the first sections, with long text cut. Thumbnails only show the top of
 * the page, so drawing all of it five times would only add weight.
 */
export function toThumbnailSite(site: PublishedWeddingSite): PublishedWeddingSite {
  return {
    ...site,
    sections: site.sections.slice(0, THUMBNAIL_SECTIONS).map((section) => ({
      ...section,
      body: [...section.body].length > THUMBNAIL_BODY_LENGTH
        ? `${[...section.body].slice(0, THUMBNAIL_BODY_LENGTH).join("").trimEnd()}…`
        : section.body,
    })),
  };
}

/**
 * The theme a preview draws: the `?theme=` value when it is exactly a known
 * key; otherwise (missing, repeated, unknown) the wedding's current theme.
 * The raw value is never echoed back or stored.
 */
export function previewThemeKey(
  raw: string | string[] | undefined,
  current: WeddingSiteThemeKey = DEFAULT_WEDDING_SITE_THEME,
): WeddingSiteThemeKey {
  return isWeddingSiteThemeKey(raw) ? raw : current;
}

/** The organizer preview path for a theme (lookup keys only). */
export function sitePreviewPath(weddingId: string, themeKey: WeddingSiteThemeKey): string {
  return `/app/weddings/${encodeURIComponent(weddingId)}/site/preview?theme=${themeKey}`;
}
