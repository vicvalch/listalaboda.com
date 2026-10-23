import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Notice } from "@/components/ui/Notice";
import { cardClass, primaryButtonClass, textLinkClass } from "@/components/ui/styles";
import { WeddingSite } from "@/components/wedding-site/WeddingSite";
import { loginPath } from "@/lib/auth/redirect";
import { requireUser } from "@/lib/auth/session";
import { requireWeddingMembership } from "@/lib/authz/wedding";
import { getRequestOrigin } from "@/lib/http/origin";
import { getMessages, interpolate } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isWeddingSitePhotosEnabled } from "@/lib/wedding-site/photos/flag";
import { getPhotoEditor } from "@/lib/wedding-site/photos/service";
import { resolveWeddingSiteDesign } from "@/lib/wedding-site/design/resolve";
import { toPreviewSite, toThumbnailSite } from "@/lib/wedding-site/preview";
import { getWeddingSiteEditor } from "@/lib/wedding-site/service";
import { PUBLIC_SITE_BASE_PATH, publicSitePath, suggestSlug } from "@/lib/wedding-site/slug";
import { getWeddingDetail } from "@/lib/weddings/service";

import { ConfirmButton } from "../guests/ConfirmButton";
import { BackToWeddingLink } from "../BackToWeddingLink";
import { unpublishSiteAction } from "./actions";
import { PublishForm } from "./PublishForm";
import { SlugForm } from "./SlugForm";
import { ThemeSection } from "./ThemeSection";

export const metadata: Metadata = { title: getMessages().site.title };

/**
 * "Sitio web": the private editor of the wedding's public website, a
 * secondary area next to the checklist (which stays the wedding's home).
 * STUDIO-01: the site's hub. Composing the page (cover, text and photo
 * sections) happens in ListaLaBoda Studio (`./studio`), its one editor; this
 * page opens it and keeps the style and the publication (owner-only).
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
  const { done } = await searchParams;
  const copy = getMessages().site;
  const publication = editor?.publication ?? null;
  const isPublished = Boolean(publication?.publishedAt);
  // The address as people would type it, for this deployment's origin.
  const host = origin ? new URL(origin).host : "";
  const publicUrl = publication && origin ? `${origin}${publicSitePath(publication.slug)}` : null;

  const compose = copy.compose;
  const studio = copy.studio;

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
      {photosEnabled && photoEditor === null ? <Notice tone="error">{copy.photos.errors.failed}</Notice> : null}

      {/* ------------------------------------------------------ Studio */}
      {editor ? (
        <section
          className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm"
          aria-labelledby="site-studio-title"
          data-testid="site-studio-card"
        >
          <div className="grid gap-6 p-6 sm:p-8 md:grid-cols-[minmax(0,1fr)_minmax(0,16rem)] md:items-center">
            <div className="space-y-3">
              <h2 id="site-studio-title" className="font-serif text-3xl leading-tight">
                {studio.hubTitle}
              </h2>
              <p className="text-muted">{studio.hubBody}</p>
              <p>
                <Link href={`${selfPath}/studio`} className={primaryButtonClass} data-testid="open-studio">
                  {studio.open}
                </Link>
              </p>
            </div>
            {/* A real, scaled glimpse of the site in its theme (decorative). */}
            <div aria-hidden="true" inert className="pointer-events-none hidden h-56 overflow-hidden rounded-xl border border-border md:block">
              <div className="w-[200%] origin-top-left scale-50">
                <WeddingSite
                  site={toThumbnailSite(toPreviewSite(wedding, editor.sections, publication?.slug ?? ""))}
                  design={resolveWeddingSiteDesign(editor.design)}
                  element="div"
                />
              </div>
            </div>
          </div>
        </section>
      ) : null}

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
