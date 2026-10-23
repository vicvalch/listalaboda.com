import { describe, expect, it } from "vitest";

import {
  blockStatus,
  canAddBlock,
  photosForBlock,
  slotSiblings,
  type EditorBlock,
  type EditorPhoto,
  type PhotoEditor,
} from "@/lib/wedding-site/photos/editor";
import type { SectionKind } from "@/lib/wedding-site/sections";

// UX-01D / STUDIO-01: the pure block helpers Studio's panels use (slots,
// what a block shows, picker candidates, the block limit).

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
