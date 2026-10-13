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
 * likeliest to break a layout).
 */
export type CustomizationFixture = Readonly<{ name: string; theme: WeddingSiteThemeKey; overrides: SiteOverrides }>;

export const CUSTOMIZATION_FIXTURES: readonly CustomizationFixture[] = WEDDING_SITE_THEME_KEYS.flatMap((theme) => {
  const { options } = THEME_REGISTRY[theme];
  const presets = options.palette.slice(1).map((palette) => ({ name: `${theme}-${palette}`, theme, overrides: { palette } }));
  const last = Object.fromEntries(
    CUSTOMIZABLE_FIELDS.map((field) => [field, (options[field] as readonly string[]).at(-1)]),
  ) as SiteOverrides;
  return [...presets, { name: `${theme}-alternatives`, theme, overrides: last }];
});
