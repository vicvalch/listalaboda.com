import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Notice } from "@/components/ui/Notice";
import { cardClass, inputClass, textLinkClass } from "@/components/ui/styles";
import { loginPath } from "@/lib/auth/redirect";
import { requireUser } from "@/lib/auth/session";
import { requireWeddingMembership } from "@/lib/authz/wedding";
import { getMessages, interpolate } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  blockHasRoom,
  coverOf,
  libraryPhotos,
  orderedBlocks,
  photoCount,
  photosIn,
  type EditorBlock,
  type EditorPhoto,
  type PhotoEditor,
} from "@/lib/wedding-site/photos/editor";
import { isWeddingSitePhotosEnabled } from "@/lib/wedding-site/photos/flag";
import {
  memberPhotoBasePath,
  PHOTO_BLOCK_VARIANTS,
  PHOTO_LIMITS,
  photoSrc,
  type PhotoBlockKind,
} from "@/lib/wedding-site/photos/model";
import { getPhotoEditor } from "@/lib/wedding-site/photos/service";
import { SECTION_KINDS, sectionTitle, type SectionKind } from "@/lib/wedding-site/sections";
import { getWeddingDetail } from "@/lib/weddings/service";

import { ConfirmButton } from "../../guests/ConfirmButton";
import {
  addToBlockAction,
  createBlockAction,
  deleteBlockAction,
  deletePhotoAction,
  moveAction,
  removeCoverAction,
  removeFromBlockAction,
  saveBlockAction,
  savePhotoAction,
  setCoverAction,
} from "./actions";
import { PhotoForm } from "./PhotoForm";
import { PhotoUploader } from "./PhotoUploader";

export const metadata: Metadata = {
  title: getMessages().site.photos.title,
  robots: { index: false, follow: false },
};

const smallButton = "min-h-9 px-3 py-1.5 text-sm";

/**
 * "Fotos del sitio" (UX-01B, ADR-022): the wedding's photo library, its cover
 * and its photo blocks, for any member (owner or collaborator). Membership is
 * checked server-side first; a non-member, a nonexistent wedding, a malformed
 * id and the flag being off all get the same 404. Reading never writes.
 * Predefined blocks only (no free layout); reordering by buttons (LB-20: no
 * drag library); every block starts hidden, and the member preview shows the
 * result before publishing.
 */
export default async function WeddingSitePhotosPage({ params }: PageProps<"/app/weddings/[weddingId]/site/photos">) {
  const { weddingId } = await params;
  const selfPath = `/app/weddings/${encodeURIComponent(weddingId)}/site/photos`;
  await requireUser(selfPath);
  if (!isWeddingSitePhotosEnabled()) notFound();

  const supabase = await createSupabaseServerClient();
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) {
    if (access.reason === "unauthenticated") redirect(loginPath(selfPath));
    notFound();
  }

  const [wedding, editor] = await Promise.all([
    getWeddingDetail(supabase, access.access.weddingId),
    getPhotoEditor(supabase, access.access),
  ]);
  if (!wedding) notFound();

  const copy = getMessages().site.photos;
  const sitePath = `/app/weddings/${encodeURIComponent(wedding.id)}/site`;

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <p className="text-muted text-sm font-semibold break-words">{wedding.name}</p>
        <h1 className="text-3xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="text-muted">{copy.intro}</p>
        <p className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <Link href={sitePath} className={textLinkClass}>
            {copy.back}
          </Link>
          <Link href={`${sitePath}/preview`} className={textLinkClass}>
            {copy.previewLink}
          </Link>
        </p>
      </header>

      <Notice tone="info">
        <span className="block font-semibold">{copy.disclosure}</span>
        <span className="mt-1 block">{copy.rights}</span>
        <span className="mt-1 block">{copy.metadataNote}</span>
      </Notice>

      {editor === null ? (
        <Notice tone="error">{getMessages().site.loadFailed}</Notice>
      ) : (
        <PhotosEditor weddingId={wedding.id} editor={editor} />
      )}
    </div>
  );
}

function blockName(block: EditorBlock, editor: PhotoEditor): string {
  const kinds = getMessages().site.photos.blocks.kinds;
  if (block.kind === "cover") return kinds.cover;
  if (block.title) return `${kinds[block.kind]}: ${block.title}`;
  const sameKind = orderedBlocks(editor).filter((b) => b.kind === block.kind);
  return sameKind.length > 1 ? `${kinds[block.kind]} ${sameKind.indexOf(block) + 1}` : kinds[block.kind];
}

function anchorLabel(anchor: SectionKind | null): string {
  const copy = getMessages().site.photos.blocks;
  return anchor === null ? copy.anchorTop : interpolate(copy.anchorAfter, { section: sectionTitle(anchor, null) });
}

function Thumbnail({ weddingId, photo, className }: { weddingId: string; photo: EditorPhoto; className?: string }) {
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

function AnchorSelect({ value, id }: { value: SectionKind | null; id: string }) {
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

function PhotosEditor({ weddingId, editor }: { weddingId: string; editor: PhotoEditor }) {
  const copy = getMessages().site.photos;
  const count = photoCount(editor);
  const { block: cover, photo: coverPhoto } = coverOf(editor);
  const library = libraryPhotos(editor);
  const blocks = orderedBlocks(editor);

  return (
    <>
      <p className="font-semibold" data-testid="photo-count">
        {interpolate(copy.count, { count: String(count), max: String(PHOTO_LIMITS.photosPerWedding) })}
      </p>

      {/* ------------------------------------------------------- cover */}
      <section className={`${cardClass} space-y-4`} aria-labelledby="photos-cover-title" data-testid="photos-cover">
        <header className="space-y-1">
          <h2 id="photos-cover-title" className="text-xl font-semibold">
            {copy.cover.title}
          </h2>
          <p className="text-muted text-sm">{copy.cover.intro}</p>
        </header>
        {cover && coverPhoto ? (
          <div className="grid gap-4 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
            <Thumbnail weddingId={weddingId} photo={coverPhoto} />
            <div className="space-y-4">
              {coverPhoto.altText ? null : <Notice tone="error">{copy.library.missingAlt}</Notice>}
              <PhotoForm
                action={saveBlockAction}
                hidden={{ weddingId, blockId: cover.id, kind: "cover" }}
                submitLabel={copy.cover.save}
                pendingLabel={copy.cover.saving}
                className="space-y-3"
              >
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="visible" defaultChecked={cover.isVisible} className="h-5 w-5" />
                  <span>{copy.cover.visibleLabel}</span>
                </label>
              </PhotoForm>
              <p className="text-muted text-sm">{copy.cover.replaceHint}</p>
              <ConfirmButton
                action={removeCoverAction}
                hidden={{ weddingId, photoId: coverPhoto.id }}
                id="remove-cover"
                openLabel={copy.cover.remove}
                confirmTitle={copy.cover.removeTitle}
                confirmBody={[copy.cover.removeBody]}
                confirmLabel={copy.cover.remove}
                cancelLabel={copy.cover.cancel}
              />
            </div>
          </div>
        ) : (
          <p className="text-muted">{copy.cover.none}</p>
        )}
      </section>

      {/* ------------------------------------------------------ upload */}
      <section className={`${cardClass} space-y-4`} aria-labelledby="photos-upload-title">
        <h2 id="photos-upload-title" className="text-xl font-semibold">
          {copy.upload.title}
        </h2>
        <PhotoUploader weddingId={weddingId} remaining={Math.max(0, PHOTO_LIMITS.photosPerWedding - count)} />
      </section>

      {/* ----------------------------------------------------- library */}
      <section className="space-y-4" aria-labelledby="photos-library-title" data-testid="photos-library">
        <h2 id="photos-library-title" className="text-2xl font-semibold tracking-tight">
          {copy.library.title}
        </h2>
        {library.length === 0 ? <p className="text-muted">{copy.library.empty}</p> : null}
        <ul className="grid gap-4 sm:grid-cols-2">
          {library.map((photo, index) => (
            <li key={photo.id} className="space-y-4 rounded-2xl border border-border bg-surface p-4 shadow-sm" data-testid="library-photo">
              <LibraryPhoto weddingId={weddingId} editor={editor} photo={photo} index={index} isCover={photo.id === coverPhoto?.id} />
            </li>
          ))}
        </ul>
      </section>

      {/* ------------------------------------------------------ blocks */}
      <section className="space-y-4" aria-labelledby="photos-blocks-title" data-testid="photos-blocks">
        <header className="space-y-1">
          <h2 id="photos-blocks-title" className="text-2xl font-semibold tracking-tight">
            {copy.blocks.title}
          </h2>
          <p className="text-muted">{copy.blocks.intro}</p>
        </header>
        {blocks.length === 0 ? <p className="text-muted">{copy.blocks.empty}</p> : null}
        <ol className="space-y-4">
          {blocks.map((block) => (
            <li key={block.id} className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-sm" data-testid="photo-block">
              <BlockEditor weddingId={weddingId} editor={editor} block={block} />
            </li>
          ))}
        </ol>
        <CreateBlock weddingId={weddingId} />
      </section>
    </>
  );
}

function LibraryPhoto({
  weddingId,
  editor,
  photo,
  index,
  isCover,
}: {
  weddingId: string;
  editor: PhotoEditor;
  photo: EditorPhoto;
  index: number;
  isCover: boolean;
}) {
  const copy = getMessages().site.photos;
  const placedIn = photo.blockId ? editor.blocks.find((block) => block.id === photo.blockId) : null;
  const targets = orderedBlocks(editor).filter((block) => block.id !== photo.blockId && blockHasRoom(editor, block));
  const id = `photo-${index}`;
  return (
    <>
      <Thumbnail weddingId={weddingId} photo={photo} />
      <p className="text-sm font-semibold">
        {placedIn ? interpolate(copy.library.placedIn, { place: blockName(placedIn, editor) }) : copy.library.notPlaced}
      </p>
      {photo.altText ? null : (
        <p className="text-danger text-sm font-semibold" data-testid="photo-missing-alt">
          {copy.library.missingAlt}
        </p>
      )}
      <PhotoForm
        action={savePhotoAction}
        hidden={{ weddingId, photoId: photo.id }}
        submitLabel={copy.library.save}
        pendingLabel={copy.library.saving}
        className="space-y-3"
      >
        <div className="space-y-1">
          <label htmlFor={`${id}-alt`} className="block text-sm font-semibold">
            {copy.library.altLabel}
          </label>
          <textarea
            id={`${id}-alt`}
            name="altText"
            rows={2}
            maxLength={PHOTO_LIMITS.altTextMax}
            defaultValue={photo.altText ?? ""}
            aria-describedby={`${id}-alt-hint`}
            className={inputClass}
          />
          <p id={`${id}-alt-hint`} className="text-muted text-xs">
            {copy.library.altHint}
          </p>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-caption`} className="block text-sm font-semibold">
            {copy.library.captionLabel}
          </label>
          <input
            id={`${id}-caption`}
            name="caption"
            maxLength={PHOTO_LIMITS.captionMax}
            defaultValue={photo.caption ?? ""}
            className={inputClass}
          />
        </div>
        <fieldset className="space-y-1">
          <legend className="text-sm font-semibold">{copy.library.focalLabel}</legend>
          <p className="text-muted text-xs">{copy.library.focalHint}</p>
          <div className="flex flex-wrap gap-3">
            <label className="space-y-1 text-sm">
              <span className="block">{copy.library.focalX}</span>
              <input name="focalX" type="number" min={0} max={100} step={1} defaultValue={Math.round(photo.focalX / 100)} className={`${inputClass} w-24`} />
            </label>
            <label className="space-y-1 text-sm">
              <span className="block">{copy.library.focalY}</span>
              <input name="focalY" type="number" min={0} max={100} step={1} defaultValue={Math.round(photo.focalY / 100)} className={`${inputClass} w-24`} />
            </label>
          </div>
        </fieldset>
      </PhotoForm>

      <div className="flex flex-wrap gap-3 border-t border-border pt-4">
        {isCover ? (
          <p className="text-sm font-semibold">{copy.library.isCover}</p>
        ) : (
          <PhotoForm
            action={setCoverAction}
            hidden={{ weddingId, photoId: photo.id }}
            submitLabel={copy.library.useAsCover}
            pendingLabel={copy.library.usingAsCover}
            buttonClassName={smallButton}
          />
        )}
        {placedIn && placedIn.kind !== "cover" ? (
          <PhotoForm
            action={removeFromBlockAction}
            hidden={{ weddingId, photoId: photo.id }}
            submitLabel={copy.library.removeFromBlock}
            pendingLabel={copy.library.saving}
            buttonClassName={smallButton}
          />
        ) : null}
      </div>

      {targets.length > 0 ? (
        <PhotoForm
          action={addToBlockAction}
          hidden={{ weddingId, photoId: photo.id }}
          submitLabel={copy.library.addToButton}
          pendingLabel={copy.library.saving}
          buttonClassName={smallButton}
          className="space-y-2"
        >
          <label htmlFor={`${id}-block`} className="block text-sm font-semibold">
            {copy.library.addTo}
          </label>
          <select id={`${id}-block`} name="blockId" className={inputClass}>
            {targets.map((block) => (
              <option key={block.id} value={block.id}>
                {blockName(block, editor)}
              </option>
            ))}
          </select>
        </PhotoForm>
      ) : null}

      <ConfirmButton
        action={deletePhotoAction}
        hidden={{ weddingId, photoId: photo.id }}
        id={`${id}-delete`}
        openLabel={copy.library.delete}
        confirmTitle={copy.library.deleteTitle}
        confirmBody={[copy.library.deleteBody]}
        confirmLabel={copy.library.delete}
        cancelLabel={copy.library.cancel}
      />
    </>
  );
}

function MoveButtons({
  weddingId,
  target,
  id,
  name,
}: {
  weddingId: string;
  target: "block" | "photo";
  id: string;
  name: string;
}) {
  const copy = getMessages().site.photos.blocks;
  return (
    <div className="flex flex-wrap gap-2">
      {(["before", "after"] as const).map((direction) => (
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

function BlockEditor({ weddingId, editor, block }: { weddingId: string; editor: PhotoEditor; block: EditorBlock }) {
  const copy = getMessages().site.photos.blocks;
  const library = getMessages().site.photos.library;
  const name = blockName(block, editor);
  const photos = photosIn(editor, block.id);
  const id = `block-${block.id}`;
  const variants = PHOTO_BLOCK_VARIANTS[block.kind];
  return (
    <>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold break-words">{name}</h3>
        <span className="rounded-full border border-border px-3 py-0.5 text-xs font-semibold">
          {block.isVisible ? copy.visibleBadge : copy.hiddenBadge}
        </span>
      </header>
      <p className="text-muted text-sm">{anchorLabel(block.anchor)}</p>
      <MoveButtons weddingId={weddingId} target="block" id={block.id} name={name} />

      <PhotoForm
        action={saveBlockAction}
        hidden={{ weddingId, blockId: block.id, kind: block.kind }}
        submitLabel={copy.save}
        pendingLabel={copy.saving}
        className="space-y-3"
      >
        <label className="flex items-center gap-2">
          <input type="checkbox" name="visible" defaultChecked={block.isVisible} className="h-5 w-5" />
          <span>{copy.visibleLabel}</span>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor={`${id}-anchor`} className="block text-sm font-semibold">
              {copy.anchorLabel}
            </label>
            <AnchorSelect id={`${id}-anchor`} value={block.anchor} />
          </div>
          {variants.length > 1 ? (
            <div className="space-y-1">
              <label htmlFor={`${id}-variant`} className="block text-sm font-semibold">
                {copy.variantLabel}
              </label>
              <select id={`${id}-variant`} name="variant" defaultValue={block.variant} className={inputClass}>
                {variants.map((variant) => (
                  <option key={variant} value={variant}>
                    {copy.variants[variant]}
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

      {photos.length === 0 ? (
        <p className="text-muted text-sm">{copy.noPhotos}</p>
      ) : (
        <ol className="grid gap-3 sm:grid-cols-2">
          {photos.map((photo, position) => {
            const photoName = interpolate(copy.photoName, { position: String(position + 1) });
            return (
              <li key={photo.id} className="space-y-2 rounded-lg border border-border p-3">
                <Thumbnail weddingId={weddingId} photo={photo} />
                <p className="text-sm font-semibold">{photoName}</p>
                {photo.altText ? null : <p className="text-danger text-xs font-semibold">{library.missingAlt}</p>}
                {photos.length > 1 ? (
                  <MoveButtons weddingId={weddingId} target="photo" id={photo.id} name={`${photoName} (${name})`} />
                ) : null}
                <PhotoForm
                  action={removeFromBlockAction}
                  hidden={{ weddingId, photoId: photo.id }}
                  submitLabel={library.removeFromBlock}
                  pendingLabel={library.saving}
                  buttonClassName={smallButton}
                />
              </li>
            );
          })}
        </ol>
      )}

      <ConfirmButton
        action={deleteBlockAction}
        hidden={{ weddingId, blockId: block.id }}
        id={`${id}-delete`}
        openLabel={copy.delete}
        confirmTitle={copy.deleteTitle}
        confirmBody={[copy.deleteBody]}
        confirmLabel={copy.delete}
        cancelLabel={copy.cancel}
      />
    </>
  );
}

function BlockTextFields({ id, title, body }: { id: string; title: string | null; body: string | null }) {
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

const CREATABLE: readonly Exclude<PhotoBlockKind, "cover">[] = ["gallery", "carousel", "photo_text"];

function CreateBlock({ weddingId }: { weddingId: string }) {
  const copy = getMessages().site.photos.blocks;
  return (
    <section className={`${cardClass} space-y-4`} aria-labelledby="photos-create-title" data-testid="photo-block-create">
      <h3 id="photos-create-title" className="text-lg font-semibold">
        {copy.createTitle}
      </h3>
      <ul className="space-y-4">
        {CREATABLE.map((kind) => (
          <li key={kind} className="space-y-2 rounded-lg border border-border p-4">
            <p className="font-semibold">{copy.kinds[kind]}</p>
            <p className="text-muted text-sm">{copy.kindHints[kind]}</p>
            <PhotoForm
              action={createBlockAction}
              hidden={{ weddingId, kind }}
              submitLabel={`${copy.create}: ${copy.kinds[kind]}`}
              pendingLabel={copy.creating}
              className="space-y-3"
              buttonClassName={smallButton}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label htmlFor={`create-${kind}-anchor`} className="block text-sm font-semibold">
                    {copy.anchorLabel}
                  </label>
                  <AnchorSelect id={`create-${kind}-anchor`} value={null} />
                </div>
                {PHOTO_BLOCK_VARIANTS[kind].length > 1 ? (
                  <div className="space-y-1">
                    <label htmlFor={`create-${kind}-variant`} className="block text-sm font-semibold">
                      {copy.variantLabel}
                    </label>
                    <select id={`create-${kind}-variant`} name="variant" className={inputClass}>
                      {PHOTO_BLOCK_VARIANTS[kind].map((variant) => (
                        <option key={variant} value={variant}>
                          {copy.variants[variant]}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </div>
              {kind === "photo_text" ? <BlockTextFields id={`create-${kind}`} title={null} body={null} /> : null}
            </PhotoForm>
          </li>
        ))}
      </ul>
    </section>
  );
}
