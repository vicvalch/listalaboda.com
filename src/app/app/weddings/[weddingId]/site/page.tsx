import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Notice } from "@/components/ui/Notice";
import { cardClass, textLinkClass } from "@/components/ui/styles";
import { loginPath } from "@/lib/auth/redirect";
import { requireUser } from "@/lib/auth/session";
import { requireWeddingMembership } from "@/lib/authz/wedding";
import { getRequestOrigin } from "@/lib/http/origin";
import { getMessages, interpolate } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isWeddingSitePhotosEnabled } from "@/lib/wedding-site/photos/flag";
import { getPhotoEditor } from "@/lib/wedding-site/photos/service";
import { toPreviewSite } from "@/lib/wedding-site/preview";
import { getWeddingSiteEditor } from "@/lib/wedding-site/service";
import { PUBLIC_SITE_BASE_PATH, publicSitePath, suggestSlug } from "@/lib/wedding-site/slug";
import { formatWeddingDate } from "@/lib/weddings/format";
import { getWeddingDetail } from "@/lib/weddings/service";

import { ConfirmButton } from "../guests/ConfirmButton";
import { BackToWeddingLink } from "../BackToWeddingLink";
import { unpublishSiteAction } from "./actions";
import { CoverPhoto, SiteComposition } from "./SiteComposition";
import { PhotoAnnouncer } from "./photos/PhotoAnnouncer";
import { PublishForm } from "./PublishForm";
import { SlugForm } from "./SlugForm";
import { ThemeSection } from "./ThemeSection";

export const metadata: Metadata = { title: getMessages().site.title };

/**
 * "Sitio web": the private editor of the wedding's public website, a
 * secondary area next to the checklist (which stays the wedding's home).
 * UX-01D: one composition surface, top to bottom like the public page:
 * "Portada" (header data and cover photo), "Secciones del sitio" (text and
 * photo sections together, in public order, with "Agregar sección aquí"),
 * the style, then preview and publication.
 * Any member edits the sections and chooses and customizes the theme ("Estilo del sitio",
 * ADR-019); only owners see the address and publication controls, which the service and database also enforce.
 * Membership is checked server-side first; a non-member, a nonexistent
 * wedding and a malformed id all get the same 404. Opening this page never
 * writes anything.
 */
export default async function WeddingSitePage({
  params,
  searchParams,
}: PageProps<"/app/weddings/[weddingId]/site">) {
  const { weddingId } = await params;
  const selfPath = `/app/weddings/${encodeURIComponent(weddingId)}/site`;
  await requireUser(selfPath);

  const supabase = await createSupabaseServerClient();
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) {
    if (access.reason === "unauthenticated") redirect(loginPath(selfPath));
    notFound();
  }

  const photosEnabled = isWeddingSitePhotosEnabled();
  const [wedding, editor, origin, photoEditor] = await Promise.all([
    getWeddingDetail(supabase, access.access.weddingId),
    getWeddingSiteEditor(supabase, access.access),
    getRequestOrigin(),
    photosEnabled ? getPhotoEditor(supabase, access.access) : Promise.resolve(null),
  ]);
  if (!wedding) notFound();

  const isOwner = access.access.role === "owner";
  const { done, nueva, error } = await searchParams;
  const copy = getMessages().site;
  const publication = editor?.publication ?? null;
  const isPublished = Boolean(publication?.publishedAt);
  // The address as people would type it, for this deployment's origin.
  const host = origin ? new URL(origin).host : "";
  const publicUrl = publication && origin ? `${origin}${publicSitePath(publication.slug)}` : null;

  const compose = copy.compose;
  // A block just created from "Agregar sección aquí": only one of this wedding's own blocks counts.
  const newBlockId = photoEditor && typeof nueva === "string" && photoEditor.blocks.some((block) => block.id === nueva) ? nueva : null;
  const insertError = typeof error === "string" ? insertErrorMessage(error) : null;

  return (
    <div className="space-y-8">
      {done === "published" ? <Notice tone="success">{copy.publish.done}</Notice> : null}
      {done === "unpublished" ? <Notice tone="success">{copy.unpublish.done}</Notice> : null}

      <header className="space-y-3">
        <p className="text-muted text-sm font-semibold break-words">{wedding.name}</p>
        <h1 className="text-3xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="text-muted">{copy.intro}</p>
        {editor ? (
          <p className="text-sm" data-testid="site-status-line">
            {interpolate(compose.statusLine, { status: isPublished ? copy.status.published : copy.status.unpublished })}
            {" · "}
            <a href="#publicar" className={textLinkClass}>
              {compose.publishLink}
            </a>
          </p>
        ) : null}
        <p className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <BackToWeddingLink weddingId={wedding.id} className={textLinkClass} />
          <Link href={`${selfPath}/preview`} className={textLinkClass}>
            {compose.previewLink}
          </Link>
          {photoEditor ? (
            <Link href={`${selfPath}/photos`} className={textLinkClass} data-testid="photo-library-link">
              {compose.libraryLink}
            </Link>
          ) : null}
        </p>
      </header>

      {editor === null ? <Notice tone="error">{copy.loadFailed}</Notice> : null}
      {insertError ? <Notice tone="error">{insertError}</Notice> : null}
      {photosEnabled && photoEditor === null ? <Notice tone="error">{copy.photos.errors.failed}</Notice> : null}

      <PhotoAnnouncer>
        {/* ---------------------------------------------------- Portada */}
        <section className={`${cardClass} space-y-4`} aria-labelledby="site-header-title" data-testid="site-cover-card">
          <header className="space-y-1">
            <h2 id="site-header-title" className="text-2xl font-semibold tracking-tight">
              {compose.cover.title}
            </h2>
            <p className="text-muted">{compose.cover.intro}</p>
          </header>
          <dl className="flex flex-wrap gap-x-8 gap-y-2">
            <div>
              <dt className="text-muted text-sm">{getMessages().weddingSettings.nameLabel}</dt>
              <dd className="font-semibold break-words">{wedding.name}</dd>
            </div>
            <div>
              <dt className="text-muted text-sm">{getMessages().wedding.dateLabel}</dt>
              <dd className="font-semibold">
                {wedding.weddingDate ? formatWeddingDate(wedding.weddingDate) : copy.header.noDate}
              </dd>
            </div>
            <div>
              <dt className="text-muted text-sm">{getMessages().wedding.cityLabel}</dt>
              <dd className="font-semibold break-words">{wedding.city ?? copy.header.noCity}</dd>
            </div>
          </dl>
          {isOwner ? (
            <p className="text-sm">
              <Link href={`/app/weddings/${wedding.id}/settings`} className={textLinkClass}>
                {copy.header.ownerLink}
              </Link>
            </p>
          ) : (
            <p className="text-muted text-sm">{copy.header.collaboratorNote}</p>
          )}
          {photoEditor ? <CoverPhoto weddingId={wedding.id} editor={photoEditor} /> : null}
        </section>

        {/* ------------------------------------------ Secciones del sitio */}
        {editor ? (
          <section id="secciones" className="scroll-mt-24 space-y-4" aria-labelledby="site-sections-title">
            <header className="space-y-1">
              <h2 id="site-sections-title" className="text-2xl font-semibold tracking-tight">
                {compose.title}
              </h2>
              <p className="text-muted">{photoEditor ? compose.intro : compose.introNoPhotos}</p>
              <p className="text-muted text-sm">{compose.legend}</p>
              {photoEditor ? <p className="text-muted text-sm">{compose.altRule}</p> : null}
              {isPublished ? (
                <p className="text-sm font-semibold" data-testid="site-live-edits">
                  {copy.status.publishedNote}
                </p>
              ) : null}
            </header>
            <SiteComposition weddingId={wedding.id} sections={editor.sections} photos={photoEditor} newBlockId={newBlockId} />
          </section>
        ) : null}
      </PhotoAnnouncer>

      {editor ? (
        <ThemeSection
          weddingId={wedding.id}
          site={toPreviewSite(wedding, editor.sections, publication?.slug ?? "")}
          design={editor.design}
          isPublished={isPublished}
        />
      ) : null}

      {/* ------------------------------------- Vista previa y publicación */}
      {editor ? (
        <section id="publicar" className={`${cardClass} scroll-mt-24 space-y-5`} aria-labelledby="site-status-title">
          <header className="space-y-2">
            <h2 id="site-status-title" className="text-xl font-semibold">
              {copy.status.title}
            </h2>
            <p data-testid="site-status">
              <span className="text-muted">{copy.status.label} </span>
              <span className="font-semibold">
                {isPublished ? copy.status.published : copy.status.unpublished}
              </span>
            </p>
            <p className="text-muted text-sm">
              {isPublished ? copy.status.publishedNote : copy.status.unpublishedNote}
            </p>
            <p className="text-sm">
              <Link href={`${selfPath}/preview`} className={textLinkClass}>
                {compose.previewLink}
              </Link>
            </p>
            {photoEditor ? <p className="text-muted text-sm">{copy.photos.disclosure}</p> : null}
          </header>

          {/* The address: owners always see the chosen one; collaborators
              only once the site is published. */}
          {publicUrl && publication && (isPublished || isOwner) ? (
            <div className="space-y-1">
              <p className="text-muted text-sm">{copy.status.addressLabel}</p>
              <p className="font-semibold break-all" data-testid="site-public-url">
                {publicUrl}
              </p>
              {isPublished ? (
                <p className="pt-1">
                  <a
                    href={publicSitePath(publication.slug)}
                    target="_blank"
                    rel="noopener"
                    className={textLinkClass}
                  >
                    {copy.status.open}
                  </a>
                </p>
              ) : null}
            </div>
          ) : null}
          {isPublished ? <p className="text-muted text-sm">{copy.status.noIndex}</p> : null}

          {isOwner ? (
            <div className="space-y-5 border-t border-border pt-5">
              <SlugForm
                weddingId={wedding.id}
                currentSlug={publication?.slug ?? null}
                suggestion={publication ? "" : suggestSlug(wedding.name)}
                isPublished={isPublished}
                prefix={`${host}${PUBLIC_SITE_BASE_PATH}/`}
              />
              <div className="border-t border-border pt-5">
                {isPublished ? (
                  <ConfirmButton
                    action={unpublishSiteAction}
                    hidden={{ weddingId: wedding.id }}
                    id="unpublish-site"
                    openLabel={copy.unpublish.open}
                    confirmTitle={copy.unpublish.confirmTitle}
                    confirmBody={[copy.unpublish.confirmBody]}
                    confirmLabel={copy.unpublish.confirmButton}
                    cancelLabel={copy.unpublish.cancel}
                  />
                ) : (
                  <PublishForm weddingId={wedding.id} />
                )}
              </div>
            </div>
          ) : (
            <Notice tone="info">{copy.status.collaboratorNote}</Notice>
          )}
        </section>
      ) : null}
    </div>
  );
}

/** The closed `?error=` of "Agregar sección aquí" (anything else shows nothing). */
function insertErrorMessage(code: string): string | null {
  const errors = getMessages().site.photos.errors;
  switch (code) {
    case "block_limit":
      return errors.blockLimit;
    case "invalid":
      return errors.invalid;
    case "not_found":
      return errors.notFound;
    case "error":
      return errors.failed;
    default:
      return null;
  }
}
