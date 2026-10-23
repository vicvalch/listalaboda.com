import { inputClass } from "@/components/ui/styles";
import { getMessages, interpolate } from "@/lib/i18n";
import { orderedBlocks, type EditorBlock, type EditorPhoto, type PhotoEditor } from "@/lib/wedding-site/photos/editor";
import { memberPhotoBasePath, PHOTO_LIMITS, photoSrc } from "@/lib/wedding-site/photos/model";
import { SECTION_KINDS, sectionTitle, type SectionKind } from "@/lib/wedding-site/sections";

import { moveAction } from "./actions";
import { PhotoForm } from "./PhotoForm";

/**
 * Photo controls shared by "Secciones del sitio" and the "Biblioteca de
 * fotos" (UX-01B, UX-01D): names, thumbnails, the slot select and the
 * keyboard-friendly "Mover antes / Mover después" buttons (LB-20: no drag
 * library).
 */

export const smallButton = "min-h-9 px-3 py-1.5 text-sm";

/** A block's name: "Carrusel", "Foto con texto: Nuestra historia", "Galería 2". */
export function blockName(block: EditorBlock, editor: PhotoEditor): string {
  const kinds = getMessages().site.photos.blocks.kinds;
  if (block.kind === "cover") return kinds.cover;
  if (block.title) return `${kinds[block.kind]}: ${block.title}`;
  const sameKind = orderedBlocks(editor).filter((b) => b.kind === block.kind);
  return sameKind.length > 1 ? `${kinds[block.kind]} ${sameKind.indexOf(block) + 1}` : kinds[block.kind];
}

export function anchorLabel(anchor: SectionKind | null): string {
  const copy = getMessages().site.photos.blocks;
  return anchor === null ? copy.anchorTop : interpolate(copy.anchorAfter, { section: sectionTitle(anchor, null) });
}

export function Thumbnail({ weddingId, photo, className }: { weddingId: string; photo: EditorPhoto; className?: string }) {
  return (
    // Plain <img> on purpose (ADR-022): our own processed renditions; next/image would add
    // paid transformations and a second, ungated path to the bytes.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={photoSrc(memberPhotoBasePath(weddingId), photo.id, "640")}
      width={photo.width ?? undefined}
      height={photo.height ?? undefined}
      alt={photo.altText ?? getMessages().site.photos.library.thumbnailAlt}
      loading="lazy"
      decoding="async"
      className={`block aspect-[4/3] w-full rounded-lg border border-border bg-background object-cover ${className ?? ""}`}
      style={{ objectPosition: `${photo.focalX / 100}% ${photo.focalY / 100}%` }}
    />
  );
}

export function AnchorSelect({ value, id }: { value: SectionKind | null; id: string }) {
  return (
    <select id={id} name="anchor" defaultValue={value ?? "top"} className={inputClass}>
      <option value="top">{anchorLabel(null)}</option>
      {SECTION_KINDS.map((kind) => (
        <option key={kind} value={kind}>
          {anchorLabel(kind)}
        </option>
      ))}
    </select>
  );
}

/** "Mover antes / Mover después"; `directions` leaves out the one that can't move (first or last). */
export function MoveButtons({
  weddingId,
  target,
  id,
  name,
  directions = ["before", "after"],
}: {
  weddingId: string;
  target: "block" | "photo";
  id: string;
  name: string;
  directions?: readonly ("before" | "after")[];
}) {
  const copy = getMessages().site.photos.blocks;
  return (
    <div className="flex flex-wrap gap-2">
      {directions.map((direction) => (
        <PhotoForm
          key={direction}
          action={moveAction}
          hidden={{ weddingId, target, id, direction, name }}
          submitLabel={direction === "before" ? copy.moveBefore : copy.moveAfter}
          submitAriaLabel={interpolate(direction === "before" ? copy.moveBeforeLabel : copy.moveAfterLabel, { name })}
          pendingLabel={copy.saving}
          buttonClassName={smallButton}
        />
      ))}
    </div>
  );
}

export function BlockTextFields({ id, title, body }: { id: string; title: string | null; body: string | null }) {
  const copy = getMessages().site.photos.blocks;
  return (
    <>
      <div className="space-y-1">
        <label htmlFor={`${id}-title`} className="block text-sm font-semibold">
          {copy.titleLabel}
        </label>
        <input id={`${id}-title`} name="title" maxLength={PHOTO_LIMITS.blockTitleMax} defaultValue={title ?? ""} className={inputClass} />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-body`} className="block text-sm font-semibold">
          {copy.bodyLabel}
        </label>
        <textarea id={`${id}-body`} name="body" rows={4} maxLength={PHOTO_LIMITS.blockBodyMax} defaultValue={body ?? ""} className={inputClass} />
      </div>
    </>
  );
}
