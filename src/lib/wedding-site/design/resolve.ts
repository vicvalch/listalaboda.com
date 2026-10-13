import type { SiteColors } from "@/lib/wedding-site/design/colors";
import { normalizeOverrides, readCustomization, type SiteOverrides } from "@/lib/wedding-site/design/customization";
import {
  DEFAULT_WEDDING_SITE_THEME,
  getTheme,
  isWeddingSiteThemeKey,
  type ThemeDefinition,
  type WeddingSiteThemeKey,
} from "@/lib/wedding-site/design/themes";

/**
 * A wedding's stored design choice, as the reads return it next to the
 * content: the theme (CP4) and the overrides chosen among its options (CP6),
 * already re-read against that theme. Never inside `PublishedWeddingSite`:
 * content and presentation stay separate inputs.
 */
export type WeddingSiteDesign = Readonly<{ themeKey: WeddingSiteThemeKey; customization: SiteOverrides }>;

/** No design state: Classic, uncustomized. */
export const DEFAULT_WEDDING_SITE_DESIGN: WeddingSiteDesign = {
  themeKey: DEFAULT_WEDDING_SITE_THEME,
  customization: {},
};

/**
 * Reads stored design values (the public read's `site_theme` and
 * `site_customization`, or the editor's row) into a design. A missing
 * (a database without the column), null or unknown theme is uncustomized
 * Classic (its customization was chosen for another theme); a known theme's
 * customization is re-read leniently against it. A bad, older or newer value
 * can never break a public page.
 */
export function toWeddingSiteDesign(themeKey: unknown, customization?: unknown): WeddingSiteDesign {
  if (!isWeddingSiteThemeKey(themeKey)) return DEFAULT_WEDDING_SITE_DESIGN;
  return { themeKey, customization: readCustomization(themeKey, customization) };
}

/**
 * What the public renderer draws with: a complete set of closed presentation
 * values, with nothing optional or raw (no JSON, no user strings). It sits
 * next to the content DTO (`PublishedWeddingSite`), never inside it, so a
 * design never carries wedding data and content never carries layout.
 * `colors` is a complete, re-validated custom palette (canonical hex, WCAG
 * AA, light mode only; CP7) or null; with colors, `palette` is the theme's
 * own palette, which still draws dark mode.
 */
export type ResolvedSiteDesign = Readonly<
  { themeKey: WeddingSiteThemeKey; colors: SiteColors | null } & Omit<ThemeDefinition, "key" | "options">
>;

/**
 * Resolves a wedding's theme and overrides into its design: the theme's
 * defaults, with each override in place of its default. No choice or an
 * unknown key is Classic. The overrides are checked against the theme again
 * here, whatever their source (stored documents are first re-read by
 * `toWeddingSiteDesign`), so a value the theme doesn't offer keeps the
 * default and nothing unchecked reaches the renderer.
 */
export function resolveSiteDesign(themeKey: string | null | undefined, overrides: SiteOverrides = {}): ResolvedSiteDesign {
  const theme = getTheme(themeKey);
  const chosen = normalizeOverrides(theme.key, overrides);
  return {
    themeKey: theme.key,
    palette: chosen.palette ?? theme.palette,
    typography: chosen.typography ?? theme.typography,
    headingScale: chosen.headingScale ?? theme.headingScale,
    hero: chosen.hero ?? theme.hero,
    width: chosen.width ?? theme.width,
    density: chosen.density ?? theme.density,
    alignment: chosen.alignment ?? theme.alignment,
    sectionStyle: chosen.sectionStyle ?? theme.sectionStyle,
    ornament: theme.ornament,
    colors: chosen.colors ?? null,
  };
}

/** The design to draw for a wedding's stored design. */
export function resolveWeddingSiteDesign(design: WeddingSiteDesign): ResolvedSiteDesign {
  return resolveSiteDesign(design.themeKey, design.customization);
}
