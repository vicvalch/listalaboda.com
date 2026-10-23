import {
  isVariantOf,
  PHOTO_LIMITS,
  SINGLE_PHOTO_KINDS,
  type PhotoBlockKind,
  type PhotoBlockVariant,
  type SitePhotoBlock,
} from "@/lib/wedding-site/photos/model";
import { SECTION_KINDS, type SectionKind } from "@/lib/wedding-site/sections";

/**
 * The editor's view of a wedding's photos and blocks (UX-01B, ADR-022), as
 * members read them through RLS, and the pure rules the editor needs: input
 * validation (mirroring the database CHECKs, which stay authoritative), the
 * library summary and the member preview's blocks. No I/O.
 */

export type EditorPhoto = Readonly<{
  id: string;
  state: "pending" | "ready";
  blockId: string | null;
  position: number;
  altText: string | null;
  caption: string | null;
  focalX: number;
  focalY: number;
  width: number | null;
  height: number | null;
  bytes: number | null;
  createdAt: string;
}>;

export type EditorBlock = Readonly<{
  id: string;
  kind: PhotoBlockKind;
  variant: PhotoBlockVariant;
  anchor: SectionKind | null;
  position: number;
  isVisible: boolean;
  title: string | null;
  body: string | null;
}>;

export type PhotoEditor = Readonly<{
  photos: readonly EditorPhoto[];
  blocks: readonly EditorBlock[];
}>;

/** Ready photos, oldest first (the library order). */
export function libraryPhotos(editor: PhotoEditor): EditorPhoto[] {
  return [...editor.photos.filter((photo) => photo.state === "ready")].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function coverOf(editor: PhotoEditor): { block: EditorBlock | null; photo: EditorPhoto | null } {
  const block = editor.blocks.find((b) => b.kind === "cover") ?? null;
  const photo = block ? (editor.photos.find((p) => p.blockId === block.id && p.state === "ready") ?? null) : null;
  return { block, photo };
}

/** The photos of a block, in their order. */
export function photosIn(editor: PhotoEditor, blockId: string): EditorPhoto[] {
  return [...editor.photos.filter((photo) => photo.blockId === blockId && photo.state === "ready")].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

/** Non-cover blocks in public order: by slot (after the opening, then the fixed section order), then position. */
export function orderedBlocks(editor: PhotoEditor): EditorBlock[] {
  const slot = (anchor: SectionKind | null) => (anchor === null ? -1 : SECTION_KINDS.indexOf(anchor));
  return [...editor.blocks.filter((block) => block.kind !== "cover")].sort((a, b) => slot(a.anchor) - slot(b.anchor) || a.position - b.position || a.id.localeCompare(b.id));
}

/** Photos counted against the 20 (pending uploads included, like the database). */
export function photoCount(editor: PhotoEditor): number {
  return editor.photos.length;
}

/** Whether a block can take another photo (one for cover and photo-with-text). */
export function blockHasRoom(editor: PhotoEditor, block: EditorBlock): boolean {
  return !SINGLE_PHOTO_KINDS.includes(block.kind) || photosIn(editor, block.id).length === 0;
}

/**
 * The member preview's blocks, through the SAME rule as the public read
 * (ready, with alt text): visible blocks as the public page will draw them,
 * hidden ones marked `hidden` (the MVP's draft, ADR-022 §13.9). With
 * `includeHidden: false` the result is what a published page shows.
 */
export function previewPhotoBlocks(editor: PhotoEditor, { includeHidden }: { includeHidden: boolean }): SitePhotoBlock[] {
  const cover = coverOf(editor).block;
  const blocks = [...(cover ? [cover] : []), ...orderedBlocks(editor)];
  const out: SitePhotoBlock[] = [];
  for (const block of blocks) {
    if (!block.isVisible && !includeHidden) continue;
    const photos = photosIn(editor, block.id).flatMap((photo) =>
      photo.altText && photo.width && photo.height
        ? [
            {
              id: photo.id,
              width: photo.width,
              height: photo.height,
              alt: photo.altText,
              caption: photo.caption,
              focalX: photo.focalX,
              focalY: photo.focalY,
            },
          ]
        : [],
    );
    if (photos.length === 0) continue;
    out.push({
      kind: block.kind,
      variant: block.variant,
      anchor: block.kind === "cover" ? null : block.anchor,
      title: block.kind === "photo_text" ? block.title : null,
      body: block.kind === "photo_text" ? block.body : null,
      hidden: !block.isVisible,
      photos: SINGLE_PHOTO_KINDS.includes(block.kind) ? photos.slice(0, 1) : photos,
    });
  }
  return out;
}

// ---------------------------------------------------------- validation

// Control characters (C0, DEL, C1): plain text only; bodies keep line feeds.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const BODY_CONTROL_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

export type TextResult = Readonly<{ ok: true; value: string | null }> | Readonly<{ ok: false; error: "too_long" | "invalid" }>;

function oneLine(raw: string, max: number): TextResult {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if ([...value].length > max) return { ok: false, error: "too_long" };
  if (CONTROL_CHARACTERS.test(value)) return { ok: false, error: "invalid" };
  return { ok: true, value };
}

export function parseAltText(raw: string): TextResult {
  return oneLine(raw, PHOTO_LIMITS.altTextMax);
}

export function parseCaption(raw: string): TextResult {
  return oneLine(raw, PHOTO_LIMITS.captionMax);
}

export function parseBlockTitle(raw: string): TextResult {
  return oneLine(raw, PHOTO_LIMITS.blockTitleMax);
}

export function parseBlockBody(raw: string): TextResult {
  const value = raw.replace(/\r\n?/g, "\n").trim();
  if (!value) return { ok: true, value: null };
  if ([...value].length > PHOTO_LIMITS.blockBodyMax) return { ok: false, error: "too_long" };
  if (BODY_CONTROL_CHARACTERS.test(value)) return { ok: false, error: "invalid" };
  return { ok: true, value };
}

/** A focal coordinate from a form: a whole percentage 0–100, stored ×100. */
export function parseFocal(raw: string): number | null {
  if (!/^\d{1,3}$/.test(raw.trim())) return null;
  const percent = Number(raw.trim());
  return percent >= 0 && percent <= 100 ? percent * 100 : null;
}

export function parseAnchor(raw: string): SectionKind | null | undefined {
  if (raw === "" || raw === "top") return null;
  return (SECTION_KINDS as readonly string[]).includes(raw) ? (raw as SectionKind) : undefined;
}

export function parseVariant(kind: PhotoBlockKind, raw: string): PhotoBlockVariant | null {
  return isVariantOf(kind, raw) ? raw : null;
}

// ---------------------------------------------------------- composition

/** The blocks sharing a block's slot, in order (what "Mover antes / después" moves within). */
export function slotSiblings(editor: PhotoEditor, block: EditorBlock): EditorBlock[] {
  return orderedBlocks(editor).filter((other) => other.anchor === block.anchor);
}

/**
 * What a block will show: its ready photos, how many lack the description
 * the public read requires, and whether the published page would draw it
 * (visible and at least one described photo; the same rule as
 * `previewPhotoBlocks`).
 */
export function blockStatus(
  editor: PhotoEditor,
  block: EditorBlock,
): Readonly<{ photos: number; missingAlt: number; appears: boolean }> {
  const photos = photosIn(editor, block.id);
  const described = photos.filter((photo) => photo.altText && photo.width && photo.height).length;
  return { photos: photos.length, missingAlt: photos.length - described, appears: block.isVisible && described > 0 };
}

/** Whether another block can be created (the cover counts, like the database). */
export function canAddBlock(editor: PhotoEditor): boolean {
  return editor.blocks.length < PHOTO_LIMITS.blocksPerWedding;
}

/** Library photos a block can take: not already in it and not the cover (choosing one would replace the cover). */
export function photosForBlock(editor: PhotoEditor, block: EditorBlock): EditorPhoto[] {
  const cover = coverOf(editor).block;
  return libraryPhotos(editor).filter((photo) => photo.blockId !== block.id && (!cover || photo.blockId !== cover.id));
}
