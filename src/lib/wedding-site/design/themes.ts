/**
 * Wedding site themes (ADR-019): presentation only. A theme decides how the
 * published content looks, never what it says: it holds no wedding data (no
 * names, dates, places, guests, RSVP links or tokens), no copy and no user
 * input, and every option is a closed value that the renderer maps to its own
 * markup and classes. Nothing here is a CSS, class name, HTML or URL string.
 *
 * A key is never removed, so a stored choice always resolves. Classic is
 * today's public page, unchanged. Editorial, Minimal, Romantic and Tropical
 * exist in code only (CP2, CP3): nothing stores or selects a theme yet, so
 * every public site is still Classic.
 */

/** Closed set of theme keys. Becomes the database enum once designs are stored (CP4). */
export const WEDDING_SITE_THEME_KEYS = ["classic", "editorial", "minimal", "romantic", "tropical"] as const;

export type WeddingSiteThemeKey = (typeof WEDDING_SITE_THEME_KEYS)[number];

/** The site that has no design choice, and the fallback for anything unknown. */
export const DEFAULT_WEDDING_SITE_THEME: WeddingSiteThemeKey = "classic";

/**
 * Color tokens. `app` is the app's own global palette (Classic); the others
 * are site palettes defined in `globals.css`, each with a light and a dark
 * variant that follows the visitor's preference.
 */
export type SitePalette = "app" | "ivory" | "mono" | "rose" | "sand";

/**
 * Font pairing: `system` inherits the app font; `serif` sets serif text with
 * sans labels; `sans` is all sans; `italic` is serif text with italic serif
 * headings; `mixed` is serif headings over sans text.
 */
export type Typography = "system" | "serif" | "sans" | "italic" | "mixed";

/** Size, weight and tracking of the name and the section headings. */
export type HeadingScale = "regular" | "display" | "compact";

/** How the site's opening (name, date, city) is laid out. */
export type HeroVariant = "simple" | "editorial" | "grid" | "framed" | "banner";

/** How wide the site's column is. */
export type ContentWidth = "regular" | "narrow" | "wide";

/** Vertical rhythm: page padding and the space between sections. */
export type Density = "regular" | "airy" | "compact";

/** Where the opening and the footer line up. */
export type Alignment = "center" | "start";

/** How each content section is drawn. */
export type SectionStyle = "plain" | "editorial" | "ruled" | "centered" | "tiles";

/** A static decoration drawn by the renderer (never an asset or URL). */
export type Ornament = "none" | "rule" | "flourish" | "frond";

export type ThemeDefinition = Readonly<{
  key: WeddingSiteThemeKey;
  palette: SitePalette;
  typography: Typography;
  headingScale: HeadingScale;
  hero: HeroVariant;
  width: ContentWidth;
  density: Density;
  alignment: Alignment;
  sectionStyle: SectionStyle;
  ornament: Ornament;
}>;

export type ThemeRegistry = Readonly<Record<WeddingSiteThemeKey, ThemeDefinition>>;

/**
 * Classic: the original public site. A centered header and plain sections
 * in a regular column, drawn with the app's global color tokens (so it
 * follows the visitor's light/dark preference) and the system font.
 */
const CLASSIC: ThemeDefinition = {
  key: "classic",
  palette: "app",
  typography: "system",
  headingScale: "regular",
  hero: "simple",
  width: "regular",
  density: "regular",
  alignment: "center",
  sectionStyle: "plain",
  ornament: "none",
};

/**
 * Editorial: a magazine feel. Serif text on ivory paper, a large light name
 * over a fine rule, generous whitespace and a narrow reading column.
 */
const EDITORIAL: ThemeDefinition = {
  key: "editorial",
  palette: "ivory",
  typography: "serif",
  headingScale: "display",
  hero: "editorial",
  width: "narrow",
  density: "airy",
  alignment: "center",
  sectionStyle: "editorial",
  ornament: "rule",
};

/**
 * Minimal: restrained and neutral. Sans-serif on a monochrome palette, a
 * left-aligned opening and sections on a two-column grid split by hairlines.
 */
const MINIMAL: ThemeDefinition = {
  key: "minimal",
  palette: "mono",
  typography: "sans",
  headingScale: "compact",
  hero: "grid",
  width: "wide",
  density: "compact",
  alignment: "start",
  sectionStyle: "ruled",
  ornament: "none",
};

/**
 * Romantic: warm and graceful. Italic serif headings on a soft rose-paper
 * palette, the opening inside a fine double frame with a drawn flourish, and
 * centered sections with plenty of air. No hearts, florals or script fonts.
 */
const ROMANTIC: ThemeDefinition = {
  key: "romantic",
  palette: "rose",
  typography: "italic",
  headingScale: "display",
  hero: "framed",
  width: "regular",
  density: "airy",
  alignment: "center",
  sectionStyle: "centered",
  ornament: "flourish",
};

/**
 * Tropical: a fresh destination look. Sand and deep botanical green with a
 * terracotta accent, the opening on a solid green band with a line-drawn
 * frond, serif headings over sans text and sections as tinted tiles.
 */
const TROPICAL: ThemeDefinition = {
  key: "tropical",
  palette: "sand",
  typography: "mixed",
  headingScale: "display",
  hero: "banner",
  width: "regular",
  density: "compact",
  alignment: "start",
  sectionStyle: "tiles",
  ornament: "frond",
};

export const THEME_REGISTRY: ThemeRegistry = {
  classic: CLASSIC,
  editorial: EDITORIAL,
  minimal: MINIMAL,
  romantic: ROMANTIC,
  tropical: TROPICAL,
};

export function isWeddingSiteThemeKey(value: unknown): value is WeddingSiteThemeKey {
  return typeof value === "string" && (WEDDING_SITE_THEME_KEYS as readonly string[]).includes(value);
}

/** The theme for a key; no key or an unknown one is Classic, never an error. */
export function getTheme(key: string | null | undefined): ThemeDefinition {
  return THEME_REGISTRY[isWeddingSiteThemeKey(key) ? key : DEFAULT_WEDDING_SITE_THEME];
}
