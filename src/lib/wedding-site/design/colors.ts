import type { WeddingSiteThemeKey } from "@/lib/wedding-site/design/themes";

/**
 * Custom wedding site colors (ADR-019 §11, CP7): six semantic roles a
 * wedding may set instead of a palette preset, as canonical `#rrggbb` hex
 * values, light mode only. Pure (no React, database or server code), so the
 * organizer form checks contrast live with exactly the rules the write
 * parser, the render-time reader and (mirrored in SQL) the database use.
 *
 * A color is EXACTLY `#` + six lowercase hex digits. Nothing else is a color
 * here: no 3/4/8-digit hex, uppercase, whitespace, named colors, functions
 * (`rgb()`, `var()`, `url()`, …), keywords or gradients. The value is only
 * ever written into a fixed CSS custom property (`styles.ts`), so a canonical
 * hex string can't become a property, a selector or markup.
 */

/** The custom color roles, in form order. All six are always set together. */
export const SITE_COLOR_ROLES = ["background", "surface", "text", "muted", "accent", "accentText"] as const;
export type SiteColorRole = (typeof SITE_COLOR_ROLES)[number];

/** A complete custom palette, every value canonical `#rrggbb`. */
export type SiteColors = Readonly<Record<SiteColorRole, string>>;

/** WCAG AA for normal text. */
export const MIN_CONTRAST = 4.5;

/**
 * Every text/background combination the renderer draws with custom colors
 * (light mode): body text, secondary text and accent headings on the page
 * background and on surfaces (Tropical's tiles), and the text on the accent
 * color (Tropical's opening band). Each must reach `MIN_CONTRAST`.
 */
export const CONTRAST_PAIRS = [
  { id: "textBackground", foreground: "text", background: "background" },
  { id: "mutedBackground", foreground: "muted", background: "background" },
  { id: "textSurface", foreground: "text", background: "surface" },
  { id: "mutedSurface", foreground: "muted", background: "surface" },
  { id: "accentBackground", foreground: "accent", background: "background" },
  { id: "accentSurface", foreground: "accent", background: "surface" },
  { id: "accentTextAccent", foreground: "accentText", background: "accent" },
] as const satisfies ReadonlyArray<{ id: string; foreground: SiteColorRole; background: SiteColorRole }>;
export type ContrastPairId = (typeof CONTRAST_PAIRS)[number]["id"];

const HEX = /^#[0-9a-f]{6}$/;

/** Whether a value is a canonical color: a string of exactly `#` + six lowercase hex digits. */
export function isCanonicalHex(value: unknown): value is string {
  return typeof value === "string" && value.length === 7 && HEX.test(value);
}

/**
 * What a form field may type: canonical hex, or the same six digits in
 * uppercase (`#A1B2C3`), lowercased. Nothing else is accepted or repaired
 * (no trimming, no `#` added, no short forms). Documents are never
 * normalized: they must already be canonical.
 */
export function normalizeHexInput(value: string): string | null {
  if (value.length !== 7 || !/^#[0-9a-fA-F]{6}$/.test(value)) return null;
  return value.toLowerCase();
}

/** WCAG 2.x relative luminance of a canonical hex color. */
export function relativeLuminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio of two canonical hex colors (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export type ContrastCheck = Readonly<{ id: ContrastPairId; ratio: number; ok: boolean }>;

/** Every required pair of a complete palette, with its ratio. */
export function checkContrast(colors: SiteColors): ContrastCheck[] {
  return CONTRAST_PAIRS.map(({ id, foreground, background }) => {
    const ratio = contrastRatio(colors[foreground], colors[background]);
    return { id, ratio, ok: ratio >= MIN_CONTRAST };
  });
}

export type ColorsResult =
  | Readonly<{ ok: true; colors: SiteColors }>
  | Readonly<{ ok: false; reason: "invalid_color" | "insufficient_contrast" }>;

/**
 * Reads a document's `colors` group: an object with exactly the six roles,
 * each a canonical color, meeting every contrast pair. All or nothing: a
 * partial, malformed or low-contrast palette is never returned in part.
 */
export function parseSiteColors(raw: unknown): ColorsResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "invalid_color" };
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== SITE_COLOR_ROLES.length) return { ok: false, reason: "invalid_color" };
  const colors: Partial<Record<SiteColorRole, string>> = {};
  for (const role of SITE_COLOR_ROLES) {
    if (!Object.prototype.hasOwnProperty.call(record, role)) return { ok: false, reason: "invalid_color" };
    const value = record[role];
    if (!isCanonicalHex(value)) return { ok: false, reason: "invalid_color" };
    colors[role] = value;
  }
  const complete = colors as SiteColors;
  if (checkContrast(complete).some((check) => !check.ok)) return { ok: false, reason: "insufficient_contrast" };
  return { ok: true, colors: complete };
}

/** Whether two palettes (or their absence) are the same. */
export function sameColors(a: SiteColors | undefined, b: SiteColors | undefined): boolean {
  if (!a || !b) return a === b;
  return SITE_COLOR_ROLES.every((role) => a[role] === b[role]);
}

/**
 * Where the custom color form starts for a theme that has no custom palette
 * yet: the light colors of the theme's own palette (surface = its tile or
 * card color). Only starting values, never stored until saved; each passes
 * every contrast pair (tested).
 */
export const CUSTOM_COLOR_SEEDS: Readonly<Record<WeddingSiteThemeKey, SiteColors>> = {
  classic: { background: "#fdfaf7", surface: "#ffffff", text: "#2a2220", muted: "#6b5f5a", accent: "#9f3a4f", accentText: "#ffffff" },
  editorial: { background: "#fbf8f2", surface: "#ffffff", text: "#1f1b16", muted: "#675d52", accent: "#7f6230", accentText: "#ffffff" },
  minimal: { background: "#ffffff", surface: "#f5f5f5", text: "#111111", muted: "#5e5e5e", accent: "#111111", accentText: "#ffffff" },
  romantic: { background: "#faf5f1", surface: "#ffffff", text: "#2b1d1f", muted: "#6c5859", accent: "#8a4550", accentText: "#ffffff" },
  tropical: { background: "#f5efe3", surface: "#ebe3d1", text: "#1f2a24", muted: "#59605a", accent: "#2a5442", accentText: "#f5efe3" },
};

/**
 * The form and preview parameter of each role: fixed names, one canonical
 * color each (never JSON, never a free-form value).
 */
export const COLOR_PARAMS: Readonly<Record<SiteColorRole, string>> = {
  background: "colorBackground",
  surface: "colorSurface",
  text: "colorText",
  muted: "colorMuted",
  accent: "colorAccent",
  accentText: "colorAccentText",
};

/** The palette field's value for "custom colors" (never a palette preset key). */
export const CUSTOM_PALETTE_CHOICE = "custom";
