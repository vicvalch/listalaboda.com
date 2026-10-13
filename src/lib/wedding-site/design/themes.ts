/**
 * Wedding site themes (ADR-019): presentation only. A theme decides how the
 * published content looks, never what it says: it holds no wedding data (no
 * names, dates, places, guests, RSVP links or tokens), no copy and no user
 * input, and every option is a closed value that the renderer maps to its own
 * markup and classes. Nothing here is a CSS, class name, HTML or URL string.
 *
 * Only Classic exists so far (CP1): today's public page, unchanged. Later
 * themes are added as new keys with their own definitions; a key is never
 * removed, so a stored choice always resolves.
 */

/** Closed set of theme keys. Becomes the database enum once designs are stored (CP4). */
export const WEDDING_SITE_THEME_KEYS = ["classic"] as const;

export type WeddingSiteThemeKey = (typeof WEDDING_SITE_THEME_KEYS)[number];

/** The site that has no design choice, and the fallback for anything unknown. */
export const DEFAULT_WEDDING_SITE_THEME: WeddingSiteThemeKey = "classic";

/** How the site's opening (name, date, city) is laid out. */
export type HeroVariant = "centered";

/** How wide the site's column is. */
export type ContentWidth = "regular";

/** How each content section is drawn. */
export type SectionStyle = "plain";

export type ThemeDefinition = Readonly<{
  key: WeddingSiteThemeKey;
  hero: HeroVariant;
  width: ContentWidth;
  sectionStyle: SectionStyle;
}>;

export type ThemeRegistry = Readonly<Record<WeddingSiteThemeKey, ThemeDefinition>>;

/**
 * Classic: the original public site. A centered header and plain sections
 * in a regular column, drawn with the app's global color tokens (so it
 * follows the visitor's light/dark preference) and the system font.
 */
const CLASSIC: ThemeDefinition = {
  key: "classic",
  hero: "centered",
  width: "regular",
  sectionStyle: "plain",
};

export const THEME_REGISTRY: ThemeRegistry = { classic: CLASSIC };

export function isWeddingSiteThemeKey(value: unknown): value is WeddingSiteThemeKey {
  return typeof value === "string" && (WEDDING_SITE_THEME_KEYS as readonly string[]).includes(value);
}

/** The theme for a key; no key or an unknown one is Classic, never an error. */
export function getTheme(key: string | null | undefined): ThemeDefinition {
  return THEME_REGISTRY[isWeddingSiteThemeKey(key) ? key : DEFAULT_WEDDING_SITE_THEME];
}
