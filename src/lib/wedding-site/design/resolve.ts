import {
  DEFAULT_WEDDING_SITE_THEME,
  getTheme,
  isWeddingSiteThemeKey,
  type ThemeDefinition,
  type WeddingSiteThemeKey,
} from "@/lib/wedding-site/design/themes";

/**
 * A wedding's stored design choice, as the public read returns it next to
 * the content (CP4: the theme only). Never inside `PublishedWeddingSite`:
 * content and presentation stay separate inputs.
 */
export type WeddingSiteDesign = Readonly<{ themeKey: WeddingSiteThemeKey }>;

/** No design state: Classic. */
export const DEFAULT_WEDDING_SITE_DESIGN: WeddingSiteDesign = { themeKey: DEFAULT_WEDDING_SITE_THEME };

/**
 * Reads a stored theme value (the public read's `site_theme`) into a design.
 * Missing (a database without the column), null or unknown is Classic, so a
 * bad, older or newer value can never break a public page.
 */
export function toWeddingSiteDesign(themeKey: unknown): WeddingSiteDesign {
  return { themeKey: isWeddingSiteThemeKey(themeKey) ? themeKey : DEFAULT_WEDDING_SITE_THEME };
}

/**
 * What the public renderer draws with: a complete set of closed presentation
 * values, with nothing optional or raw. It sits next to the content DTO
 * (`PublishedWeddingSite`), never inside it, so a design never carries
 * wedding data and content never carries layout.
 */
export type ResolvedSiteDesign = Readonly<{ themeKey: WeddingSiteThemeKey } & Omit<ThemeDefinition, "key">>;

/**
 * Resolves a wedding's stored theme choice into its design. No choice (a
 * wedding without design state) or an unknown key is Classic, so a bad or
 * future value can never break a public page.
 */
export function resolveSiteDesign(themeKey: string | null | undefined): ResolvedSiteDesign {
  const { key, ...values } = getTheme(themeKey);
  return { themeKey: key, ...values };
}
