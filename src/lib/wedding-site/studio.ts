import { es } from "@/lib/i18n/messages/es";
import { coverOf, orderedBlocks, photosIn, type EditorBlock, type PhotoEditor } from "@/lib/wedding-site/photos/editor";
import {
  SINGLE_PHOTO_KINDS,
  type PhotoBlockKind,
  type PhotoBlockVariant,
  type SitePhoto,
  type SitePhotoBlock,
} from "@/lib/wedding-site/photos/model";
import type { SiteHeader } from "@/lib/wedding-site/preview";
import {
  hasPublicContent,
  SECTION_KINDS,
  sectionTitle,
  type EditorSection,
  type PublishedSection,
  type PublishedWeddingSite,
  type SectionKind,
} from "@/lib/wedding-site/sections";

/**
 * ListaLaBoda Studio (STUDIO-01): the pure model behind the visual editor.
 * The canvas draws the couple's SAVED content, with their unsaved edits
 * (drafts) laid over it, through the public renderer. Nothing here reads or
 * writes: saving goes through the existing server actions, and the database
 * stays the authority on every rule (visibility needs content, slots, quotas).
 */

/** What can be selected on the canvas. */
export type StudioTarget =
  | Readonly<{ type: "cover" }>
  | Readonly<{ type: "section"; kind: SectionKind }>
  | Readonly<{ type: "block"; id: string }>;

export function targetKey(target: StudioTarget): string {
  return target.type === "cover" ? "cover" : target.type === "section" ? `section:${target.kind}` : `block:${target.id}`;
}

export function sameTarget(a: StudioTarget | null, b: StudioTarget | null): boolean {
  return a !== null && b !== null && targetKey(a) === targetKey(b);
}

/** Unsaved fields of a text section, as typed (validated by the server on save). */
export type SectionDraft = Readonly<{ title: string; body: string; isVisible: boolean }>;

/** Unsaved fields of a photo block. */
export type BlockDraft = Readonly<{
  isVisible: boolean;
  variant: PhotoBlockVariant;
  anchor: SectionKind | null;
  title: string;
  body: string;
}>;

export type StudioDrafts = Readonly<{
  sections: Readonly<Partial<Record<SectionKind, SectionDraft>>>;
  blocks: Readonly<Record<string, BlockDraft>>;
}>;

export const NO_DRAFTS: StudioDrafts = { sections: {}, blocks: {} };

export function hasDrafts(drafts: StudioDrafts): boolean {
  return Object.keys(drafts.sections).length > 0 || Object.keys(drafts.blocks).length > 0;
}

export function sectionDraftOf(section: EditorSection): SectionDraft {
  return { title: section.title ?? "", body: section.body ?? "", isVisible: section.isVisible };
}

export function blockDraftOf(block: EditorBlock): BlockDraft {
  return {
    isVisible: block.isVisible,
    variant: block.variant,
    anchor: block.anchor,
    title: block.title ?? "",
    body: block.body ?? "",
  };
}

/** A draft that equals the saved values is no draft. */
export function sameSectionDraft(a: SectionDraft, b: SectionDraft): boolean {
  return a.title.trim() === b.title.trim() && a.body.trim() === b.body.trim() && a.isVisible === b.isVisible;
}

export function sameBlockDraft(a: BlockDraft, b: BlockDraft): boolean {
  return (
    a.isVisible === b.isVisible &&
    a.variant === b.variant &&
    a.anchor === b.anchor &&
    a.title.trim() === b.title.trim() &&
    a.body.trim() === b.body.trim()
  );
}

/** The sections with their drafts applied (blank = null, like the server). */
export function studioSections(sections: readonly EditorSection[], drafts: StudioDrafts): EditorSection[] {
  return SECTION_KINDS.flatMap((kind) => {
    const saved = sections.find((section) => section.kind === kind);
    if (!saved) return [];
    const draft = drafts.sections[kind];
    if (!draft) return [saved];
    return [{ kind, title: draft.title.trim() || null, body: draft.body.replace(/\r\n?/g, "\n").trim() || null, isVisible: draft.isVisible }];
  });
}

/**
 * The page the canvas draws: every section that has something to show,
 * VISIBLE OR HIDDEN (hidden ones are marked by the Studio chrome and never
 * reach the public read), in the fixed order. Sections without content are
 * drawn by the Studio as placeholders.
 */
export function studioSite(header: SiteHeader, sections: readonly EditorSection[], slug: string): PublishedWeddingSite {
  const shown: PublishedSection[] = sections.flatMap((section) =>
    hasPublicContent(section.kind, section.body)
      ? [{ kind: section.kind, title: sectionTitle(section.kind, section.title), body: section.body ?? es.publicSite.rsvpDefault }]
      : [],
  );
  return { slug, name: header.name, weddingDate: header.weddingDate, city: header.city, sections: shown };
}

/** The blocks with their drafts applied (a draft may move a block to another slot). */
export function studioEditor(editor: PhotoEditor, drafts: StudioDrafts): PhotoEditor {
  return {
    photos: editor.photos,
    blocks: editor.blocks.map((block) => {
      const draft = drafts.blocks[block.id];
      if (!draft) return block;
      if (block.kind === "cover") return { ...block, isVisible: draft.isVisible };
      return {
        ...block,
        isVisible: draft.isVisible,
        variant: draft.variant,
        anchor: draft.anchor,
        title: block.kind === "photo_text" ? draft.title.trim() || null : null,
        body: block.kind === "photo_text" ? draft.body.trim() || null : null,
      };
    }),
  };
}

/**
 * The canvas's photo blocks in public order (cover first), with EVERY ready
 * photo, described or not (an undescribed photo is never public: the Studio
 * marks it and gives it a placeholder alt), and EVERY block, empty or not
 * (the Studio draws an empty one as a placeholder). `ids` maps each drawn
 * block back to its row.
 */
export function studioPhotoBlocks(editor: PhotoEditor): { blocks: SitePhotoBlock[]; ids: Map<SitePhotoBlock, string> } {
  const ids = new Map<SitePhotoBlock, string>();
  const cover = coverOf(editor).block;
  const out: SitePhotoBlock[] = [];
  for (const block of [...(cover ? [cover] : []), ...orderedBlocks(editor)]) {
    const photos: SitePhoto[] = photosIn(editor, block.id).flatMap((photo) =>
      photo.width && photo.height
        ? [
            {
              id: photo.id,
              width: photo.width,
              height: photo.height,
              alt: photo.altText ?? es.site.studio.canvas.missingAltImage,
              caption: photo.caption,
              focalX: photo.focalX,
              focalY: photo.focalY,
            },
          ]
        : [],
    );
    // A cover without a photo draws nothing in the opening.
    if (block.kind === "cover" && photos.length === 0) continue;
    const drawn: SitePhotoBlock = {
      kind: block.kind,
      variant: block.variant,
      anchor: block.kind === "cover" ? null : block.anchor,
      title: block.kind === "photo_text" ? block.title : null,
      body: block.kind === "photo_text" ? block.body : null,
      hidden: !block.isVisible,
      photos: SINGLE_PHOTO_KINDS.includes(block.kind) ? photos.slice(0, 1) : photos,
    };
    ids.set(drawn, block.id);
    out.push(drawn);
  }
  return { blocks: out, ids };
}

// ------------------------------------------------------------- palette

/** The elements a couple can ADD (photo blocks); "single" is a photo-with-text without text. */
export type InsertableElement = "gallery" | "carousel" | "photo_text" | "single";

export const INSERTABLE_ELEMENTS: readonly InsertableElement[] = ["carousel", "gallery", "photo_text", "single"];

export function elementBlock(element: InsertableElement): Readonly<{ kind: Exclude<PhotoBlockKind, "cover">; variant: PhotoBlockVariant }> {
  switch (element) {
    case "gallery":
      return { kind: "gallery", variant: "grid" };
    case "carousel":
      return { kind: "carousel", variant: "standard" };
    case "photo_text":
      return { kind: "photo_text", variant: "image_start" };
    case "single":
      return { kind: "photo_text", variant: "image_start" };
  }
}

/** Where a new element may go: the end of each slot (the database appends new blocks). */
export const INSERT_ANCHORS: readonly (SectionKind | null)[] = [null, ...SECTION_KINDS];

// ------------------------------------------------------------- devices

export type StudioDevice = "desktop" | "mobile";

/** The canvas width per device: the desktop fills the canvas area; the phone is a real 390 px viewport. */
export function canvasWidth(device: StudioDevice): string {
  return device === "mobile" ? "390px" : "100%";
}
