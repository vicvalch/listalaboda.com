import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WeddingSite } from "@/components/wedding-site/WeddingSite";
import {
  CUSTOMIZATION_GROUPS,
  MAX_CUSTOMIZATION_BYTES,
  customizedGroups,
  overridesForTheme,
  parseCustomization,
  readCustomization,
  resetOverrides,
  toStoredCustomization,
  type SiteOverrides,
} from "@/lib/wedding-site/design/customization";
import { resolveSiteDesign, toWeddingSiteDesign } from "@/lib/wedding-site/design/resolve";
import {
  CUSTOMIZABLE_FIELDS,
  FIELD_VOCABULARY,
  SITE_PALETTES,
  THEME_REGISTRY,
  WEDDING_SITE_THEME_KEYS,
  type CustomizableField,
} from "@/lib/wedding-site/design/themes";
import { getMessages } from "@/lib/i18n";

import { THEME_FIXTURES } from "./fixtures/wedding-site-themes";

// Safe wedding site customization (ADR-019, CP6): closed per-theme options,
// stored as a versioned overrides-only document, checked on write (strict),
// re-read before every render (lenient) and resolved into a complete design.

const doc = (groups: Record<string, unknown>) => ({ schemaVersion: 1, ...groups });

describe("theme registry capabilities", () => {
  it.each(WEDDING_SITE_THEME_KEYS)("%s: every field offers its default first, closed values only, no repeats", (key) => {
    const theme = THEME_REGISTRY[key];
    for (const field of CUSTOMIZABLE_FIELDS) {
      const options = theme.options[field] as readonly string[];
      expect(options[0], field).toBe(theme[field]);
      expect(new Set(options).size, field).toBe(options.length);
      for (const value of options) expect(FIELD_VOCABULARY[field] as readonly string[], field).toContain(value);
    }
  });

  it("every palette belongs to exactly one theme, and each theme offers its own palette plus two presets", () => {
    const owners = SITE_PALETTES.map((palette) =>
      WEDDING_SITE_THEME_KEYS.filter((key) => (THEME_REGISTRY[key].options.palette as readonly string[]).includes(palette)),
    );
    for (const owner of owners) expect(owner).toHaveLength(1);
    for (const key of WEDDING_SITE_THEME_KEYS) expect(THEME_REGISTRY[key].options.palette).toHaveLength(3);
  });

  it("themes don't offer everything everywhere: the framed hero is not Minimal's, the band only Tropical's", () => {
    expect(THEME_REGISTRY.minimal.options.hero).not.toContain("framed");
    for (const key of WEDDING_SITE_THEME_KEYS) {
      expect(THEME_REGISTRY[key].options.hero.includes("banner")).toBe(key === "tropical");
      expect(THEME_REGISTRY[key].options.sectionStyle.includes("tiles")).toBe(key === "tropical");
    }
  });

  it("every option has a Spanish name, never the key itself", () => {
    const names = getMessages().site.customize.values;
    for (const field of CUSTOMIZABLE_FIELDS) {
      for (const value of FIELD_VOCABULARY[field]) {
        const name = (names[field] as Record<string, string>)[value];
        expect(name, `${field}.${value}`).toBeTruthy();
        expect(name, `${field}.${value}`).not.toBe(value);
      }
    }
  });
});

describe("parseCustomization (write, strict)", () => {
  it("accepts {}, a version-only document, one override and several", () => {
    expect(parseCustomization("editorial", {})).toEqual({ ok: true, overrides: {} });
    expect(parseCustomization("editorial", { schemaVersion: 1 })).toEqual({ ok: true, overrides: {} });
    expect(parseCustomization("editorial", doc({ palette: { kind: "preset", key: "parchment" } }))).toEqual({
      ok: true,
      overrides: { palette: "parchment" },
    });
    expect(
      parseCustomization(
        "tropical",
        doc({
          palette: { kind: "preset", key: "sunset" },
          typography: { pairing: "serif", headingScale: "regular" },
          hero: { variant: "simple" },
          layout: { width: "wide", density: "airy", alignment: "center", sectionStyle: "plain" },
        }),
      ),
    ).toEqual({
      ok: true,
      overrides: {
        palette: "sunset",
        typography: "serif",
        headingScale: "regular",
        hero: "simple",
        width: "wide",
        density: "airy",
        alignment: "center",
        sectionStyle: "plain",
      },
    });
  });

  it("normalizes: a choice equal to the theme's default is not an override", () => {
    expect(
      parseCustomization("editorial", doc({ palette: { kind: "preset", key: "ivory" }, layout: { density: "airy", width: "regular" } })),
    ).toEqual({ ok: true, overrides: { width: "regular" } });
  });

  it.each(WEDDING_SITE_THEME_KEYS)("%s: every option of every field is accepted, and nothing else", (key) => {
    const theme = THEME_REGISTRY[key];
    for (const field of CUSTOMIZABLE_FIELDS) {
      for (const value of FIELD_VOCABULARY[field]) {
        const allowed = (theme.options[field] as readonly string[]).includes(value);
        const result = parseCustomization(key, toStoredCustomization({ [field]: value } as SiteOverrides));
        expect(result.ok, `${key} ${field}=${value}`).toBe(allowed);
      }
    }
  });

  it.each([
    ["an unknown top-level key", doc({ fonts: { body: "Comic Sans" } })],
    ["an unknown top-level key next to valid ones", doc({ palette: { kind: "preset", key: "parchment" }, extra: true })],
    ["a wrong schemaVersion", { schemaVersion: 2, palette: { kind: "preset", key: "parchment" } }],
    ["schemaVersion as a string", { schemaVersion: "1" }],
    ["a missing schemaVersion on a non-empty document", { palette: { kind: "preset", key: "parchment" } }],
    ["an unknown preset", doc({ palette: { kind: "preset", key: "neon" } })],
    ["another theme's preset", doc({ palette: { kind: "preset", key: "rose" } })],
    ["a palette without kind", doc({ palette: { key: "parchment" } })],
    ["a palette of another kind", doc({ palette: { kind: "custom", key: "parchment" } })],
    ["a palette with an extra field", doc({ palette: { kind: "preset", key: "parchment", background: "#fff" } })],
    ["an invalid typography", doc({ typography: { pairing: "comic-sans" } })],
    ["a hero the theme doesn't offer", doc({ hero: { variant: "banner" } })],
    ["an invalid layout value", doc({ layout: { width: "full" } })],
    ["an extra nested key", doc({ layout: { width: "regular", gap: "2rem" } })],
    ["an empty group", doc({ layout: {} })],
    ["an array instead of an object", doc({ layout: ["regular"] })],
    ["a string instead of an object", doc({ hero: "simple" })],
    ["null instead of an object", doc({ hero: null })],
    ["a number value", doc({ layout: { width: 3 } })],
    ["a CSS-looking value", doc({ layout: { width: "max-width: 100vw" } })],
    ["url(...)", doc({ layout: { sectionStyle: "url(https://evil.test/x.png)" } })],
    ["<script>", doc({ hero: { variant: "<script>alert(1)</script>" } })],
    ["an arbitrary hex", doc({ palette: { kind: "preset", key: "#ff00aa" } })],
    ["an array document", [doc({})]],
    ["a string document", '{"schemaVersion":1}'],
    ["null", null],
    ["undefined", undefined],
    ["an oversized document", doc({ layout: { width: "regular" }, padding: "x".repeat(MAX_CUSTOMIZATION_BYTES) })],
  ])("refuses %s", (_label, raw) => {
    expect(parseCustomization("editorial", raw)).toEqual({ ok: false, reason: "invalid_customization" });
  });

  it("a document over the byte cap is refused even when every key is valid-looking", () => {
    const big = doc({ layout: { width: "regular", sectionStyle: "plain".padEnd(MAX_CUSTOMIZATION_BYTES, " ") } });
    expect(parseCustomization("editorial", big)).toEqual({ ok: false, reason: "invalid_customization" });
  });
});

describe("readCustomization (render, lenient) and resolution", () => {
  it("no customization resolves to the theme's own design", () => {
    for (const key of WEDDING_SITE_THEME_KEYS) {
      const defaults = Object.fromEntries(
        Object.entries(THEME_REGISTRY[key]).filter(([name]) => name !== "key" && name !== "options"),
      );
      expect(resolveSiteDesign(key, readCustomization(key, {}))).toEqual({ themeKey: key, ...defaults, colors: null });
    }
  });

  it("falls back field by field: invalid fields take the default, valid ones stay", () => {
    const stored = doc({
      palette: { kind: "preset", key: "rose" },
      typography: { pairing: "mixed", headingScale: "giant" },
      hero: { variant: "framed" },
      layout: { width: "regular", density: "url(x)", sectionStyle: ["plain"] },
      extra: { anything: true },
    });
    expect(readCustomization("editorial", stored)).toEqual({ typography: "mixed", hero: "framed", width: "regular" });
    expect(resolveSiteDesign("editorial", readCustomization("editorial", stored))).toMatchObject({
      palette: "ivory",
      typography: "mixed",
      headingScale: "display",
      hero: "framed",
      width: "regular",
      density: "airy",
      sectionStyle: "editorial",
    });
  });

  it.each([
    ["a wrong version", { schemaVersion: 2, hero: { variant: "simple" } }],
    ["a string", "url(https://evil.test)"],
    ["an array", [doc({ hero: { variant: "simple" } })]],
    ["null", null],
    ["a number", 42],
    ["a malformed group", doc({ hero: "simple" })],
  ])("%s is no customization, never an error", (_label, raw) => {
    expect(readCustomization("editorial", raw)).toEqual({});
    expect(toWeddingSiteDesign("editorial", raw)).toEqual({ themeKey: "editorial", customization: {} });
  });

  it("an unknown theme is uncustomized Classic", () => {
    expect(toWeddingSiteDesign("neon", doc({ palette: { kind: "preset", key: "warm" } }))).toEqual({
      themeKey: "classic",
      customization: {},
    });
  });

  it("resolveSiteDesign re-checks overrides against the theme, whatever their source", () => {
    const forged = { palette: "rose", hero: "banner", width: "regular" } as SiteOverrides;
    expect(resolveSiteDesign("editorial", forged)).toMatchObject({ palette: "ivory", hero: "editorial", width: "regular" });
  });

  it("the resolved design is complete and closed: no optional values, no raw JSON", () => {
    const design = resolveSiteDesign("minimal", { palette: "ink", typography: "serif" });
    expect(Object.keys(design).sort()).toEqual(
      ["alignment", "colors", "density", "headingScale", "hero", "ornament", "palette", "sectionStyle", "themeKey", "typography", "width"],
    );
    const { colors, ...values } = design;
    expect(colors).toBeNull();
    for (const value of Object.values(values)) expect(typeof value).toBe("string");
  });
});

describe("theme change", () => {
  it("keeps the overrides the new theme offers and drops the rest (Romantic framed → Minimal)", () => {
    const romantic: SiteOverrides = { palette: "wine", hero: "editorial", typography: "serif", density: "regular", sectionStyle: "plain" };
    expect(overridesForTheme("minimal", romantic)).toEqual({
      overrides: { typography: "serif", density: "regular", sectionStyle: "plain" },
      dropped: ["palette", "hero"],
    });
  });

  it("an override equal to the new theme's default is kept visually, not stored and not reported", () => {
    // Classic's "compact" density is Minimal's default.
    expect(overridesForTheme("minimal", { density: "compact" })).toEqual({ overrides: {}, dropped: [] });
  });

  it("a framed hero chosen on Editorial falls back to Minimal's grid", () => {
    const { overrides } = overridesForTheme("minimal", { hero: "framed" });
    expect(resolveSiteDesign("minimal", overrides).hero).toBe("grid");
  });
});

describe("resets and the stored document", () => {
  const overrides: SiteOverrides = { palette: "sunset", typography: "serif", hero: "simple", width: "wide", density: "airy" };

  it("resets one group, leaving the others", () => {
    expect(resetOverrides(overrides, "palette")).toEqual({ typography: "serif", hero: "simple", width: "wide", density: "airy" });
    expect(resetOverrides(overrides, "typography")).toEqual({ palette: "sunset", hero: "simple", width: "wide", density: "airy" });
    expect(resetOverrides(overrides, "hero")).toEqual({ palette: "sunset", typography: "serif", width: "wide", density: "airy" });
    expect(resetOverrides(overrides, "layout")).toEqual({ palette: "sunset", typography: "serif", hero: "simple" });
  });

  it("reset all is no overrides, stored as {}", () => {
    expect(resetOverrides(overrides, "all")).toEqual({});
    expect(toStoredCustomization(resetOverrides(overrides, "all"))).toEqual({});
  });

  it("knows which groups are customized", () => {
    expect(customizedGroups(overrides)).toEqual(CUSTOMIZATION_GROUPS.filter((group) => group !== "colors"));
    expect(customizedGroups({ width: "wide" })).toEqual(["layout"]);
    expect(customizedGroups({})).toEqual([]);
  });

  it("stores overrides only, in the versioned shape, and reads back the same", () => {
    const stored = toStoredCustomization(overrides);
    expect(stored).toEqual({
      schemaVersion: 1,
      palette: { kind: "preset", key: "sunset" },
      typography: { pairing: "serif" },
      hero: { variant: "simple" },
      layout: { width: "wide", density: "airy" },
    });
    expect(parseCustomization("tropical", stored)).toEqual({ ok: true, overrides });
    expect(new TextEncoder().encode(JSON.stringify(stored)).length).toBeLessThan(MAX_CUSTOMIZATION_BYTES);
  });

  it("the largest valid document is far below the byte cap", () => {
    let largest = 0;
    for (const key of WEDDING_SITE_THEME_KEYS) {
      const theme = THEME_REGISTRY[key];
      const longest = Object.fromEntries(
        CUSTOMIZABLE_FIELDS.map((field) => [
          field,
          [...(theme.options[field] as readonly string[])].sort((a, b) => b.length - a.length)[0],
        ]),
      ) as Record<CustomizableField, string>;
      // Force every field to be stored (as the database would see it).
      const stored = {
        schemaVersion: 1,
        palette: { kind: "preset", key: longest.palette },
        typography: { pairing: longest.typography, headingScale: longest.headingScale },
        hero: { variant: longest.hero },
        layout: { width: longest.width, density: longest.density, alignment: longest.alignment, sectionStyle: longest.sectionStyle },
      };
      largest = Math.max(largest, new TextEncoder().encode(JSON.stringify(stored)).length);
    }
    expect(largest).toBeLessThan(MAX_CUSTOMIZATION_BYTES / 3);
  });
});

describe("rendering", () => {
  const site = THEME_FIXTURES.full;
  const render = (overrides: SiteOverrides) =>
    renderToStaticMarkup(createElement(WeddingSite, { site, design: resolveSiteDesign("editorial", overrides) }));

  it("the same content under different customizations: same text, different presentation", () => {
    const plain = render({});
    const custom = render({ palette: "parchment", typography: "mixed", density: "regular" });
    expect(custom).not.toBe(plain);
    expect(custom).toContain('data-site-palette="parchment"');
    const text = (html: string) => html.replace(/<[^>]+>/g, "");
    expect(text(custom)).toBe(text(plain));
  });

  it("every option of every theme renders, with the same text", () => {
    const baseline = (key: string) =>
      renderToStaticMarkup(createElement(WeddingSite, { site, design: resolveSiteDesign(key) })).replace(/<[^>]+>/g, "");
    for (const key of WEDDING_SITE_THEME_KEYS) {
      const text = baseline(key);
      for (const field of CUSTOMIZABLE_FIELDS) {
        for (const value of THEME_REGISTRY[key].options[field]) {
          const html = renderToStaticMarkup(
            createElement(WeddingSite, { site, design: resolveSiteDesign(key, { [field]: value } as SiteOverrides) }),
          );
          expect(html.replace(/<[^>]+>/g, ""), `${key} ${field}=${value}`).toBe(text);
        }
      }
    }
  });

  it("unsafe stored values never reach class or style markup", () => {
    const unsafe = ["#ff00aa", "url(", "<script", "javascript:", "expression(", "evil.test", "</style>", "onload"];
    const stored = doc({
      palette: { kind: "preset", key: "#ff00aa" },
      typography: { pairing: "javascript:alert(1)", headingScale: "expression(alert(1))" },
      hero: { variant: "<script>alert(1)</script>" },
      layout: { width: "url(https://evil.test/x.png)", density: "</style><img onload=x>", alignment: "start", sectionStyle: "plain" },
    });
    const design = toWeddingSiteDesign("editorial", stored);
    // Only the two valid fields survive.
    expect(design.customization).toEqual({ alignment: "start", sectionStyle: "plain" });
    const html = renderToStaticMarkup(createElement(WeddingSite, { site, design: resolveSiteDesign(design.themeKey, design.customization) }));
    for (const value of unsafe) expect(html).not.toContain(value);
    expect(html).not.toMatch(/style="/);
  });
});

describe("palette contrast (WCAG AA)", () => {
  // Every palette's light and dark variables, read from the stylesheet the
  // site ships with; each text color must meet 4.5:1 against its background.
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const darkStart = css.indexOf("@media (prefers-color-scheme: dark) {\n  [data-site-palette");
  const darkEnd = css.indexOf("\n}\n", darkStart);
  const blocks = (source: string) =>
    new Map(
      [...source.matchAll(/\[data-site-palette="([\w-]+)"\]\s*\{([^}]*)\}/g)].map((m) => [
        m[1],
        Object.fromEntries([...m[2].matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/g)].map((v) => [v[1], v[2]])),
      ]),
    );
  const light = blocks(css.slice(0, darkStart));
  const dark = blocks(css.slice(darkStart, darkEnd));

  const luminance = (hex: string) =>
    [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a: string, b: string) => {
    const [x, y] = [luminance(a), luminance(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  it.each(SITE_PALETTES.filter((palette) => palette !== "app"))("%s: text, muted text and accent text pass in light and dark", (palette) => {
    for (const [scheme, variables] of [
      ["light", light.get(palette)],
      ["dark", dark.get(palette)],
    ] as const) {
      expect(variables, `${palette} ${scheme}`).toBeDefined();
      const v = variables as Record<string, string>;
      const pairs: [string, string, string][] = [
        ["foreground", v.foreground, v.background],
        ["muted", v.muted, v.background],
        ["accent", v.accent, v.background],
      ];
      // Tropical palettes also draw text on tiles and on the opening band.
      if (v["site-band"]) {
        pairs.push(["accent on tile", v.accent, v["accent-soft"]], ["text on tile", v.foreground, v["accent-soft"]]);
        pairs.push(["band text", v["site-band-text"], v["site-band"]]);
      }
      for (const [name, text, background] of pairs) {
        expect(text && background, `${palette} ${scheme} ${name} defined`).toBeTruthy();
        expect(ratio(text, background), `${palette} ${scheme} ${name}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("every Tropical palette defines the band, tile and ornament colors its hero and sections use", () => {
    for (const palette of THEME_REGISTRY.tropical.options.palette) {
      for (const variables of [light.get(palette), dark.get(palette)]) {
        for (const name of ["accent-soft", "site-band", "site-band-text", "site-ornament"]) {
          expect(variables?.[name], `${palette} ${name}`).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });
});
