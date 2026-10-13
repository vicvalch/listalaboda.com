import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { customColorStyle, CUSTOM_COLOR_PROPERTIES } from "@/components/wedding-site/styles";
import { WeddingSite } from "@/components/wedding-site/WeddingSite";
import {
  checkContrast,
  COLOR_PARAMS,
  contrastRatio,
  CONTRAST_PAIRS,
  CUSTOM_COLOR_SEEDS,
  isCanonicalHex,
  MIN_CONTRAST,
  normalizeHexInput,
  parseSiteColors,
  relativeLuminance,
  SITE_COLOR_ROLES,
  type SiteColors,
} from "@/lib/wedding-site/design/colors";
import {
  customizationDocument,
  customizedGroups,
  overridesForTheme,
  parseCustomization,
  readCustomization,
  resetOverrides,
  sameOverrides,
  toStoredCustomization,
  MAX_CUSTOMIZATION_BYTES,
  type SiteOverrides,
} from "@/lib/wedding-site/design/customization";
import { resolveSiteDesign, toWeddingSiteDesign } from "@/lib/wedding-site/design/resolve";
import { THEME_REGISTRY, WEDDING_SITE_THEME_KEYS } from "@/lib/wedding-site/design/themes";
import { previewDesign, siteCustomPreviewPath } from "@/lib/wedding-site/preview";

import { CUSTOM_COLORS_DARK, CUSTOM_COLORS_LIGHT } from "./fixtures/wedding-site-customizations";
import { THEME_FIXTURES } from "./fixtures/wedding-site-themes";

// Custom colors (ADR-019 §11, CP7): six semantic roles, canonical #rrggbb,
// all or nothing, WCAG AA for every pair drawn, light mode only, mutually
// exclusive with a palette preset.

const doc = (groups: Record<string, unknown>) => ({ schemaVersion: 1, ...groups });
const withColor = (role: string, value: unknown) => ({ ...CUSTOM_COLORS_LIGHT, [role]: value });

/** Values that must never be accepted as a color, nor reach the markup. */
const HOSTILE: Array<[string, unknown]> = [
  ["<script>", "<script>alert(1)</script>"],
  ["url(...)", "url(https://evil.test/x.png)"],
  ["var(--x)", "var(--x)"],
  ["expression(...)", "expression(alert(1))"],
  ["javascript:", "javascript:alert(1)"],
  ["a named color", "red"],
  ["rgb()", "rgb(0,0,0)"],
  ["rgba()", "rgba(0,0,0,1)"],
  ["hsl()", "hsl(0,0%,0%)"],
  ["hsla()", "hsla(0,0%,0%,1)"],
  ["color()", "color(srgb 0 0 0)"],
  ["currentColor", "currentColor"],
  ["transparent", "transparent"],
  ["a gradient", "linear-gradient(#000,#fff)"],
  ["3-digit hex", "#fff"],
  ["4-digit hex", "#ffff"],
  ["8-digit hex", "#ffffffff"],
  ["uppercase hex", "#FFFFFF"],
  ["hex without #", "ffffff"],
  ["a leading space", " #ffffff"],
  ["a trailing space", "#ffffff "],
  ["a newline injection", "#ffffff\n;background:red"],
  ["a trailing newline", "#fffff\n"],
  ["a declaration break-out", '";background:red'],
  ["a semicolon break-out", "#ffffff;background:url(x)"],
  ["a very long string", `#${"f".repeat(5000)}`],
  ["non-hex digits", "#gggggg"],
  ["an object", { r: 0, g: 0, b: 0 }],
  ["an array", ["#ffffff"]],
  ["null", null],
  ["a number", 16777215],
  ["a boolean", true],
];

describe("color format", () => {
  it.each(["#000000", "#ffffff", "#0f5c55", "#a1b2c3"])("accepts canonical %s", (value) => {
    expect(isCanonicalHex(value)).toBe(true);
  });

  it.each(HOSTILE)("refuses %s", (_label, value) => {
    expect(isCanonicalHex(value)).toBe(false);
  });

  it("the form layer lowercases an uppercase code and repairs nothing else", () => {
    expect(normalizeHexInput("#A1B2C3")).toBe("#a1b2c3");
    expect(normalizeHexInput("#a1b2c3")).toBe("#a1b2c3");
    for (const value of ["#FFF", " #A1B2C3", "#A1B2C3 ", "A1B2C3", "#A1B2C3\n", "#GGGGGG", "", "#A1B2C3D4"]) {
      expect(normalizeHexInput(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("contrast", () => {
  it("computes WCAG 2.x luminance and ratios", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 10);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 10);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
    // A well-known pair just under AA (4.48:1).
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  it("checks exactly the pairs the renderer draws", () => {
    expect(CONTRAST_PAIRS.map(({ foreground, background }) => `${foreground}/${background}`)).toEqual([
      "text/background",
      "muted/background",
      "text/surface",
      "muted/surface",
      "accent/background",
      "accent/surface",
      "accentText/accent",
    ]);
    expect(MIN_CONTRAST).toBe(4.5);
  });

  it.each(CONTRAST_PAIRS.map((pair) => [pair.id, pair] as const))("refuses a palette failing only %s", (id, pair) => {
    // Start from a passing palette and make one pair's colors identical-ish.
    const colors: Record<string, string> = { ...CUSTOM_COLORS_LIGHT };
    colors[pair.foreground] = colors[pair.background];
    const failing = checkContrast(colors as SiteColors).filter((check) => !check.ok).map((check) => check.id);
    expect(failing).toContain(id);
    expect(parseSiteColors(colors)).toEqual({ ok: false, reason: "insufficient_contrast" });
  });

  it("every seed and fixture palette passes every pair", () => {
    for (const colors of [...Object.values(CUSTOM_COLOR_SEEDS), CUSTOM_COLORS_LIGHT, CUSTOM_COLORS_DARK]) {
      expect(checkContrast(colors).every((check) => check.ok && check.ratio >= MIN_CONTRAST)).toBe(true);
      expect(parseSiteColors(colors)).toEqual({ ok: true, colors });
    }
    expect(Object.keys(CUSTOM_COLOR_SEEDS)).toEqual([...WEDDING_SITE_THEME_KEYS]);
  });
});

describe("parseSiteColors: all or nothing", () => {
  it.each([
    ["a partial palette", { background: "#ffffff", text: "#111111" }],
    ["an empty object", {}],
    ["an extra role", { ...CUSTOM_COLORS_LIGHT, border: "#cccccc" }],
    ["a renamed role", { ...Object.fromEntries(Object.entries(CUSTOM_COLORS_LIGHT).filter(([role]) => role !== "accentText")), accent_text: "#ffffff" }],
    ["an array", Object.values(CUSTOM_COLORS_LIGHT)],
    ["a string", "#ffffff"],
    ["null", null],
  ])("refuses %s as invalid_color", (_label, raw) => {
    expect(parseSiteColors(raw)).toEqual({ ok: false, reason: "invalid_color" });
  });

  it.each(HOSTILE)("refuses %s in any role as invalid_color", (_label, value) => {
    for (const role of SITE_COLOR_ROLES) {
      expect(parseSiteColors(withColor(role, value)), role).toEqual({ ok: false, reason: "invalid_color" });
    }
  });
});

describe("customization documents with colors", () => {
  it.each(WEDDING_SITE_THEME_KEYS)("%s accepts a complete accessible palette, stored as given", (theme) => {
    const stored = doc({ colors: CUSTOM_COLORS_LIGHT });
    expect(parseCustomization(theme, stored)).toEqual({ ok: true, overrides: { colors: CUSTOM_COLORS_LIGHT } });
    expect(toStoredCustomization({ colors: CUSTOM_COLORS_LIGHT })).toEqual(stored);
  });

  it("refuses a preset and custom colors together (contradictory)", () => {
    const both = doc({ palette: { kind: "preset", key: "parchment" }, colors: CUSTOM_COLORS_LIGHT });
    expect(parseCustomization("editorial", both)).toEqual({ ok: false, reason: "invalid_customization" });
  });

  it("returns closed reasons: invalid_color, insufficient_contrast", () => {
    expect(parseCustomization("editorial", doc({ colors: withColor("text", "#FFF") }))).toEqual({
      ok: false,
      reason: "invalid_color",
    });
    expect(parseCustomization("editorial", doc({ colors: withColor("text", "#999999") }))).toEqual({
      ok: false,
      reason: "insufficient_contrast",
    });
  });

  it("never normalizes a stored document: uppercase is refused", () => {
    expect(parseCustomization("editorial", doc({ colors: withColor("background", "#F3F7F6") })).ok).toBe(false);
  });

  it("the largest valid document stays far below the byte cap", () => {
    const longest = doc({
      typography: { pairing: "italic", headingScale: "regular" },
      hero: { variant: "editorial" },
      layout: { width: "regular", density: "regular", alignment: "start", sectionStyle: "editorial" },
      colors: CUSTOM_COLORS_LIGHT,
    });
    expect(parseCustomization("romantic", longest).ok).toBe(false); // romantic fixes alignment
    const size = new TextEncoder().encode(JSON.stringify(longest)).length;
    expect(size).toBeLessThan(500);
    expect(size).toBeLessThan(MAX_CUSTOMIZATION_BYTES / 2);
  });

  it("a form document carries colors without a preset", () => {
    expect(customizationDocument({ typography: "mixed", colors: CUSTOM_COLORS_LIGHT })).toEqual(
      doc({ typography: { pairing: "mixed" }, colors: CUSTOM_COLORS_LIGHT }),
    );
  });
});

describe("render-time re-validation (lenient, whole palette)", () => {
  it("keeps a valid stored palette", () => {
    expect(readCustomization("minimal", doc({ colors: CUSTOM_COLORS_DARK }))).toEqual({ colors: CUSTOM_COLORS_DARK });
  });

  it.each([
    ["a malformed color", doc({ palette: { kind: "preset", key: "stone" }, colors: withColor("accent", "red") })],
    ["a low-contrast palette", doc({ palette: { kind: "preset", key: "stone" }, colors: withColor("muted", "#dddddd") })],
    ["a partial palette", doc({ palette: { kind: "preset", key: "stone" }, colors: { background: "#ffffff" } })],
    ["a preset next to valid colors", doc({ palette: { kind: "preset", key: "stone" }, colors: CUSTOM_COLORS_LIGHT })],
  ])("ignores %s whole and keeps the saved preset", (_label, stored) => {
    expect(readCustomization("minimal", stored)).toEqual({ palette: "stone" });
    const design = resolveSiteDesign("minimal", readCustomization("minimal", stored));
    expect(design.colors).toBeNull();
    expect(design.palette).toBe("stone");
  });

  it("an invalid palette alone falls back to the theme's palette", () => {
    const design = resolveSiteDesign("tropical", readCustomization("tropical", doc({ colors: withColor("text", "#f5efe3") })));
    expect(design).toMatchObject({ palette: "sand", colors: null });
  });

  it("resolveSiteDesign re-checks colors whatever their source", () => {
    const forged = { colors: { ...CUSTOM_COLORS_LIGHT, background: "url(x)" } } as SiteOverrides;
    expect(resolveSiteDesign("editorial", forged).colors).toBeNull();
    expect(resolveSiteDesign("editorial", { colors: CUSTOM_COLORS_LIGHT }).colors).toEqual(CUSTOM_COLORS_LIGHT);
  });

  it("custom colors replace a preset: the theme's own palette stays underneath (for dark mode)", () => {
    const design = resolveSiteDesign("editorial", { palette: "charcoal", colors: CUSTOM_COLORS_LIGHT });
    expect(design).toMatchObject({ palette: "ivory", colors: CUSTOM_COLORS_LIGHT });
  });

  it("an unknown theme stays uncustomized Classic", () => {
    expect(toWeddingSiteDesign("neon", doc({ colors: CUSTOM_COLORS_LIGHT }))).toEqual({ themeKey: "classic", customization: {} });
  });
});

describe("theme change and reset", () => {
  it("custom colors carry over to every theme unchanged; a dropped preset never comes back", () => {
    const current: SiteOverrides = { colors: CUSTOM_COLORS_LIGHT, hero: "framed", typography: "italic" };
    for (const theme of WEDDING_SITE_THEME_KEYS) {
      const { overrides, dropped } = overridesForTheme(theme, current);
      expect(overrides.colors, theme).toEqual(CUSTOM_COLORS_LIGHT);
      expect(overrides.palette, theme).toBeUndefined();
      expect(dropped, theme).not.toContain("palette");
    }
  });

  it("reset colors removes only the palette; the other groups stay", () => {
    const current: SiteOverrides = { colors: CUSTOM_COLORS_LIGHT, width: "wide" };
    expect(customizedGroups(current)).toEqual(["layout", "colors"]);
    expect(resetOverrides(current, "colors")).toEqual({ width: "wide" });
    expect(resetOverrides(current, "palette")).toEqual(current);
    expect(resetOverrides(current, "all")).toEqual({});
  });

  it("compares palettes value by value", () => {
    expect(sameOverrides({ colors: CUSTOM_COLORS_LIGHT }, { colors: { ...CUSTOM_COLORS_LIGHT } })).toBe(true);
    expect(sameOverrides({ colors: CUSTOM_COLORS_LIGHT }, { colors: CUSTOM_COLORS_DARK })).toBe(false);
    expect(sameOverrides({ colors: CUSTOM_COLORS_LIGHT }, {})).toBe(false);
  });
});

describe("rendering safety", () => {
  const render = (design: ReturnType<typeof resolveSiteDesign>) =>
    renderToStaticMarkup(createElement(WeddingSite, { site: THEME_FIXTURES.full, design }));
  const styleOf = (html: string) => [...html.matchAll(/style="([^"]*)"/g)].map((match) => match[1]);

  it.each(WEDDING_SITE_THEME_KEYS)("%s: emits exactly the six fixed properties with canonical values", (theme) => {
    const html = render(resolveSiteDesign(theme, { colors: CUSTOM_COLORS_LIGHT }));
    const styles = styleOf(html);
    expect(styles).toHaveLength(1);
    expect(styles[0]).toBe(
      SITE_COLOR_ROLES.map((role) => `${CUSTOM_COLOR_PROPERTIES[role]}:${CUSTOM_COLORS_LIGHT[role]}`).join(";"),
    );
    expect(styles[0]).toMatch(/^(--site-custom-[a-z-]+:#[0-9a-f]{6};?){6}$/);
    expect(html).toContain('data-site-custom-colors=""');
    // The theme's own palette scope stays: it draws dark mode.
    const palette = THEME_REGISTRY[theme].palette;
    if (palette === "app") expect(html).not.toContain("data-site-palette");
    else expect(html).toContain(`data-site-palette="${palette}"`);
  });

  it("without custom colors there is no style attribute and no custom scope", () => {
    for (const theme of WEDDING_SITE_THEME_KEYS) {
      const html = render(resolveSiteDesign(theme));
      expect(html).not.toContain("style=");
      expect(html).not.toContain("data-site-custom-colors");
    }
  });

  it.each(HOSTILE)("%s never reaches class, href, src, style or text", (_label, value) => {
    // The page is exactly the uncustomized one: nothing of the value survives.
    const baseline = render(resolveSiteDesign("tropical"));
    for (const role of SITE_COLOR_ROLES) {
      const stored = doc({ colors: withColor(role, value) });
      const html = render(resolveSiteDesign("tropical", readCustomization("tropical", stored)));
      expect(html, role).toBe(baseline);
      expect(html).not.toContain("style=");
      expect(html).not.toMatch(/<script|javascript:|url\(|expression\(|var\(--x/);
      expect(html).not.toMatch(/\s(href|src)=/);
    }
  });

  it("customColorStyle refuses anything that isn't canonical (defense in depth)", () => {
    expect(customColorStyle({ ...CUSTOM_COLORS_LIGHT, accent: '#000000";x:y' })).toBeNull();
    expect(customColorStyle({ ...CUSTOM_COLORS_LIGHT, accent: "red" })).toBeNull();
    expect(Object.keys(customColorStyle(CUSTOM_COLORS_LIGHT) ?? {})).toEqual(Object.values(CUSTOM_COLOR_PROPERTIES));
  });
});

describe("stylesheet: light mode only", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const block = css.match(/@media not \(prefers-color-scheme: dark\) \{\s*\[data-site-custom-colors\] \{([^}]*)\}\s*\}/);

  it("maps the custom properties onto every site token, inside a not-dark media query only", () => {
    expect(block).not.toBeNull();
    const declarations = Object.fromEntries(
      [...(block?.[1] ?? "").matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]),
    );
    expect(declarations).toMatchObject({
      "--background": "var(--site-custom-background)",
      "--surface": "var(--site-custom-surface)",
      "--foreground": "var(--site-custom-text)",
      "--muted": "var(--site-custom-muted)",
      "--accent": "var(--site-custom-accent)",
      "--accent-foreground": "var(--site-custom-accent-text)",
      // Tiles draw text and accent headings on the surface; the band draws
      // accent text on the accent: both are checked pairs.
      "--accent-soft": "var(--site-custom-surface)",
      "--site-band": "var(--site-custom-accent)",
      "--site-band-text": "var(--site-custom-accent-text)",
      "--focus": "var(--site-custom-accent)",
    });
    // Every token a palette sets is replaced, so no preset color shows through in light mode.
    for (const token of ["--border", "--site-ornament", "--accent-hover"]) expect(declarations[token], token).toBeDefined();
    // Only the six fixed custom properties are read.
    const read = new Set([...(block?.[1] ?? "").matchAll(/var\((--[\w-]+)\)/g)].map((match) => match[1]));
    expect([...read].sort()).toEqual(Object.values(CUSTOM_COLOR_PROPERTIES).sort());
  });

  it("comes after every palette (same specificity: it wins in light mode) and never in the dark block", () => {
    const at = css.indexOf("@media not (prefers-color-scheme: dark)");
    expect(at).toBeGreaterThan(css.lastIndexOf("[data-site-palette="));
    expect(css.match(/\[data-site-custom-colors\]/g)).toHaveLength(1);
  });
});

describe("preview of unsaved colors", () => {
  const current = { themeKey: "editorial" as const, customization: {} };
  const query = (colors: Record<string, string | string[]>) => ({
    theme: "editorial",
    customize: "1",
    palette: "custom",
    ...Object.fromEntries(SITE_COLOR_ROLES.map((role) => [COLOR_PARAMS[role], CUSTOM_COLORS_LIGHT[role]])),
    ...colors,
  });

  it("round-trips through fixed parameter names, never JSON", () => {
    const path = siteCustomPreviewPath("w", { themeKey: "editorial", customization: { colors: CUSTOM_COLORS_LIGHT, width: "regular" } });
    const url = new URL(path, "http://x.test");
    expect([...url.searchParams.keys()].sort()).toEqual(
      ["customize", "palette", "theme", "width", ...Object.values(COLOR_PARAMS)].sort(),
    );
    expect(path).not.toMatch(/[{}]|%7B/);
    const parsed = previewDesign(Object.fromEntries(url.searchParams), current);
    expect(parsed).toEqual({ design: { themeKey: "editorial", customization: { colors: CUSTOM_COLORS_LIGHT, width: "regular" } }, custom: true });
  });

  it.each([
    ["a malformed value", { colorText: "red" }],
    ["a repeated parameter", { colorText: ["#10201d", "#10201d"] }],
    ["low contrast", { colorText: "#f3f7f6" }],
    ["an oversized value", { colorText: `#${"0".repeat(500)}` }],
  ])("ignores %s: the whole palette falls back to the theme's", (_label, override) => {
    expect(previewDesign(query(override), current).design.customization).toEqual({});
  });

  it("colors are only read with palette=custom", () => {
    const withoutPalette = Object.fromEntries(Object.entries(query({})).filter(([name]) => name !== "palette"));
    expect(previewDesign(withoutPalette, current).design.customization).toEqual({});
    expect(previewDesign({ ...withoutPalette, palette: "parchment" }, current).design.customization).toEqual({ palette: "parchment" });
  });
});
