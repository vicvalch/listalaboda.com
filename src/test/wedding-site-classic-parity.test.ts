import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PublishedSiteResult } from "@/lib/wedding-site/public";
import { toPublishedSite, type PublishedSiteRow } from "@/lib/wedding-site/sections";

/**
 * Classic parity (ADR-019, CP1): the public wedding page, rendered end to end
 * through its route component with only the data read replaced, must produce
 * exactly the markup it produced before the theme engine existed. The golden
 * files under __golden__/ were captured from the pre-refactor page and must
 * not be regenerated to make a change pass: a difference is a visible
 * regression of the Classic theme.
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

function row(overrides: Partial<PublishedSiteRow>): PublishedSiteRow {
  return {
    wedding_name: "Sofía & Andrés",
    wedding_date: "2027-02-14",
    wedding_city: "San José",
    section_kind: null,
    section_title: null,
    section_body: null,
    ...overrides,
  };
}

function site(rows: PublishedSiteRow[]): PublishedSiteResult {
  const built = toPublishedSite("sofia-y-andres", rows);
  if (!built) throw new Error("fixture has no rows");
  return { ok: true, site: built };
}

const props = {
  params: Promise.resolve({ slug: "sofia-y-andres" }),
  searchParams: Promise.resolve({}),
} as PageProps<"/boda/[slug]">;

async function renderPage(): Promise<string> {
  const element = await PublicWeddingSitePage(props);
  return renderToStaticMarkup(createElement(() => element));
}

const golden = (name: string) => `./__golden__/wedding-site-classic/${name}.html`;

// Every section kind, in database order, with the cases the page handles:
// a custom title, default titles, multi-line text, HTML-looking text and the
// RSVP section without text (fixed guidance).
const FULL_ROWS: PublishedSiteRow[] = [
  row({ section_kind: "intro", section_title: "Nuestra historia", section_body: "Nos conocimos en una librería.\nY aquí estamos." }),
  row({ section_kind: "ceremony", section_body: "Iglesia de La Merced, 3:00 p. m." }),
  row({ section_kind: "reception", section_body: "Hacienda El Rodeo." }),
  row({ section_kind: "schedule", section_body: "15:00 Ceremonia\n17:00 Recepción\n23:00 Cierre" }),
  row({ section_kind: "dress_code", section_body: "Formal. <b>Sin</b> blanco & <script>alert(1)</script>" }),
  row({ section_kind: "faq", section_title: "Preguntas", section_body: "¿Niños? Sí, bienvenidos." }),
  row({ section_kind: "rsvp", section_body: null }),
];

describe("Classic public page parity with the pre-theme page", () => {
  beforeEach(() => {
    read.result = null;
  });

  it("a full site: header, every section kind, RSVP guidance, footer", async () => {
    read.result = site(FULL_ROWS);
    await expect(await renderPage()).toMatchFileSnapshot(golden("full"));
  });

  it("a site without date, city or visible sections shows only its name and footer", async () => {
    read.result = site([row({ wedding_date: null, wedding_city: null })]);
    await expect(await renderPage()).toMatchFileSnapshot(golden("header-only"));
  });

  it("date without city, and city without date", async () => {
    read.result = site([row({ wedding_city: null, section_kind: "intro", section_body: "Hola." })]);
    await expect(await renderPage()).toMatchFileSnapshot(golden("date-only"));
    read.result = site([row({ wedding_date: null, section_kind: "rsvp", section_body: "Usa tu enlace." })]);
    await expect(await renderPage()).toMatchFileSnapshot(golden("city-only"));
  });

  it("a failed read shows the error notice, not the site", async () => {
    read.result = { ok: false, reason: "error" };
    await expect(await renderPage()).toMatchFileSnapshot(golden("error"));
  });

  it("an unavailable site is a 404", async () => {
    read.result = { ok: false, reason: "unavailable" };
    await expect(PublicWeddingSitePage(props)).rejects.toThrow();
  });

  it("metadata: the wedding's name, or the not-found title; never indexed", async () => {
    read.result = site(FULL_ROWS);
    expect(await generateMetadata(props)).toEqual({
      title: "Sofía & Andrés",
      robots: { index: false, follow: false },
    });
    read.result = { ok: false, reason: "unavailable" };
    const missing = await generateMetadata(props);
    expect(missing.robots).toEqual({ index: false, follow: false });
    expect(missing.title).not.toBe("Sofía & Andrés");
  });
});
