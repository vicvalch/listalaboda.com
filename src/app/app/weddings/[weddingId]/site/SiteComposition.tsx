import Link from "next/link";

import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { inputClass, textLinkClass } from "@/components/ui/styles";
import { getMessages, interpolate } from "@/lib/i18n";
import {
  blockHasRoom,
  blockStatus,
  canAddBlock,
  coverOf,
  photosForBlock,
  photosIn,
  siteComposition,
  slotSiblings,
  libraryPhotos,
  type EditorBlock,
  type PhotoEditor,
} from "@/lib/wedding-site/photos/editor";
import { PHOTO_BLOCK_VARIANTS, PHOTO_LIMITS, type PhotoBlockKind } from "@/lib/wedding-site/photos/model";
import { hasPublicContent, sectionTitle, type EditorSection, type SectionKind } from "@/lib/wedding-site/sections";

import { ConfirmButton } from "../guests/ConfirmButton";
import { setSectionVisibilityAction } from "./actions";
import { Disclosure } from "./Disclosure";
import {
  addToBlockAction,
  deleteBlockAction,
  insertBlockAction,
  removeCoverAction,
  removeFromBlockAction,
  saveBlockAction,
  setBlockVisibilityAction,
  setCoverAction,
} from "./photos/actions";
import { AnchorSelect, BlockTextFields, blockName, MoveButtons, smallButton, Thumbnail } from "./photos/controls";
import { PhotoForm } from "./photos/PhotoForm";
import { SectionForm, VisibilityBadge } from "./SectionForm";

/**
 * "Secciones del sitio" (UX-01D): the one place where the website is put
 * together. Rows follow the public page exactly (`siteComposition`): every
 * fixed text section, the photo sections anchored after it, and an
 * "Agregar sección aquí" at the end of each slot, where a new gallery,
 * carousel or photo with text lands. Text sections keep their fixed order;
 * photo sections move within their slot by buttons and across slots by
 * "Ubicación". Without the photo flag (or when photos can't be read) it is
 * the text sections alone.
 */

const CREATABLE: readonly Exclude<PhotoBlockKind, "cover">[] = ["gallery", "carousel", "photo_text"];

function libraryPath(weddingId: string): string {
  return `/app/weddings/${encodeURIComponent(weddingId)}/site/photos`;
}

export function SiteComposition({
  weddingId,
  sections,
  photos,
  newBlockId,
}: {
  weddingId: string;
  sections: readonly EditorSection[];
  /** Null: photos off or unreadable (text sections only). */
  photos: PhotoEditor | null;
  /** A block just created here (`?nueva=`), opened and focused; only an id of this wedding's own blocks. */
  newBlockId: string | null;
}) {
  const copy = getMessages().site.compose;
  const rows = siteComposition(photos);
  const canAdd = photos ? canAddBlock(photos) : false;
  return (
    <>
      {photos && !canAdd ? <Notice tone="info">{copy.insert.limit}</Notice> : null}
      <ol className="space-y-3" data-testid="site-composition">
        {rows.map((row) => {
          if (row.type === "section") {
            const section = sections.find((s) => s.kind === row.kind);
            return section ? (
              <li key={`section-${row.kind}`}>
                <SectionForm weddingId={weddingId} section={section} toggle={<SectionToggle weddingId={weddingId} section={section} />} />
              </li>
            ) : null;
          }
          if (!photos) return null;
          if (row.type === "block") {
            return (
              <li key={`block-${row.block.id}`}>
                <BlockRow weddingId={weddingId} editor={photos} block={row.block} isNew={row.block.id === newBlockId} />
              </li>
            );
          }
          return canAdd ? (
            <li key={`insert-${row.anchor ?? "top"}`}>
              <InsertPoint weddingId={weddingId} anchor={row.anchor} />
            </li>
          ) : null;
        })}
      </ol>
    </>
  );
}

// ------------------------------------------------------------ text rows

function SectionToggle({ weddingId, section }: { weddingId: string; section: EditorSection }) {
  const copy = getMessages().site;
  const name = sectionTitle(section.kind, section.title);
  if (!section.isVisible && !hasPublicContent(section.kind, section.body)) {
    return <p className="text-muted self-center text-sm">{copy.sections.needsContent}</p>;
  }
  return (
    <PhotoForm
      action={setSectionVisibilityAction}
      hidden={{ weddingId, kind: section.kind, visible: section.isVisible ? "off" : "on" }}
      submitLabel={section.isVisible ? copy.compose.hide : copy.compose.show}
      submitAriaLabel={interpolate(section.isVisible ? copy.compose.hideLabel : copy.compose.showLabel, { name })}
      pendingLabel={copy.sections.submitting}
      buttonClassName={smallButton}
    />
  );
}

// ------------------------------------------------------- insertion point

function InsertPoint({ weddingId, anchor }: { weddingId: string; anchor: SectionKind | null }) {
  const copy = getMessages().site.compose.insert;
  const blocks = getMessages().site.photos.blocks;
  const where = anchor === null ? copy.atTop : interpolate(copy.after, { section: sectionTitle(anchor, null) });
  return (
    <div className="border-l-2 border-dashed border-border py-1 pl-4" data-testid="site-insert" data-anchor={anchor ?? "top"}>
      <Disclosure summary={copy.open} summaryLabel={`${copy.open}, ${where}`}>
        <div className="space-y-3 rounded-2xl border border-border bg-surface p-4 shadow-sm">
          <p className="font-semibold">{copy.question}</p>
          <ul className="grid gap-3 sm:grid-cols-3">
            {CREATABLE.map((kind) => (
              <li key={kind} className="flex flex-col justify-between gap-2 rounded-lg border border-border p-3">
                <div className="space-y-1">
                  <p className="font-semibold">{blocks.kinds[kind]}</p>
                  <p className="text-muted text-sm">{blocks.kindHints[kind]}</p>
                </div>
                <form action={insertBlockAction}>
                  <input type="hidden" name="weddingId" value={weddingId} />
                  <input type="hidden" name="kind" value={kind} />
                  <input type="hidden" name="anchor" value={anchor ?? "top"} />
                  <SubmitButton
                    label={interpolate(copy.add, { kind: blocks.kinds[kind] })}
                    pendingLabel={copy.adding}
                    variant="secondary"
                    className={smallButton}
                    ariaLabel={`${interpolate(copy.add, { kind: blocks.kinds[kind] })}, ${where}`}
                  />
                </form>
              </li>
            ))}
          </ul>
        </div>
      </Disclosure>
    </div>
  );
}

// ------------------------------------------------------------ photo rows

function BlockRow({
  weddingId,
  editor,
  block,
  isNew,
}: {
  weddingId: string;
  editor: PhotoEditor;
  block: EditorBlock;
  isNew: boolean;
}) {
  const copy = getMessages().site.compose;
  const blocks = getMessages().site.photos.blocks;
  const name = blockName(block, editor);
  const status = blockStatus(editor, block);
  const photos = photosIn(editor, block.id);
  const siblings = slotSiblings(editor, block);
  const place = siblings.findIndex((other) => other.id === block.id);
  const directions = [...(place > 0 ? (["before"] as const) : []), ...(place < siblings.length - 1 ? (["after"] as const) : [])];
  const id = `block-${block.id}`;
  const variants = PHOTO_BLOCK_VARIANTS[block.kind];

  return (
    <article
      id={`bloque-${block.id}`}
      aria-labelledby={`${id}-name`}
      className={`space-y-3 rounded-2xl border bg-surface p-4 shadow-sm sm:p-5 ${block.isVisible ? "border-border" : "border-dashed border-border"}`}
      data-testid="photo-block"
      data-block-kind={block.kind}
    >
      {isNew ? (
        <Notice tone="success">
          <span className="block">{interpolate(copy.created, { name })}</span>
          <ol className="mt-1 list-decimal pl-5 font-normal">
            {copy.nextSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </Notice>
      ) : null}
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 space-y-0.5">
          <p className="text-muted text-xs font-semibold tracking-wide uppercase">
            {copy.photoKind} · {blocks.kinds[block.kind]}
          </p>
          <h3 id={`${id}-name`} className="text-lg font-semibold break-words">
            {name}
          </h3>
        </div>
        <VisibilityBadge visible={block.isVisible} testId="photo-block-visibility" />
      </header>

      <div className="space-y-1 text-sm">
        <p className="text-muted" data-testid="photo-block-count">
          {status.photos === 0
            ? copy.block.noPhotos
            : status.photos === 1
              ? copy.block.photoCountOne
              : interpolate(copy.block.photoCountMany, { count: String(status.photos) })}
        </p>
        {status.missingAlt > 0 ? (
          <p className="font-semibold" data-testid="photo-block-missing-alt">
            {interpolate(copy.block.missingAlt, { count: String(status.missingAlt) })}
          </p>
        ) : null}
        {block.isVisible && !status.appears ? (
          <p className="font-semibold" data-testid="photo-block-not-shown">
            {copy.block.visibleButEmpty}
          </p>
        ) : null}
      </div>

      {photos.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-hidden="true">
          {photos.slice(0, 6).map((photo) => (
            <li key={photo.id} className="w-20">
              <Thumbnail weddingId={weddingId} photo={photo} />
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-start gap-3">
        <Disclosure
          summary={getMessages().site.sections.edit}
          summaryLabel={interpolate(getMessages().site.sections.editLabel, { name })}
          defaultOpen={isNew}
          focusOnOpen={isNew}
          testId="photo-block-editor"
        >
          <div className="space-y-5">
            <PhotoForm
              action={saveBlockAction}
              hidden={{ weddingId, blockId: block.id, kind: block.kind }}
              submitLabel={blocks.save}
              pendingLabel={blocks.saving}
              className="space-y-3"
            >
              <label className="flex items-center gap-2">
                <input type="checkbox" name="visible" defaultChecked={block.isVisible} className="h-5 w-5" />
                <span>{blocks.visibleLabel}</span>
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label htmlFor={`${id}-anchor`} className="block text-sm font-semibold">
                    {blocks.anchorLabel}
                  </label>
                  <AnchorSelect id={`${id}-anchor`} value={block.anchor} />
                </div>
                {variants.length > 1 ? (
                  <div className="space-y-1">
                    <label htmlFor={`${id}-variant`} className="block text-sm font-semibold">
                      {blocks.variantLabel}
                    </label>
                    <select id={`${id}-variant`} name="variant" defaultValue={block.variant} className={inputClass}>
                      {variants.map((variant) => (
                        <option key={variant} value={variant}>
                          {blocks.variants[variant]}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <input type="hidden" name="variant" value={block.variant} />
                )}
              </div>
              {block.kind === "photo_text" ? <BlockTextFields id={id} title={block.title} body={block.body} /> : null}
            </PhotoForm>

            <BlockPhotos weddingId={weddingId} editor={editor} block={block} name={name} />
            <PhotoPicker weddingId={weddingId} editor={editor} block={block} name={name} />

            <div className="border-t border-border pt-4">
              <ConfirmButton
                action={deleteBlockAction}
                hidden={{ weddingId, blockId: block.id }}
                id={`${id}-delete`}
                openLabel={blocks.delete}
                confirmTitle={blocks.deleteTitle}
                confirmBody={[blocks.deleteBody]}
                confirmLabel={blocks.delete}
                cancelLabel={blocks.cancel}
              />
            </div>
          </div>
        </Disclosure>
        <PhotoForm
          action={setBlockVisibilityAction}
          hidden={{ weddingId, blockId: block.id, visible: block.isVisible ? "off" : "on", name }}
          submitLabel={block.isVisible ? copy.hide : copy.show}
          submitAriaLabel={interpolate(block.isVisible ? copy.hideLabel : copy.showLabel, { name })}
          pendingLabel={blocks.saving}
          buttonClassName={smallButton}
        />
        {directions.length > 0 ? (
          <MoveButtons weddingId={weddingId} target="block" id={block.id} name={name} directions={directions} />
        ) : null}
      </div>
    </article>
  );
}

/** The photos in a block, in order, with "Mover" and "Quitar de la sección". */
function BlockPhotos({ weddingId, editor, block, name }: { weddingId: string; editor: PhotoEditor; block: EditorBlock; name: string }) {
  const copy = getMessages().site.photos;
  const photos = photosIn(editor, block.id);
  if (photos.length === 0) return null;
  return (
    <ol className="grid gap-3 sm:grid-cols-2" data-testid="photo-block-photos">
      {photos.map((photo, position) => {
        const photoName = interpolate(copy.blocks.photoName, { position: String(position + 1) });
        const directions = [...(position > 0 ? (["before"] as const) : []), ...(position < photos.length - 1 ? (["after"] as const) : [])];
        return (
          <li key={photo.id} className="flex gap-3 rounded-lg border border-border p-3">
            <div className="w-24 shrink-0">
              <Thumbnail weddingId={weddingId} photo={photo} />
            </div>
            <div className="min-w-0 space-y-2">
              <p className="text-sm font-semibold">{photoName}</p>
              {photo.altText ? null : <p className="text-xs font-semibold">{copy.library.missingAltShort}</p>}
              {directions.length > 0 ? (
                <MoveButtons weddingId={weddingId} target="photo" id={photo.id} name={`${photoName} (${name})`} directions={directions} />
              ) : null}
              <PhotoForm
                action={removeFromBlockAction}
                hidden={{ weddingId, photoId: photo.id }}
                submitLabel={copy.library.removeFromBlock}
                pendingLabel={copy.library.saving}
                buttonClassName={smallButton}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** "Agregar fotos de tu biblioteca": the library's photos, each with "Agregar"; a way to upload more. */
function PhotoPicker({ weddingId, editor, block, name }: { weddingId: string; editor: PhotoEditor; block: EditorBlock; name: string }) {
  const copy = getMessages().site.compose.block;
  const library = libraryPhotos(editor);
  const choices = photosForBlock(editor, block);
  const room = blockHasRoom(editor, block);
  return (
    <section className="space-y-3" aria-labelledby={`picker-${block.id}`} data-testid="photo-picker">
      <h4 id={`picker-${block.id}`} className="font-semibold">
        {copy.pickTitle}
      </h4>
      {library.length === 0 ? (
        <p className="text-muted text-sm">{copy.pickEmpty}</p>
      ) : !room ? (
        <p className="text-muted text-sm">{copy.full}</p>
      ) : choices.length === 0 ? (
        <p className="text-muted text-sm">{copy.pickNone}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {choices.map((photo) => {
            const position = library.indexOf(photo) + 1;
            const placed = photo.blockId ? editor.blocks.find((other) => other.id === photo.blockId) : null;
            return (
              <li key={photo.id} className="space-y-1.5" data-testid="photo-picker-item">
                <Thumbnail weddingId={weddingId} photo={photo} />
                {photo.altText ? null : <p className="text-xs font-semibold">{getMessages().site.photos.library.missingAltShort}</p>}
                {placed ? <p className="text-muted text-xs">{interpolate(copy.inOther, { place: blockName(placed, editor) })}</p> : null}
                <PhotoForm
                  action={addToBlockAction}
                  hidden={{ weddingId, photoId: photo.id, blockId: block.id }}
                  submitLabel={copy.add}
                  submitAriaLabel={interpolate(copy.addLabel, { position: String(position), block: name })}
                  pendingLabel={getMessages().site.photos.library.saving}
                  buttonClassName={smallButton}
                />
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-sm">
        <Link href={`${libraryPath(weddingId)}#subir`} className={textLinkClass}>
          {copy.upload}
        </Link>
      </p>
    </section>
  );
}

// ----------------------------------------------------------------- cover

/** The cover photo inside "Portada": show or hide it, choose or change it from the library, remove it. */
export function CoverPhoto({ weddingId, editor }: { weddingId: string; editor: PhotoEditor }) {
  const copy = getMessages().site.compose;
  const photosCopy = getMessages().site.photos;
  const { block: cover, photo } = coverOf(editor);
  const library = libraryPhotos(editor);
  const choices = library.filter((candidate) => candidate.id !== photo?.id);
  return (
    <div className="space-y-3 border-t border-border pt-5" data-testid="photos-cover">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-lg font-semibold">{copy.cover.photoTitle}</h3>
        {cover && photo ? <VisibilityBadge visible={cover.isVisible} testId="photo-cover-visibility" /> : null}
      </div>
      {cover && photo ? (
        <div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
          <Thumbnail weddingId={weddingId} photo={photo} />
          <div className="space-y-3">
            {photo.altText ? null : <p className="text-sm font-semibold">{photosCopy.library.missingAlt}</p>}
            <div className="flex flex-wrap gap-3">
              <PhotoForm
                action={setBlockVisibilityAction}
                hidden={{ weddingId, blockId: cover.id, visible: cover.isVisible ? "off" : "on", name: copy.cover.photoTitle }}
                submitLabel={cover.isVisible ? copy.hide : copy.show}
                submitAriaLabel={interpolate(cover.isVisible ? copy.hideLabel : copy.showLabel, { name: copy.cover.photoTitle })}
                pendingLabel={photosCopy.cover.saving}
                buttonClassName={smallButton}
              />
              <ConfirmButton
                action={removeCoverAction}
                hidden={{ weddingId, photoId: photo.id }}
                id="remove-cover"
                openLabel={photosCopy.cover.remove}
                confirmTitle={photosCopy.cover.removeTitle}
                confirmBody={[photosCopy.cover.removeBody]}
                confirmLabel={photosCopy.cover.remove}
                cancelLabel={photosCopy.cover.cancel}
              />
            </div>
          </div>
        </div>
      ) : (
        <p className="text-muted text-sm">{copy.cover.none}</p>
      )}
      <Disclosure summary={photo ? copy.cover.change : copy.cover.choose} testId="cover-picker">
        {choices.length === 0 ? (
          <p className="text-muted text-sm">{copy.block.pickEmpty}</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {choices.map((candidate) => {
              const position = library.indexOf(candidate) + 1;
              return (
                <li key={candidate.id} className="space-y-1.5" data-testid="cover-picker-item">
                  <Thumbnail weddingId={weddingId} photo={candidate} />
                  {candidate.altText ? null : <p className="text-xs font-semibold">{photosCopy.library.missingAltShort}</p>}
                  <PhotoForm
                    action={setCoverAction}
                    hidden={{ weddingId, photoId: candidate.id }}
                    submitLabel={photosCopy.library.useAsCover}
                    submitAriaLabel={interpolate(copy.cover.useLabel, { position: String(position) })}
                    pendingLabel={photosCopy.library.usingAsCover}
                    buttonClassName={smallButton}
                  />
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-3 text-sm">
          <Link href={`${libraryPath(weddingId)}#subir`} className={textLinkClass}>
            {copy.block.upload}
          </Link>
        </p>
      </Disclosure>
      <p className="text-muted text-xs">
        {interpolate(photosCopy.count, { count: String(editor.photos.length), max: String(PHOTO_LIMITS.photosPerWedding) })}
      </p>
    </div>
  );
}
