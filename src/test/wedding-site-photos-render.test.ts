import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WeddingSite } from "@/components/wedding-site/WeddingSite";
import { resolveSiteDesign } from "@/lib/wedding-site/design/resolve";
import { WEDDING_SITE_THEME_KEYS } from "@/lib/wedding-site/design/themes";
import { previewPhotoBlocks, type PhotoEditor } from "@/lib/wedding-site/photos/editor";
import {
  focalPosition,
  publicPhotoBasePath,
  renditionSize,
  toSitePhotoBlocks,
  type SitePhotoBlock,
} from "@/lib/wedding-site/photos/model";
import { toPublishedSite } from "@/lib/wedding-site/sections";

/**
 * UX-01B (ADR-022): photos on the wedding site. The lenient reader drops
 * anything malformed; every theme draws the cover in its own hero and every
 * block at its fixed slot; images carry real dimensions, srcset, alt text and
 * lazy loading (the cover loads eagerly); the carousel ships no script and no
 * autoplay; without photos the page is unchanged.
 */

const A = "11111111-2222-4333-8444-555555555555";
const B = "22222222-3333-4444-8555-666666666666";
const C = "33333333-4444-4555-8666-777777777777";

const site = toPublishedSite("ana-y-luis", [
  { wedding_name: "Ana & Luis", wedding_date: "2027-03-20", wedding_city: "Cartago", section_kind: "intro", section_title: null, section_body: "Hola" },
  { wedding_name: "Ana & Luis", wedding_date: "2027-03-20", wedding_city: "Cartago", section_kind: "ceremony", section_title: null, section_body: "A las 4" },
])!;

const photo = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  width: 1600,
  height: 1067,
  alt: `Foto ${id.slice(0, 4)}`,
  caption: null,
  focalX: 2500,
  focalY: 7500,
  ...extra,
});

const blocks: SitePhotoBlock[] = toSitePhotoBlocks([
  { kind: "cover", variant: "standard", anchor: null, photos: [photo(A)] },
  { kind: "gallery", variant: "grid", anchor: "intro", photos: [photo(B, { caption: "En la playa" }), photo(C)] },
  { kind: "carousel", variant: "standard", anchor: "ceremony", photos: [photo(B), photo(C)] },
  { kind: "photo_text", variant: "image_end", anchor: null, title: "Nosotros", body: "Línea 1\nLínea 2", photos: [photo(C)] },
]);

function render(themeKey: string, withPhotos = true): string {
  return renderToStaticMarkup(
    createElement(WeddingSite, {
      site,
      design: resolveSiteDesign(themeKey),
      photos: withPhotos ? { blocks, basePath: publicPhotoBasePath(site.slug) } : undefined,
    }),
  );
}

describe("toSitePhotoBlocks", () => {
  it("keeps valid blocks and drops malformed ones field by field", () => {
    const parsed = toSitePhotoBlocks([
      { kind: "cover", variant: "standard", anchor: "intro", photos: [photo(A)] },
      { kind: "cover", variant: "standard", photos: [photo(B)] },
      { kind: "gallery", variant: "standard", photos: [photo(A)] },
      { kind: "slideshow", variant: "grid", photos: [photo(A)] },
      { kind: "gallery", variant: "grid", anchor: "hotels", photos: [photo(A)] },
      { kind: "gallery", variant: "grid", anchor: "faq", photos: [{ ...photo(A), id: "../etc" }, { ...photo(B), alt: "" }, { ...photo(C), width: 99999 }] },
      { kind: "photo_text", variant: "image_start", anchor: "rsvp", title: "  T  ", body: "B", photos: [photo(A), photo(B)] },
      { kind: "gallery", variant: "masonry", anchor: "faq", title: "no", photos: [photo(C, { focalX: "50%", caption: "x".repeat(201) })] },
      "<script>",
      null,
    ]);
    expect(parsed.map((b) => [b.kind, b.variant, b.anchor])).toEqual([
      ["cover", "standard", null],
      ["photo_text", "image_start", "rsvp"],
      ["gallery", "masonry", "faq"],
    ]);
    expect(parsed[0].photos.map((p) => p.id)).toEqual([A]);
    expect(parsed[1]).toMatchObject({ title: "T", body: "B" });
    expect(parsed[1].photos).toHaveLength(1);
    expect(parsed[2]).toMatchObject({ title: null, body: null });
    expect(parsed[2].photos[0]).toMatchObject({ focalX: 5000, caption: null });
    expect(toSitePhotoBlocks(undefined)).toEqual([]);
    expect(toSitePhotoBlocks({})).toEqual([]);
  });

  it("derives focal positions and small rendition sizes from numbers only", () => {
    expect(focalPosition({ focalX: 2500, focalY: 10000 })).toBe("25% 100%");
    expect(focalPosition({ focalX: -5, focalY: 99999 })).toBe("0% 100%");
    expect(renditionSize({ width: 1600, height: 1067 }, "640")).toEqual({ width: 640, height: 427 });
    expect(renditionSize({ width: 600, height: 900 }, "640")).toEqual({ width: 427, height: 640 });
    expect(renditionSize({ width: 600, height: 600 }, "1600")).toEqual({ width: 600, height: 600 });
  });
});

describe("rendering", () => {
  it.each(WEDDING_SITE_THEME_KEYS)("%s draws the cover in its opening and every block at its slot", (theme) => {
    const html = render(theme);
    const order = ["Ana &amp; Luis", "Nosotros", "Hola", "site-photo-block-gallery", "A las 4", "site-photo-block-carousel"];
    const positions = order.map((marker) => html.indexOf(marker));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    // The cover belongs to the opening: before the names (beside them in
    // Minimal's grid, above the band in Tropical), always before any block.
    const cover = html.indexOf("site-cover");
    expect(cover).toBeGreaterThan(0);
    expect(cover).toBeLessThan(html.indexOf("Nosotros"));
    if (theme === "minimal") expect(cover).toBeGreaterThan(html.indexOf("</h1>"));
    else expect(cover).toBeLessThan(html.indexOf("</h1>"));
  });

  it("gives every image real dimensions, a srcset, alt text and the right loading", () => {
    const html = render("classic");
    const images = html.match(/<img [^>]+>/g) ?? [];
    expect(images).toHaveLength(6);
    for (const img of images) {
      expect(img).toMatch(/ width="\d+" height="\d+"/);
      expect(img).toMatch(/srcSet="\/boda\/ana-y-luis\/fotos\/[0-9a-f-]+\/640 640w, \/boda\/ana-y-luis\/fotos\/[0-9a-f-]+\/1600 1600w"/);
      expect(img).toMatch(/ alt="Foto [0-9a-f]{4}"/);
      expect(img).toMatch(/ sizes="/);
      expect(img).not.toMatch(/\?/);
    }
    expect(images[0]).toContain('loading="eager"');
    expect(images[0]).toContain('fetchPriority="high"');
    expect(images.slice(1).every((img) => img.includes('loading="lazy"'))).toBe(true);
    expect(images[0]).toContain("object-position:25% 75%");
    expect(html).toContain("En la playa");
    // Text is text: the photo-with-text body keeps its line break as text.
    expect(html).toContain("Línea 1\nLínea 2");
  });

  it("draws a carousel without script, autoplay or timers", () => {
    const html = render("romantic");
    expect(html).not.toMatch(/<script|autoplay|setInterval|onclick/i);
    expect(html).toContain('aria-roledescription="Carrusel de fotos"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("Foto 1 de 2");
    expect(html).toContain('href="#fotos-2-2"');
    expect(html).toContain("motion-safe:scroll-smooth");
  });

  it("is byte-identical to the text-only page without photos, in every theme", () => {
    for (const theme of WEDDING_SITE_THEME_KEYS) {
      const withoutProp = renderToStaticMarkup(createElement(WeddingSite, { site, design: resolveSiteDesign(theme) }));
      const withEmpty = renderToStaticMarkup(
        createElement(WeddingSite, { site, design: resolveSiteDesign(theme), photos: { blocks: [], basePath: "/x" } }),
      );
      expect(withEmpty).toBe(withoutProp);
      expect(withoutProp).not.toContain("<img");
    }
  });
});

describe("member preview blocks", () => {
  const editor: PhotoEditor = {
    blocks: [
      { id: "c", kind: "cover", variant: "standard", anchor: null, position: 0, isVisible: false, title: null, body: null },
      { id: "g", kind: "gallery", variant: "grid", anchor: "faq", position: 1, isVisible: true, title: null, body: null },
    ],
    photos: [
      { id: A, state: "ready", blockId: "c", position: 0, altText: "Portada", caption: null, focalX: 5000, focalY: 5000, width: 1600, height: 900, bytes: 1, createdAt: "1" },
      { id: B, state: "ready", blockId: "g", position: 0, altText: null, caption: null, focalX: 5000, focalY: 5000, width: 1600, height: 900, bytes: 1, createdAt: "2" },
      { id: C, state: "ready", blockId: "g", position: 1, altText: "Con descripción", caption: null, focalX: 5000, focalY: 5000, width: 1600, height: 900, bytes: 1, createdAt: "3" },
    ],
  };

  it("marks hidden blocks, and applies the public rule (described photos only)", () => {
    const preview = previewPhotoBlocks(editor, { includeHidden: true });
    expect(preview.map((b) => [b.kind, b.hidden, b.photos.map((p) => p.id)])).toEqual([
      ["cover", true, [A]],
      ["gallery", false, [C]],
    ]);
    expect(previewPhotoBlocks(editor, { includeHidden: false }).map((b) => b.kind)).toEqual(["gallery"]);
    const html = renderToStaticMarkup(
      createElement(WeddingSite, { site, design: resolveSiteDesign("minimal"), photos: { blocks: preview, basePath: "/m" }, element: "div" }),
    );
    expect(html).toContain("Oculta: solo se ve en esta vista previa");
  });
});
