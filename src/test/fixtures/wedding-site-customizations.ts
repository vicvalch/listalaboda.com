import type { SiteColors } from "@/lib/wedding-site/design/colors";
import type { SiteOverrides } from "@/lib/wedding-site/design/customization";
import {
  CUSTOMIZABLE_FIELDS,
  THEME_REGISTRY,
  WEDDING_SITE_THEME_KEYS,
  type WeddingSiteThemeKey,
} from "@/lib/wedding-site/design/themes";

/**
 * Customized designs (ADR-019, CP6) for the markup snapshots and the E2E
 * visual check: every palette preset that isn't a theme's own (so every
 * palette in the stylesheet is drawn in a browser), and per theme one design
 * that takes the LAST option of every field (all alternatives at once, the
 * likeliest to break a layout). CP7 adds custom colors per theme: a light
 * palette on the theme's defaults, and a dark-background palette with every
 * alternative option (custom colors draw light mode only; dark mode keeps
 * the theme's palette).
 */
export type CustomizationFixture = Readonly<{ name: string; theme: WeddingSiteThemeKey; overrides: SiteOverrides }>;

/** An accessible light custom palette (every pair ≥ 6.6:1). */
export const CUSTOM_COLORS_LIGHT: SiteColors = {
  background: "#f3f7f6",
  surface: "#ffffff",
  text: "#10201d",
  muted: "#4a5b57",
  accent: "#0f5c55",
  accentText: "#ffffff",
};

/** An accessible custom palette with a dark background (every pair ≥ 7.9:1), still drawn in light mode only. */
export const CUSTOM_COLORS_DARK: SiteColors = {
  background: "#1d1b2e",
  surface: "#2a2740",
  text: "#f4f1ff",
  muted: "#c3bddb",
  accent: "#f2c46d",
  accentText: "#1d1b2e",
};

export const CUSTOMIZATION_FIXTURES: readonly CustomizationFixture[] = WEDDING_SITE_THEME_KEYS.flatMap((theme) => {
  const { options } = THEME_REGISTRY[theme];
  const presets = options.palette.slice(1).map((palette) => ({ name: `${theme}-${palette}`, theme, overrides: { palette } }));
  const last = Object.fromEntries(
    CUSTOMIZABLE_FIELDS.map((field) => [field, (options[field] as readonly string[]).at(-1)]),
  ) as SiteOverrides;
  // Custom colors replace the palette preset, so they never come with one.
  const lastWithoutPalette = Object.fromEntries(Object.entries(last).filter(([field]) => field !== "palette")) as SiteOverrides;
  return [
    ...presets,
    { name: `${theme}-alternatives`, theme, overrides: last },
    { name: `${theme}-custom`, theme, overrides: { colors: CUSTOM_COLORS_LIGHT } },
    { name: `${theme}-custom-alternatives`, theme, overrides: { ...lastWithoutPalette, colors: CUSTOM_COLORS_DARK } },
  ];
});
