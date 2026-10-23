import { describe, expect, it } from "vitest";

import {
  blockStatus,
  canAddBlock,
  photosForBlock,
  previewPhotoBlocks,
  siteComposition,
  slotSiblings,
  type CompositionRow,
  type EditorBlock,
  type EditorPhoto,
  type PhotoEditor,
} from "@/lib/wedding-site/photos/editor";
import { SECTION_KINDS, type SectionKind } from "@/lib/wedding-site/sections";

// UX-01D: "Secciones del sitio" lists text and photo sections together in
// the public page's order, with an insertion point at the end of each slot.

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

/** A row as a short label: "intro", "+top", "block:carousel". */
function labels(rows: CompositionRow[]): string[] {
  return rows.map((row) =>
    row.type === "section" ? row.kind : row.type === "insert" ? `+${row.anchor ?? "top"}` : `block:${row.block.kind}`,
  );
}

describe("siteComposition", () => {
  it("without photos is the seven text sections in their fixed order, with no insertion points", () => {
    expect(labels(siteComposition(null))).toEqual([...SECTION_KINDS]);
  });

  it("puts an insertion point after the cover and after every text section when there are no blocks", () => {
    expect(labels(siteComposition({ photos: [], blocks: [] }))).toEqual([
      "+top",
      ...SECTION_KINDS.flatMap((kind) => [kind, `+${kind}`]),
    ]);
  });

  it("follows the public order: blocks after their anchor, by position, the insertion point closing each slot; the cover is not a row", () => {
    const cover = block("cover", null, 0, true);
    const top = block("gallery", null, 3);
    const second = block("photo_text", "ceremony", 5);
    const first = block("carousel", "ceremony", 1);
    const editor: PhotoEditor = { photos: [], blocks: [second, cover, top, first] };
    const rows = siteComposition(editor);
    expect(labels(rows).slice(0, 6)).toEqual(["block:gallery", "+top", "intro", "+intro", "ceremony", "block:carousel"]);
    expect(labels(rows).slice(6, 9)).toEqual(["block:photo_text", "+ceremony", "reception"]);
    expect(rows.filter((row) => row.type === "block").map((row) => (row.type === "block" ? row.block.id : ""))).toEqual([
      top.id,
      first.id,
      second.id,
    ]);
  });

  it("matches the member preview's block order", () => {
    const blocks = [block("gallery", "faq", 2, true), block("carousel", null, 4, true), block("gallery", "intro", 1, true)];
    const photos = blocks.map((b, i) => photo(b.id, i));
    const editor: PhotoEditor = { photos, blocks };
    const fromRows = siteComposition(editor).flatMap((row) => (row.type === "block" ? [row.block.anchor] : []));
    expect(fromRows).toEqual(previewPhotoBlocks(editor, { includeHidden: true }).map((b) => b.anchor));
  });
});

describe("row helpers", () => {
  it("slotSiblings: only the blocks of the same slot, in order", () => {
    const a = block("gallery", "intro", 1);
    const b = block("carousel", "intro", 2);
    const c = block("gallery", "faq", 3);
    const editor: PhotoEditor = { photos: [], blocks: [c, b, a] };
    expect(slotSiblings(editor, b).map((x) => x.id)).toEqual([a.id, b.id]);
    expect(slotSiblings(editor, c).map((x) => x.id)).toEqual([c.id]);
  });

  it("blockStatus: a visible block appears only with at least one described photo", () => {
    const empty = block("carousel", null, 1, true);
    const undescribed = block("gallery", null, 2, true);
    const hidden = block("gallery", null, 3, false);
    const editor: PhotoEditor = {
      blocks: [empty, undescribed, hidden],
      photos: [photo(undescribed.id, 0, null), photo(hidden.id, 0), photo(hidden.id, 1, null)],
    };
    expect(blockStatus(editor, empty)).toEqual({ photos: 0, missingAlt: 0, appears: false });
    expect(blockStatus(editor, undescribed)).toEqual({ photos: 1, missingAlt: 1, appears: false });
    expect(blockStatus(editor, hidden)).toEqual({ photos: 2, missingAlt: 1, appears: false });
    const shown = { ...hidden, isVisible: true };
    expect(blockStatus({ ...editor, blocks: [empty, undescribed, shown] }, shown).appears).toBe(true);
  });

  it("photosForBlock: the library minus this block's photos and the cover photo", () => {
    const cover = block("cover", null, 0);
    const gallery = block("gallery", null, 1);
    const other = block("carousel", null, 2);
    const inCover = photo(cover.id, 0);
    const inGallery = photo(gallery.id, 0);
    const inOther = photo(other.id, 0);
    const loose = photo(null, 0);
    const editor: PhotoEditor = { blocks: [cover, gallery, other], photos: [inCover, inGallery, inOther, loose] };
    expect(photosForBlock(editor, gallery).map((p) => p.id)).toEqual([inOther.id, loose.id]);
  });

  it("canAddBlock: 12 blocks at most, the cover included", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => block("gallery", null, i));
    expect(canAddBlock({ photos: [], blocks: eleven })).toBe(true);
    expect(canAddBlock({ photos: [], blocks: [...eleven, block("cover", null, 99)] })).toBe(false);
  });
});
