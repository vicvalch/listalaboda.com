/**
 * Wedding site themes (ADR-019): presentation only. A theme decides how the
 * published content looks, never what it says: it holds no wedding data (no
 * names, dates, places, guests, RSVP links or tokens), no copy and no user
 * input, and every option is a closed value that the renderer maps to its own
 * markup and classes. Nothing here is a CSS, class name, HTML or URL string.
 *
 * A key is never removed, so a stored choice always resolves. Classic is
 * the original public page, unchanged, and every wedding without a stored
 * choice. Members choose a theme in the site editor (CP5); the public read
 * returns it (CP4). Each theme also lists the closed options a wedding may
 * pick instead of its defaults (CP6, `options`); a stored customization
 * holds only those choices, never resolved values.
 */

/** Closed set of theme keys; mirrored by the `wedding_site_theme` database enum. */
export const WEDDING_SITE_THEME_KEYS = ["classic", "editorial", "minimal", "romantic", "tropical"] as const;

export type WeddingSiteThemeKey = (typeof WEDDING_SITE_THEME_KEYS)[number];

/** The site that has no design choice, and the fallback for anything unknown. */
export const DEFAULT_WEDDING_SITE_THEME: WeddingSiteThemeKey = "classic";

/**
 * Color tokens. `app` is the app's own global palette (Classic's original
 * look); the others are site palettes defined in `globals.css`, each with a
 * light and a dark variant that follows the visitor's preference. Every
 * palette belongs to one theme's presets (CP6); its key is what a wedding
 * stores, never a color.
 */
export const SITE_PALETTES = [
  "app",
  "warm",
  "slate",
  "ivory",
  "parchment",
  "charcoal",
  "mono",
  "stone",
  "ink",
  "rose",
  "wine",
  "champagne",
  "sand",
  "forest",
  "sunset",
] as const;
export type SitePalette = (typeof SITE_PALETTES)[number];

/**
 * Font pairing: `system` inherits the app font; `serif` sets serif text with
 * sans labels; `sans` is all sans; `italic` is serif text with italic serif
 * headings; `mixed` is serif headings over sans text. System font stacks
 * only: nothing is downloaded.
 */
export const TYPOGRAPHIES = ["system", "serif", "sans", "italic", "mixed"] as const;
export type Typography = (typeof TYPOGRAPHIES)[number];

/** Size, weight and tracking of the name and the section headings. */
export const HEADING_SCALES = ["regular", "display", "compact"] as const;
export type HeadingScale = (typeof HEADING_SCALES)[number];

/** How the site's opening (name, date, city) is laid out. */
export const HERO_VARIANTS = ["simple", "editorial", "grid", "framed", "banner"] as const;
export type HeroVariant = (typeof HERO_VARIANTS)[number];

/** How wide the site's column is. */
export const CONTENT_WIDTHS = ["narrow", "regular", "wide"] as const;
export type ContentWidth = (typeof CONTENT_WIDTHS)[number];

/** Vertical rhythm: page padding and the space between sections. */
export const DENSITIES = ["compact", "regular", "airy"] as const;
export type Density = (typeof DENSITIES)[number];

/** Where the opening and the footer line up. */
export const ALIGNMENTS = ["center", "start"] as const;
export type Alignment = (typeof ALIGNMENTS)[number];

/** How each content section is drawn. */
export const SECTION_STYLES = ["plain", "editorial", "ruled", "centered", "tiles"] as const;
export type SectionStyle = (typeof SECTION_STYLES)[number];

/** A static decoration drawn by the renderer (never an asset or URL). Not customizable. */
export type Ornament = "none" | "rule" | "flourish" | "frond";

/**
 * The presentation values a wedding may override (CP6), each one a closed
 * vocabulary. The ornament belongs to the theme and is never customized.
 */
export const CUSTOMIZABLE_FIELDS = [
  "palette",
  "typography",
  "headingScale",
  "hero",
  "width",
  "density",
  "alignment",
  "sectionStyle",
] as const;
export type CustomizableField = (typeof CUSTOMIZABLE_FIELDS)[number];

/** Every value of each customizable field, whatever the theme. */
export const FIELD_VOCABULARY = {
  palette: SITE_PALETTES,
  typography: TYPOGRAPHIES,
  headingScale: HEADING_SCALES,
  hero: HERO_VARIANTS,
  width: CONTENT_WIDTHS,
  density: DENSITIES,
  alignment: ALIGNMENTS,
  sectionStyle: SECTION_STYLES,
} as const satisfies { [F in CustomizableField]: readonly string[] };

type ThemeValues = Readonly<{
  palette: SitePalette;
  typography: Typography;
  headingScale: HeadingScale;
  hero: HeroVariant;
  width: ContentWidth;
  density: Density;
  alignment: Alignment;
  sectionStyle: SectionStyle;
}>;

/**
 * What a theme lets a wedding choose for each customizable field (CP6): the
 * theme's own default first, then the alternatives that keep the theme's
 * character. A field with a single value is fixed by the theme. The only
 * list of allowed options: the parser, the organizer controls and the
 * preview all read it (the database validator mirrors it, checked by tests).
 */
export type ThemeOptions = Readonly<{ [F in CustomizableField]: readonly ThemeValues[F][] }>;

/**
 * A theme: its default for every value (what an uncustomized site draws),
 * its decoration, and the closed options a wedding may pick instead.
 */
export type ThemeDefinition = ThemeValues &
  Readonly<{
    key: WeddingSiteThemeKey;
    ornament: Ornament;
    options: ThemeOptions;
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
  options: {
    palette: ["app", "warm", "slate"],
    typography: ["system", "serif", "mixed"],
    headingScale: ["regular", "display"],
    hero: ["simple", "editorial"],
    width: ["regular", "narrow", "wide"],
    density: ["regular", "compact", "airy"],
    alignment: ["center", "start"],
    sectionStyle: ["plain", "editorial", "ruled"],
  },
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
  options: {
    palette: ["ivory", "parchment", "charcoal"],
    typography: ["serif", "italic", "mixed"],
    headingScale: ["display", "regular"],
    hero: ["editorial", "simple", "framed"],
    width: ["narrow", "regular"],
    density: ["airy", "regular"],
    alignment: ["center", "start"],
    sectionStyle: ["editorial", "plain"],
  },
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
  options: {
    palette: ["mono", "stone", "ink"],
    typography: ["sans", "serif", "mixed"],
    headingScale: ["compact", "regular"],
    hero: ["grid", "simple"],
    width: ["wide", "regular"],
    density: ["compact", "regular"],
    alignment: ["start"],
    sectionStyle: ["ruled", "plain"],
  },
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
  options: {
    palette: ["rose", "wine", "champagne"],
    typography: ["italic", "serif", "mixed"],
    headingScale: ["display", "regular"],
    hero: ["framed", "editorial", "simple"],
    width: ["regular", "narrow"],
    density: ["airy", "regular"],
    alignment: ["center"],
    sectionStyle: ["centered", "editorial", "plain"],
  },
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
  options: {
    palette: ["sand", "forest", "sunset"],
    typography: ["mixed", "serif", "sans"],
    headingScale: ["display", "regular"],
    hero: ["banner", "editorial", "simple"],
    width: ["regular", "narrow", "wide"],
    density: ["compact", "regular", "airy"],
    alignment: ["start", "center"],
    sectionStyle: ["tiles", "editorial", "plain"],
  },
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
