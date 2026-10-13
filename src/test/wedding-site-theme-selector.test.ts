import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WeddingSite } from "@/components/wedding-site/WeddingSite";
import { getMessages } from "@/lib/i18n";
import type { SiteOverrides } from "@/lib/wedding-site/design/customization";
import { resolveSiteDesign } from "@/lib/wedding-site/design/resolve";
import {
  CUSTOMIZABLE_FIELDS,
  THEME_REGISTRY,
  WEDDING_SITE_THEME_KEYS,
  type WeddingSiteThemeKey,
} from "@/lib/wedding-site/design/themes";
import { toPreviewSite } from "@/lib/wedding-site/preview";
import { toEditorSections } from "@/lib/wedding-site/sections";

vi.mock("server-only", () => ({}));
const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  }),
}));
vi.mock("next/navigation", () => navigation);
vi.mock("@/app/app/weddings/[weddingId]/site/actions", () => ({ saveThemeAction: vi.fn(), saveCustomizationAction: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn(async () => ({ id: "user" })) }));

// A client that fails any direct use: the page reads only through the
// (mocked) membership check and services, and never writes.
const client = vi.hoisted(() => ({
  from: () => {
    throw new Error("unexpected direct table access");
  },
  rpc: () => {
    throw new Error("unexpected RPC");
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => client) }));

const data = vi.hoisted(() => ({
  access: null as unknown,
  wedding: null as unknown,
  editor: null as unknown,
}));
vi.mock("@/lib/authz/wedding", () => ({ requireWeddingMembership: vi.fn(async () => data.access) }));
vi.mock("@/lib/weddings/service", () => ({ getWeddingDetail: vi.fn(async () => data.wedding) }));
vi.mock("@/lib/wedding-site/service", () => ({ getWeddingSiteEditor: vi.fn(async () => data.editor) }));

const { ThemeSection } = await import("@/app/app/weddings/[weddingId]/site/ThemeSection");
const { default: PreviewPage, metadata } = await import("@/app/app/weddings/[weddingId]/site/preview/page");

// "Estilo del sitio" and the member-only preview (ADR-019, CP5).

const WEDDING_ID = "8d0f6b8e-0000-4000-8000-000000000001";
const copy = getMessages().site;

const WEDDING = {
  id: WEDDING_ID,
  name: "Boda de prueba Vista",
  weddingDate: "2090-06-01",
  city: "Ciudad de Prueba",
  timeZone: "America/Costa_Rica",
  memberCounts: { owner: 1, collaborator: 1 },
};
const SECTIONS = toEditorSections([
  { kind: "intro", title: null, body: "Texto visible de bienvenida", is_visible: true },
  { kind: "ceremony", title: "Título oculto", body: "Texto oculto de la ceremonia", is_visible: false },
  { kind: "rsvp", title: null, body: null, is_visible: true },
]);

function editor(themeKey: WeddingSiteThemeKey, publishedAt: string | null = null, customization: SiteOverrides = {}) {
  return { publication: { slug: "boda-vista", publishedAt }, sections: SECTIONS, design: { themeKey, customization } };
}

const render = (element: ReactElement) => renderToStaticMarkup(createElement(() => element));

async function preview(
  theme: string | string[] | undefined,
  extra: Record<string, string | string[]> = {},
): Promise<string> {
  const element = await PreviewPage({
    params: Promise.resolve({ weddingId: WEDDING_ID }),
    searchParams: Promise.resolve({ ...(theme === undefined ? {} : { theme }), ...extra }),
  } as PageProps<"/app/weddings/[weddingId]/site/preview">);
  return render(element);
}

/** The markup the public page draws for this content in a theme (and customization). */
function publicMarkup(theme: WeddingSiteThemeKey, overrides: SiteOverrides = {}): string {
  const site = toPreviewSite(WEDDING, SECTIONS, "boda-vista");
  return render(createElement(WeddingSite, { site, design: resolveSiteDesign(theme, overrides), element: "div" }));
}

/** The customization radios of a field, in markup order (React orders attributes its own way). */
function radios(html: string, field: string): { value: string; checked: boolean }[] {
  return [...html.matchAll(/<input type="radio"[^>]*>/g)]
    .map((m) => m[0])
    .filter((input) => input.includes(` name="${field}"`))
    .map((input) => ({ value: input.match(/ value="(\w+)"/)?.[1] ?? "", checked: input.includes(' checked=""') }));
}

/** The customization controls' checked value for a field, from the markup. */
function checked(html: string, field: string): string | undefined {
  return radios(html, field).find((radio) => radio.checked)?.value;
}

const interpolateName = (template: string, name: string) => template.replace("{name}", name);

const PRIVATE = ["Texto oculto", "Título oculto", "America/Costa_Rica", "collaborator"];

/** Whether the markup has the "Usar este estilo" submit button for a theme. */
const hasSave = (html: string, key: string) =>
  new RegExp(`<button type="submit" value="${key}"[^>]*name="theme"`).test(html);

describe("ThemeSection", () => {
  const site = toPreviewSite(WEDDING, SECTIONS, "");

  it("one card per registry theme, in registry order, the current one marked in words", () => {
    const html = render(
      createElement(ThemeSection, {
        weddingId: WEDDING_ID,
        site,
        design: { themeKey: "editorial", customization: {} },
        isPublished: false,
      }),
    );
    const keys = [...html.matchAll(/data-testid="site-theme-option" data-theme="(\w+)"/g)].map((m) => m[1]);
    expect(keys).toEqual([...WEDDING_SITE_THEME_KEYS]);
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="true" data-testid="site-theme-option" data-theme="editorial"/);
    expect(html.match(new RegExp(copy.design.selected, "g"))).toHaveLength(1);
    // The current theme has no "Usar este estilo"; the others do, named.
    expect(hasSave(html, "editorial")).toBe(false);
    for (const key of ["classic", "minimal", "romantic", "tropical"]) {
      expect(hasSave(html, key), key).toBe(true);
      expect(html).toContain(`aria-label="${copy.design.use}: ${copy.themes[key as WeddingSiteThemeKey].name}"`);
      expect(html).toContain(`aria-label="${copy.design.preview}: ${copy.themes[key as WeddingSiteThemeKey].name}"`);
    }
    for (const key of WEDDING_SITE_THEME_KEYS) {
      expect(html).toContain(`href="/app/weddings/${WEDDING_ID}/site/preview?theme=${key}"`);
    }
    expect(html).toContain(copy.design.contentNote);
    expect(html).toContain(copy.design.unpublishedNote);
  });

  it("thumbnails are the real renderer, decorative and inert, with only public content", () => {
    const html = render(
      createElement(ThemeSection, { weddingId: WEDDING_ID, site, design: { themeKey: "classic", customization: {} }, isPublished: true }),
    );
    expect(html).toContain(copy.design.liveNote);
    const thumbnails = html.match(/<div aria-hidden="true" inert="" data-testid="site-theme-thumbnail"/g);
    expect(thumbnails).toHaveLength(WEDDING_SITE_THEME_KEYS.length);
    for (const palette of ["ivory", "mono", "rose", "sand"]) expect(html).toContain(`data-site-palette="${palette}"`);
    // Drawn inside the organizer page: never a second <main>.
    expect(html).not.toContain("<main");
    expect(html).toContain("Texto visible de bienvenida");
    for (const secret of PRIVATE) expect(html).not.toContain(secret);
    // The wedding id appears only as the two forms' lookup key and in the
    // five preview links, never in a thumbnail.
    expect(html.split(WEDDING_ID)).toHaveLength(1 + 2 + WEDDING_SITE_THEME_KEYS.length);
  });
});

describe("Personalizar (CP6)", () => {
  const site = toPreviewSite(WEDDING, SECTIONS, "");
  const section = (themeKey: WeddingSiteThemeKey, customization: SiteOverrides = {}) =>
    render(createElement(ThemeSection, { weddingId: WEDDING_ID, site, design: { themeKey, customization }, isPublished: true }));

  it.each(WEDDING_SITE_THEME_KEYS)("%s: offers exactly the registry's options, named in Spanish, the default marked", (key) => {
    const html = section(key);
    const theme = THEME_REGISTRY[key];
    expect(html).toContain(`data-testid="site-customize" data-theme="${key}"`);
    for (const field of CUSTOMIZABLE_FIELDS) {
      const options = theme.options[field] as readonly string[];
      const offered = radios(html, field).map((radio) => radio.value);
      if (options.length > 1) {
        expect(offered, `${key} ${field}`).toEqual([...options]);
        expect(checked(html, field), `${key} ${field}`).toBe(theme[field]);
        expect(html).toContain(`<legend class="text-sm font-semibold">${copy.customize.fields[field]}</legend>`);
      } else {
        // Fixed by the theme: stated in words, not offered.
        expect(offered, `${key} ${field}`).toEqual([]);
        expect(html).toContain(`data-testid="site-customize-fixed" data-field="${field}"`);
      }
    }
    // Spanish names, never keys, as the visible option text.
    expect(html).toContain(copy.customize.values.palette[theme.palette]);
    expect(html).toContain(`· ${copy.customize.themeDefault}`);
    // Nothing customized: no reset buttons.
    expect(html).not.toContain(`value="reset:`);
    expect(html).toContain(copy.customize.none);
  });

  it("starts from the saved customization and offers resets for the customized groups only", () => {
    const html = section("editorial", { palette: "parchment", density: "regular" });
    expect(checked(html, "palette")).toBe("parchment");
    expect(checked(html, "density")).toBe("regular");
    expect(checked(html, "typography")).toBe("serif");
    expect(html).toContain('value="reset:palette"');
    expect(html).toContain('value="reset:layout"');
    expect(html).not.toContain('value="reset:typography"');
    expect(html).not.toContain('value="reset:hero"');
    expect(html).toContain('value="reset:all"');
    expect(html).toContain(`aria-label="${copy.customize.reset}: ${copy.customize.groups.palette}"`);
    // The current theme's thumbnail shows the saved customization.
    expect(html).toContain('data-site-palette="parchment"');
  });

  it("thumbnails of other themes keep only the choices that theme offers", () => {
    // Regular density is offered by Romantic; the parchment palette is not.
    const html = section("editorial", { palette: "parchment", density: "regular" });
    expect(html.match(/data-site-palette="parchment"/g)).toHaveLength(2); // thumbnail + swatch
    expect(html).toContain('data-site-palette="rose"');
  });

  it("palette options carry a text name; the swatch is decorative", () => {
    const html = section("tropical");
    for (const palette of THEME_REGISTRY.tropical.options.palette) {
      expect(html).toContain(copy.customize.values.palette[palette]);
      expect(html).toMatch(new RegExp(`<span aria-hidden="true" data-site-palette="${palette}"`));
    }
  });
});

describe("preview page", () => {
  beforeEach(() => {
    data.access = { ok: true, access: { weddingId: WEDDING_ID, userId: "user", membershipId: "m-1", role: "collaborator" } };
    data.wedding = WEDDING;
    data.editor = editor("classic");
  });

  it("is never indexed", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it.each(WEDDING_SITE_THEME_KEYS)("draws %s exactly as the public renderer would", async (theme) => {
    const html = await preview(theme);
    expect(html).toContain(publicMarkup(theme));
    expect(html).toContain(`data-testid="site-preview" data-theme="${theme}"`);
  });

  it("works for an unpublished site and says so; nothing private reaches it", async () => {
    const html = await preview("romantic");
    expect(html).toContain(copy.preview.unpublished);
    expect(html).toContain("Texto visible de bienvenida");
    for (const secret of PRIVATE) expect(html).not.toContain(secret);
    expect(html.slice(html.indexOf('data-testid="site-preview"'))).not.toContain(WEDDING_ID);
    expect(html).not.toContain("<main");
  });

  it("offers the save for another theme, and says when it is the current one", async () => {
    data.editor = editor("tropical", "2090-01-01T00:00:00Z");
    const other = await preview("minimal");
    expect(hasSave(other, "minimal")).toBe(true);
    expect(other).not.toContain(copy.preview.unpublished);
    const same = await preview("tropical");
    expect(same).toContain(copy.preview.current);
    expect(hasSave(same, "tropical")).toBe(false);
  });

  it.each([[undefined], ["neon"], ["Romantic"], [["minimal", "editorial"]]])(
    "%j previews the current theme and never echoes the value",
    async (raw) => {
      data.editor = editor("tropical");
      const html = await preview(raw);
      expect(html).toContain(`data-testid="site-preview" data-theme="tropical"`);
      expect(html).not.toContain("neon");
      expect(html).not.toContain("Romantic");
    },
  );

  it("a non-member or missing wedding is a 404; signed out goes to log in", async () => {
    data.access = { ok: false, reason: "not_found" };
    await expect(preview("minimal")).rejects.toThrow("NEXT_NOT_FOUND");
    data.access = { ok: false, reason: "unauthenticated" };
    await expect(preview("minimal")).rejects.toThrow(/NEXT_REDIRECT \/login\?next=/);
  });

  it("a failed read shows an error, never a partial site", async () => {
    data.editor = null;
    const html = await preview("minimal");
    expect(html).toContain(copy.loadFailed);
    expect(html).not.toContain("site-preview");
  });

  it("previews unsaved customization choices from closed query values, without saving", async () => {
    data.editor = editor("editorial");
    const html = await preview("editorial", { customize: "1", palette: "parchment", typography: "mixed", density: "regular" });
    expect(html).toContain(publicMarkup("editorial", { palette: "parchment", typography: "mixed", density: "regular" }));
    expect(html).toContain('data-testid="site-preview-unsaved"');
    expect(html).toContain(interpolateName(copy.preview.customHeading, "Editorial"));
    // The controls start from the previewed choices; saving is explicit.
    expect(checked(html, "palette")).toBe("parchment");
    expect(html).toContain(`value="save"`);
    expect(hasSave(html, "editorial")).toBe(false);
  });

  it("invalid or foreign values fall back to the theme's defaults and are never echoed", async () => {
    data.editor = editor("editorial");
    const html = await preview("editorial", {
      customize: "1",
      palette: "rose",
      hero: "banner",
      width: "url(https://evil.test)",
      density: ["regular", "airy"],
      typography: "mixed",
    });
    expect(html).toContain(publicMarkup("editorial", { typography: "mixed" }));
    for (const value of ["evil.test", "url("]) expect(html).not.toContain(value);
    expect(html).not.toContain('data-site-palette="rose"');
  });

  it("without customize=1, previews what choosing the theme would keep of the saved customization", async () => {
    data.editor = editor("romantic", null, { palette: "wine", hero: "editorial", density: "regular" });
    const minimal = await preview("minimal", { palette: "stone" });
    // Minimal keeps the regular density, not the wine palette or the editorial hero; query fields are ignored.
    expect(minimal).toContain(publicMarkup("minimal", { density: "regular" }));
    const same = await preview("romantic");
    expect(same).toContain(publicMarkup("romantic", { palette: "wine", hero: "editorial", density: "regular" }));
    expect(same).toContain(copy.preview.current);
  });

  it("says when the previewed customization is the saved design", async () => {
    data.editor = editor("editorial", null, { palette: "parchment" });
    const html = await preview("editorial", { customize: "1", palette: "parchment" });
    expect(html).toContain(copy.preview.currentDesign);
    expect(html).not.toContain('data-testid="site-preview-unsaved"');
  });
});
