import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WeddingSite } from "@/components/wedding-site/WeddingSite";
import { getMessages } from "@/lib/i18n";
import { resolveSiteDesign } from "@/lib/wedding-site/design/resolve";
import { WEDDING_SITE_THEME_KEYS, type WeddingSiteThemeKey } from "@/lib/wedding-site/design/themes";
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
vi.mock("@/app/app/weddings/[weddingId]/site/actions", () => ({ saveThemeAction: vi.fn() }));
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

function editor(themeKey: WeddingSiteThemeKey, publishedAt: string | null = null) {
  return { publication: { slug: "boda-vista", publishedAt }, sections: SECTIONS, design: { themeKey } };
}

const render = (element: ReactElement) => renderToStaticMarkup(createElement(() => element));

async function preview(theme: string | string[] | undefined): Promise<string> {
  const element = await PreviewPage({
    params: Promise.resolve({ weddingId: WEDDING_ID }),
    searchParams: Promise.resolve(theme === undefined ? {} : { theme }),
  } as PageProps<"/app/weddings/[weddingId]/site/preview">);
  return render(element);
}

/** The markup the public page draws for this content in a theme. */
function publicMarkup(theme: WeddingSiteThemeKey): string {
  const site = toPreviewSite(WEDDING, SECTIONS, "boda-vista");
  return render(createElement(WeddingSite, { site, design: resolveSiteDesign(theme), element: "div" }));
}

const PRIVATE = ["Texto oculto", "Título oculto", "America/Costa_Rica", "collaborator"];

/** Whether the markup has the "Usar este estilo" submit button for a theme. */
const hasSave = (html: string, key: string) =>
  new RegExp(`<button type="submit" value="${key}"[^>]*name="theme"`).test(html);

describe("ThemeSection", () => {
  const site = toPreviewSite(WEDDING, SECTIONS, "");

  it("one card per registry theme, in registry order, the current one marked in words", () => {
    const html = render(createElement(ThemeSection, { weddingId: WEDDING_ID, site, current: "editorial", isPublished: false }));
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
    const html = render(createElement(ThemeSection, { weddingId: WEDDING_ID, site, current: "classic", isPublished: true }));
    expect(html).toContain(copy.design.liveNote);
    const thumbnails = html.match(/<div aria-hidden="true" inert="" data-testid="site-theme-thumbnail"/g);
    expect(thumbnails).toHaveLength(WEDDING_SITE_THEME_KEYS.length);
    for (const palette of ["ivory", "mono", "rose", "sand"]) expect(html).toContain(`data-site-palette="${palette}"`);
    // Drawn inside the organizer page: never a second <main>.
    expect(html).not.toContain("<main");
    expect(html).toContain("Texto visible de bienvenida");
    for (const secret of PRIVATE) expect(html).not.toContain(secret);
    // The wedding id appears only as the form's lookup key and in the five
    // preview links, never in a thumbnail.
    expect(html.split(WEDDING_ID)).toHaveLength(1 + 1 + WEDDING_SITE_THEME_KEYS.length);
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
    expect(same).not.toContain(`name="theme"`);
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
});
