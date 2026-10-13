import type { CSSProperties } from "react";

import { isCanonicalHex, SITE_COLOR_ROLES, type SiteColorRole, type SiteColors } from "@/lib/wedding-site/design/colors";
import type {
  Alignment,
  ContentWidth,
  Density,
  HeadingScale,
  SitePalette,
  Typography,
} from "@/lib/wedding-site/design/themes";

/**
 * The classes behind each closed design value (ADR-019). This is the only
 * place theme values become class names: they are fixed strings in code,
 * never built from data. Classic's entries compose to the original LB-10
 * markup exactly (golden tests in `src/test/__golden__/wedding-site-classic/`).
 */

/** Joins the class parts that are set. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Site palettes are CSS variables scoped by `data-site-palette` in
 * `globals.css`; they override the app tokens inside the page, so the same
 * token classes (`text-muted`, `border-border`, …) draw the theme's colors.
 * `app` (Classic) scopes nothing and inherits the page background.
 */
export const PALETTE_SURFACE: Record<SitePalette, string> = {
  app: "",
  warm: "bg-background text-foreground",
  slate: "bg-background text-foreground",
  ivory: "bg-background text-foreground",
  parchment: "bg-background text-foreground",
  charcoal: "bg-background text-foreground",
  mono: "bg-background text-foreground",
  stone: "bg-background text-foreground",
  ink: "bg-background text-foreground",
  rose: "bg-background text-foreground",
  wine: "bg-background text-foreground",
  champagne: "bg-background text-foreground",
  sand: "bg-background text-foreground",
  forest: "bg-background text-foreground",
  sunset: "bg-background text-foreground",
};

/**
 * Custom colors (CP7): the fixed CSS custom property each role is written
 * to. `globals.css` maps them onto the site tokens in LIGHT mode only
 * (`[data-site-custom-colors]`); dark mode keeps the theme's own palette.
 * These names are constants in code, never built from data.
 */
export const CUSTOM_COLOR_PROPERTIES: Record<SiteColorRole, `--site-custom-${string}`> = {
  background: "--site-custom-background",
  surface: "--site-custom-surface",
  text: "--site-custom-text",
  muted: "--site-custom-muted",
  accent: "--site-custom-accent",
  accentText: "--site-custom-accent-text",
};

/**
 * The inline style of a site with custom colors: exactly the six fixed
 * properties above, each set to its canonical `#rrggbb` value (checked again
 * here; the resolver already re-validated the palette). Nothing else can be
 * in it: no property name or value comes from anywhere but this map and a
 * value matching `^#[0-9a-f]{6}$`, so no declaration, selector or markup can
 * be injected. Null when anything isn't canonical (draw no custom colors).
 */
export function customColorStyle(colors: SiteColors): CSSProperties | null {
  const style: Record<string, string> = {};
  for (const role of SITE_COLOR_ROLES) {
    const value = colors[role];
    if (!isCanonicalHex(value)) return null;
    style[CUSTOM_COLOR_PROPERTIES[role]] = value;
  }
  return style as CSSProperties;
}

/**
 * `body` is the text font of the whole page; `heading` is added to the name
 * and the section headings; `label` is for small details lines and the footer.
 */
export const TYPOGRAPHY: Record<Typography, { body: string; heading: string; label: string }> = {
  system: { body: "", heading: "", label: "" },
  serif: { body: "font-serif", heading: "", label: "font-sans" },
  sans: { body: "font-sans", heading: "", label: "" },
  italic: { body: "font-serif", heading: "italic", label: "" },
  mixed: { body: "font-sans", heading: "font-serif", label: "" },
};

export const HEADING_SCALE: Record<HeadingScale, { name: string; section: string }> = {
  regular: {
    name: "text-3xl font-semibold tracking-tight break-words sm:text-4xl",
    section: "text-2xl font-semibold tracking-tight break-words",
  },
  display: {
    name: "text-4xl leading-tight font-normal tracking-tight break-words sm:text-6xl",
    section: "text-2xl font-normal tracking-tight break-words sm:text-3xl",
  },
  compact: {
    name: "text-3xl leading-tight font-semibold tracking-tight break-words sm:text-5xl",
    section: "text-xs font-semibold tracking-[0.16em] break-words uppercase",
  },
};

/** The couple's name and the section headings: the scale plus the pairing's heading style. */
export function nameClass(scale: HeadingScale, typography: Typography): string {
  return cx(HEADING_SCALE[scale].name, TYPOGRAPHY[typography].heading);
}

export function sectionHeadingClass(scale: HeadingScale, typography: Typography): string {
  return cx(HEADING_SCALE[scale].section, TYPOGRAPHY[typography].heading);
}

export const WIDTH: Record<ContentWidth, string> = {
  regular: "max-w-2xl",
  narrow: "max-w-xl",
  wide: "max-w-4xl",
};

/** `page`: the page's vertical padding; `stack`: space between the opening and sections; `footer`: space above the footer. */
export const DENSITY: Record<Density, { page: string; stack: string; footer: string }> = {
  regular: { page: "py-10 sm:py-16", stack: "space-y-10", footer: "mt-16" },
  airy: { page: "py-16 sm:py-28", stack: "space-y-16 sm:space-y-20", footer: "mt-20 sm:mt-28" },
  compact: { page: "py-10 sm:py-14", stack: "space-y-8", footer: "mt-12" },
};

export const ALIGN: Record<Alignment, string> = {
  center: "text-center",
  start: "text-start",
};
