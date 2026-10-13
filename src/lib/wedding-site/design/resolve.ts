import {
  getTheme,
  type ContentWidth,
  type HeroVariant,
  type SectionStyle,
  type WeddingSiteThemeKey,
} from "@/lib/wedding-site/design/themes";

/**
 * What the public renderer draws with: a complete set of closed presentation
 * values, with nothing optional or raw. It sits next to the content DTO
 * (`PublishedWeddingSite`), never inside it, so a design never carries
 * wedding data and content never carries layout.
 */
export type ResolvedSiteDesign = Readonly<{
  themeKey: WeddingSiteThemeKey;
  hero: HeroVariant;
  width: ContentWidth;
  sectionStyle: SectionStyle;
}>;

/**
 * Resolves a wedding's stored theme choice into its design. No choice (a
 * wedding without design state) or an unknown key is Classic, so a bad or
 * future value can never break a public page.
 */
export function resolveSiteDesign(themeKey: string | null | undefined): ResolvedSiteDesign {
  const theme = getTheme(themeKey);
  return {
    themeKey: theme.key,
    hero: theme.hero,
    width: theme.width,
    sectionStyle: theme.sectionStyle,
  };
}
