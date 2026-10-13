import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WeddingSite } from "@/components/wedding-site/WeddingSite";
import { DEFAULT_WEDDING_SITE_DESIGN, resolveSiteDesign, toWeddingSiteDesign } from "@/lib/wedding-site/design/resolve";
import { WEDDING_SITE_THEME_KEYS } from "@/lib/wedding-site/design/themes";
import type { PublishedSiteResult } from "@/lib/wedding-site/public";

import { THEME_FIXTURES } from "./fixtures/wedding-site-themes";

/**
 * The public route draws the theme the read returns (ADR-019, CP4): the real
 * page component, with only the data read replaced, renders exactly the
 * markup of `WeddingSite` in that theme (the committed theme snapshots), and
 * Classic for no design state. Classic's byte parity with the original page
 * is pinned separately (wedding-site-classic-parity.test.ts).
 */

const read = vi.hoisted(() => ({ result: null as PublishedSiteResult | null }));

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({}) }));
vi.mock("@/lib/wedding-site/public", () => ({
  getPublishedWeddingSite: async () => {
    if (!read.result) throw new Error("test did not set a read result");
    return read.result;
  },
}));

const { default: PublicWeddingSitePage, generateMetadata } = await import("@/app/boda/[slug]/page");

const props = {
  params: Promise.resolve({ slug: "sofia-y-andres" }),
  searchParams: Promise.resolve({}),
} as PageProps<"/boda/[slug]">;

async function renderWith(themeValue: unknown, customization?: unknown): Promise<string> {
  read.result = { ok: true, site: THEME_FIXTURES.full, design: toWeddingSiteDesign(themeValue, customization) };
  const element = await PublicWeddingSitePage(props);
  return renderToStaticMarkup(createElement(() => element));
}

const snapshot = (theme: string) =>
  readFileSync(new URL(`./__golden__/wedding-site-themes/${theme}-full.html`, import.meta.url), "utf8");

describe("the public route renders the stored theme", () => {
  it.each(WEDDING_SITE_THEME_KEYS.filter((key) => key !== "classic"))("%s", async (theme) => {
    expect(await renderWith(theme)).toBe(snapshot(theme));
  });

  it("Classic, no design state and anything unknown draw the same Classic page", async () => {
    read.result = { ok: true, site: THEME_FIXTURES.full, design: DEFAULT_WEDDING_SITE_DESIGN };
    const element = await PublicWeddingSitePage(props);
    const noDesign = renderToStaticMarkup(createElement(() => element));
    expect(noDesign).not.toContain("data-site-palette");
    for (const value of ["classic", null, undefined, "neon", "Editorial"]) {
      expect(await renderWith(value), String(value)).toBe(noDesign);
    }
  });

  it("the theme never changes the metadata", async () => {
    for (const theme of WEDDING_SITE_THEME_KEYS) {
      read.result = { ok: true, site: THEME_FIXTURES.full, design: { themeKey: theme, customization: {} } };
      expect(await generateMetadata(props)).toEqual({
        title: "Sofía & Andrés",
        robots: { index: false, follow: false },
      });
    }
  });
});

describe("the public route renders the stored customization (CP6)", () => {
  it("draws the theme with the stored overrides", async () => {
    const stored = {
      schemaVersion: 1,
      palette: { kind: "preset", key: "parchment" },
      typography: { pairing: "mixed" },
      layout: { density: "regular" },
    };
    const expected = renderToStaticMarkup(
      createElement(WeddingSite, {
        site: THEME_FIXTURES.full,
        design: resolveSiteDesign("editorial", { palette: "parchment", typography: "mixed", density: "regular" }),
      }),
    );
    const html = await renderWith("editorial", stored);
    expect(html).toBe(expected);
    expect(html).toContain('data-site-palette="parchment"');
    expect(html).not.toBe(snapshot("editorial"));
  });

  it.each([
    ["no customization", {}],
    ["a wrong version", { schemaVersion: 2, palette: { kind: "preset", key: "parchment" } }],
    ["a string", "url(https://evil.test/x.png)"],
    ["an array", [{ schemaVersion: 1 }]],
    ["another theme's palette", { schemaVersion: 1, palette: { kind: "preset", key: "rose" } }],
    ["unsafe values", { schemaVersion: 1, palette: { kind: "preset", key: "#ff0000" }, layout: { width: "<script>alert(1)</script>" } }],
  ])("%s draws the uncustomized theme, never anything unsafe", async (_label, stored) => {
    const html = await renderWith("editorial", stored);
    expect(html).toBe(snapshot("editorial"));
    for (const unsafe of ["#ff0000", "url(", "<script", "evil.test", "rose"]) expect(html).not.toContain(unsafe);
  });
});
