import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WeddingSite } from "@/components/wedding-site/WeddingSite";
import { getMessages } from "@/lib/i18n";
import { resolveSiteDesign } from "@/lib/wedding-site/design/resolve";
import type { EditorBlock, EditorPhoto, PhotoEditor } from "@/lib/wedding-site/photos/editor";
import { SECTION_KINDS, type EditorSection, type SectionKind } from "@/lib/wedding-site/sections";
import {
  blockDraftOf,
  canvasWidth,
  elementBlock,
  hasDrafts,
  INSERTABLE_ELEMENTS,
  NO_DRAFTS,
  sameSectionDraft,
  studioEditor,
  studioPhotoBlocks,
  studioSections,
  studioSite,
  targetKey,
} from "@/lib/wedding-site/studio";

// STUDIO-01: the pure model behind ListaLaBoda Studio. The canvas draws the
// couple's saved content with their drafts laid over it, through the public
// renderer; hidden content is drawn (and marked by Studio), empty content is
// left to Studio's placeholders.

const header = { name: "Ana y Luis", weddingDate: "2027-02-14", city: "Puntarenas" };

function sections(overrides: Partial<Record<SectionKind, Partial<EditorSection>>> = {}): EditorSection[] {
  return SECTION_KINDS.map((kind) => ({ kind, title: null, body: null, isVisible: false, ...overrides[kind] }));
}

let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function block(kind: EditorBlock["kind"], anchor: SectionKind | null, position: number, isVisible = false): EditorBlock {
  return {
    id: id(),
    kind,
    variant: kind === "gallery" ? "grid" : kind === "photo_text" ? "image_start" : "standard",
    anchor: kind === "cover" ? null : anchor,
    position,
    isVisible,
    title: null,
    body: null,
  };
}

function photo(blockId: string | null, position: number, altText: string | null = "Una foto"): EditorPhoto {
  return {
    id: id(),
    state: "ready",
    blockId,
    position,
    altText,
    caption: null,
    focalX: 5000,
    focalY: 5000,
    width: 1600,
    height: 1067,
    bytes: 300_000,
    createdAt: `2026-10-23T00:00:${String(seq).padStart(2, "0")}Z`,
  };
}

describe("text sections", () => {
  it("drafts lay over the saved sections; blank is null like the server", () => {
    const saved = sections({ intro: { body: "Hola", isVisible: true } });
    const merged = studioSections(saved, {
      ...NO_DRAFTS,
      sections: { intro: { title: "  ", body: "  Nos casamos\r\ny bailamos\n", isVisible: true }, faq: { title: "Dudas", body: "", isVisible: false } },
    });
    expect(merged.find((s) => s.kind === "intro")).toEqual({ kind: "intro", title: null, body: "Nos casamos\ny bailamos", isVisible: true });
    expect(merged.find((s) => s.kind === "faq")).toMatchObject({ title: "Dudas", body: null });
    expect(merged.map((s) => s.kind)).toEqual([...SECTION_KINDS]);
  });

  it("the canvas page draws hidden sections that have content, never empty ones; RSVP always has its guidance", () => {
    const site = studioSite(
      header,
      sections({ intro: { body: "Visible", isVisible: true }, ceremony: { body: "Oculta", isVisible: false } }),
      "ana-y-luis",
    );
    expect(site.sections.map((s) => s.kind)).toEqual(["intro", "ceremony", "rsvp"]);
    expect(site.sections.at(-1)?.body).toBe(getMessages().publicSite.rsvpDefault);
    expect(site.name).toBe("Ana y Luis");
  });

  it("a draft equal to the saved values (trimmed) is no draft", () => {
    expect(sameSectionDraft({ title: "A ", body: " b", isVisible: true }, { title: "A", body: "b", isVisible: true })).toBe(true);
    expect(sameSectionDraft({ title: "A", body: "b", isVisible: false }, { title: "A", body: "b", isVisible: true })).toBe(false);
    expect(hasDrafts(NO_DRAFTS)).toBe(false);
  });
});

describe("photo blocks on the canvas", () => {
  it("cover first, then public order; every block (even empty) and every photo (even undescribed) are drawn", () => {
    const cover = block("cover", null, 0, true);
    const carousel = block("carousel", "ceremony", 2);
    const empty = block("gallery", null, 1);
    const editor: PhotoEditor = {
      blocks: [carousel, empty, cover],
      photos: [photo(cover.id, 0), photo(carousel.id, 0), photo(carousel.id, 1, null)],
    };
    const { blocks, ids } = studioPhotoBlocks(editor);
    expect(blocks.map((b) => [b.kind, b.anchor, b.hidden, b.photos.length])).toEqual([
      ["cover", null, false, 1],
      ["gallery", null, true, 0],
      ["carousel", "ceremony", true, 2],
    ]);
    expect(blocks.map((b) => ids.get(b))).toEqual([cover.id, empty.id, carousel.id]);
    expect(blocks[2]?.photos[1]?.alt).toBe(getMessages().site.studio.canvas.missingAltImage);
  });

  it("a cover block without a photo is not drawn", () => {
    expect(studioPhotoBlocks({ blocks: [block("cover", null, 0, true)], photos: [] }).blocks).toEqual([]);
  });

  it("block drafts change visibility, design, text and even the slot, live", () => {
    const gallery = block("gallery", "intro", 1);
    const text = block("photo_text", null, 2);
    const editor: PhotoEditor = { blocks: [gallery, text], photos: [photo(gallery.id, 0), photo(text.id, 0)] };
    const drafted = studioEditor(editor, {
      sections: {},
      blocks: {
        [gallery.id]: { ...blockDraftOf(gallery), isVisible: true, variant: "masonry", anchor: "faq" },
        [text.id]: { ...blockDraftOf(text), title: " Nuestra historia ", body: "" },
      },
    });
    const { blocks } = studioPhotoBlocks(drafted);
    expect(blocks.map((b) => [b.kind, b.anchor, b.variant, b.hidden, b.title])).toEqual([
      ["photo_text", null, "image_start", true, "Nuestra historia"],
      ["gallery", "faq", "masonry", false, null],
    ]);
  });
});

describe("the real renderer with Studio hooks", () => {
  const design = resolveSiteDesign("romantic");
  const site = studioSite(header, sections({ intro: { body: "Hola", isVisible: true } }), "x");
  const plain = renderToStaticMarkup(createElement(WeddingSite, { site, design, element: "div" }));

  it("wraps every element and marks every slot end, around the same markup", () => {
    const html = renderToStaticMarkup(
      createElement(WeddingSite, {
        site,
        design,
        element: "div",
        studio: {
          hero: (node) => createElement("div", { "data-t": "hero" }, node),
          section: (kind, node) => createElement("div", { "data-t": `section:${kind}` }, node),
          block: (_block, node) => node,
          slotEnd: (anchor) => createElement("hr", { "data-slot": anchor ?? "top" }),
        },
      }),
    );
    expect(html.match(/data-t="section:/g)).toHaveLength(SECTION_KINDS.length);
    expect(html.match(/data-slot=/g)).toHaveLength(SECTION_KINDS.length + 1);
    // Unwrapped, it is exactly the page without hooks (the theme is respected; nothing else is added).
    expect(html.replace(/<div data-t="[^"]+">|<hr data-slot="[^"]+"\/>/g, "").replace(/<\/div>/g, "")).toBe(
      plain.replace(/<\/div>/g, ""),
    );
    expect(html).toContain('data-site-palette="');
  });
});

describe("palette and devices", () => {
  it("offers carousel first; a single photo is a photo with text", () => {
    expect(INSERTABLE_ELEMENTS[0]).toBe("carousel");
    expect(elementBlock("carousel")).toEqual({ kind: "carousel", variant: "standard" });
    expect(elementBlock("single")).toEqual({ kind: "photo_text", variant: "image_start" });
  });

  it("the phone is a real 390 px viewport; targets have stable keys", () => {
    expect(canvasWidth("mobile")).toBe("390px");
    expect(canvasWidth("desktop")).toBe("100%");
    expect(targetKey({ type: "section", kind: "faq" })).toBe("section:faq");
    expect(targetKey({ type: "block", id: "b1" })).toBe("block:b1");
    expect(targetKey({ type: "cover" })).toBe("cover");
  });
});
