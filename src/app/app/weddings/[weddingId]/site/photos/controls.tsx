import { getMessages } from "@/lib/i18n";
import { orderedBlocks, type EditorBlock, type EditorPhoto, type PhotoEditor } from "@/lib/wedding-site/photos/editor";
import { memberPhotoBasePath, photoSrc } from "@/lib/wedding-site/photos/model";

/**
 * Photo helpers shared by Studio and the "Biblioteca de fotos" (UX-01B,
 * STUDIO-01): a block's display name and the member-route thumbnail.
 */

/** A block's name: "Carrusel", "Foto con texto: Nuestra historia", "Galería 2". */
export function blockName(block: EditorBlock, editor: PhotoEditor): string {
  const kinds = getMessages().site.photos.blocks.kinds;
  if (block.kind === "cover") return kinds.cover;
  if (block.title) return `${kinds[block.kind]}: ${block.title}`;
  const sameKind = orderedBlocks(editor).filter((b) => b.kind === block.kind);
  return sameKind.length > 1 ? `${kinds[block.kind]} ${sameKind.indexOf(block) + 1}` : kinds[block.kind];
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
