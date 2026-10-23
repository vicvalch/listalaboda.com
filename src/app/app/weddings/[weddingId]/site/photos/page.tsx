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
import { libraryPhotos, photoCount, type EditorPhoto, type PhotoEditor } from "@/lib/wedding-site/photos/editor";
import { isWeddingSitePhotosEnabled } from "@/lib/wedding-site/photos/flag";
import { PHOTO_LIMITS } from "@/lib/wedding-site/photos/model";
import { getPhotoEditor } from "@/lib/wedding-site/photos/service";
import { getWeddingDetail } from "@/lib/weddings/service";

import { ConfirmButton } from "../../guests/ConfirmButton";
import { Disclosure } from "../Disclosure";
import { deletePhotoAction, savePhotoAction } from "./actions";
import { blockName, Thumbnail } from "./controls";
import { PhotoAnnouncer } from "./PhotoAnnouncer";
import { PhotoForm } from "./PhotoForm";
import { PhotoUploader } from "./PhotoUploader";

export const metadata: Metadata = {
  title: getMessages().site.photos.title,
  robots: { index: false, follow: false },
};

/**
 * "Biblioteca de fotos" (UX-01B, ADR-022; reframed in UX-01D): the wedding's
 * photo files, for any member (owner or collaborator): upload, describe
 * (alt text, caption, focal point) and delete. Putting photos on the site
 * (cover, galleries, carousels, photo with text) happens in Studio
 * (STUDIO-01), never here. Membership is checked server-side
 * first; a non-member, a nonexistent wedding, a malformed id and the flag
 * being off all get the same 404. Reading never writes.
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
          <Link href={`${sitePath}/studio`} className={textLinkClass}>
            {getMessages().site.studio.open}
          </Link>
          <Link href={`${sitePath}/preview`} className={textLinkClass}>
            {copy.previewLink}
          </Link>
        </p>
      </header>

      {editor === null ? (
        <Notice tone="error">{getMessages().site.loadFailed}</Notice>
      ) : (
        <PhotoAnnouncer>
          <PhotoLibrary weddingId={wedding.id} editor={editor} />
        </PhotoAnnouncer>
      )}
    </div>
  );
}

function PhotoLibrary({ weddingId, editor }: { weddingId: string; editor: PhotoEditor }) {
  const copy = getMessages().site.photos;
  const count = photoCount(editor);
  const library = libraryPhotos(editor);
  return (
    <>
      <section id="subir" className={`${cardClass} scroll-mt-24 space-y-4`} aria-labelledby="photos-upload-title">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="photos-upload-title" className="text-xl font-semibold">
            {copy.upload.title}
          </h2>
          <p className="text-sm font-semibold" data-testid="photo-count">
            {interpolate(copy.count, { count: String(count), max: String(PHOTO_LIMITS.photosPerWedding) })}
          </p>
        </header>
        <PhotoUploader weddingId={weddingId} remaining={Math.max(0, PHOTO_LIMITS.photosPerWedding - count)} />
        <div className="text-muted space-y-1 text-sm">
          <p>{copy.disclosure}</p>
          <p>{copy.rights}</p>
          <p>{copy.metadataNote}</p>
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="photos-library-title" data-testid="photos-library">
        <header className="space-y-1">
          <h2 id="photos-library-title" className="text-2xl font-semibold tracking-tight">
            {copy.library.title}
          </h2>
          <p className="text-muted text-sm">{getMessages().site.compose.altRule}</p>
        </header>
        {library.length === 0 ? <p className="text-muted">{copy.library.empty}</p> : null}
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {library.map((photo, index) => (
            <li key={photo.id} className="space-y-3 rounded-2xl border border-border bg-surface p-3 shadow-sm" data-testid="library-photo">
              <LibraryPhoto weddingId={weddingId} editor={editor} photo={photo} index={index} />
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function LibraryPhoto({
  weddingId,
  editor,
  photo,
  index,
}: {
  weddingId: string;
  editor: PhotoEditor;
  photo: EditorPhoto;
  index: number;
}) {
  const copy = getMessages().site.photos;
  const placedIn = photo.blockId ? editor.blocks.find((block) => block.id === photo.blockId) : null;
  const id = `photo-${index}`;
  const position = String(index + 1);
  return (
    <>
      <Thumbnail weddingId={weddingId} photo={photo} />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">{interpolate(copy.library.photoName, { position })}</p>
        {photo.altText ? null : (
          <p className="rounded-full border border-dashed border-border px-2.5 py-0.5 text-xs font-semibold" data-testid="photo-missing-alt">
            {copy.library.missingAltShort}
          </p>
        )}
      </div>
      <p className="text-muted text-sm">
        {placedIn ? (
          <Link
            href={`/app/weddings/${encodeURIComponent(weddingId)}/site/studio`}
            className={textLinkClass}
          >
            {interpolate(copy.library.placedIn, { place: blockName(placedIn, editor) })}
          </Link>
        ) : (
          copy.library.notPlaced
        )}
      </p>
      {/* Open while the description is missing: it is what the photo needs next. */}
      <Disclosure
        summary={copy.library.edit}
        summaryLabel={interpolate(copy.library.editLabel, { position })}
        defaultOpen={!photo.altText}
      >
        <PhotoForm
          action={savePhotoAction}
          hidden={{ weddingId, photoId: photo.id }}
          submitLabel={copy.library.save}
          pendingLabel={copy.library.saving}
          className="space-y-3"
        >
          {photo.altText ? null : <p className="text-sm">{copy.library.missingAlt}</p>}
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
        <div className="mt-4 border-t border-border pt-4">
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
        </div>
      </Disclosure>
    </>
  );
}
