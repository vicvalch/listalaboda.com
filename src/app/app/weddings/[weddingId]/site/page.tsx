import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Notice } from "@/components/ui/Notice";
import { cardClass, textLinkClass } from "@/components/ui/styles";
import { loginPath } from "@/lib/auth/redirect";
import { requireUser } from "@/lib/auth/session";
import { requireWeddingMembership } from "@/lib/authz/wedding";
import { getRequestOrigin } from "@/lib/http/origin";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getWeddingSiteEditor } from "@/lib/wedding-site/service";
import { PUBLIC_SITE_BASE_PATH, publicSitePath, suggestSlug } from "@/lib/wedding-site/slug";
import { formatWeddingDate } from "@/lib/weddings/format";
import { getWeddingDetail } from "@/lib/weddings/service";

import { ConfirmButton } from "../guests/ConfirmButton";
import { unpublishSiteAction } from "./actions";
import { PublishForm } from "./PublishForm";
import { SectionForm } from "./SectionForm";
import { SlugForm } from "./SlugForm";

export const metadata: Metadata = { title: getMessages().site.title };

/**
 * "Sitio web": the private editor of the wedding's public website, a
 * secondary area next to the checklist (which stays the wedding's home).
 * Any member edits the sections; only owners see the address and
 * publication controls, which the service and database also enforce.
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

  const [wedding, editor, origin] = await Promise.all([
    getWeddingDetail(supabase, access.access.weddingId),
    getWeddingSiteEditor(supabase, access.access),
    getRequestOrigin(),
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

  return (
    <div className="space-y-8">
      {done === "published" ? <Notice tone="success">{copy.publish.done}</Notice> : null}
      {done === "unpublished" ? <Notice tone="success">{copy.unpublish.done}</Notice> : null}

      <header className="space-y-3">
        <p className="text-muted text-sm font-semibold break-words">{wedding.name}</p>
        <h1 className="text-3xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="text-muted">{copy.intro}</p>
        <p>
          <Link href={`/app/weddings/${wedding.id}`} className={`${textLinkClass} text-sm`}>
            {copy.backToChecklist}
          </Link>
        </p>
      </header>

      {editor === null ? <Notice tone="error">{copy.loadFailed}</Notice> : null}

      {editor ? (
        <section className={`${cardClass} space-y-5`} aria-labelledby="site-status-title">
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

      <section className="space-y-3" aria-labelledby="site-header-title">
        <h2 id="site-header-title" className="text-2xl font-semibold tracking-tight">
          {copy.header.title}
        </h2>
        <p className="text-muted">{copy.header.body}</p>
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
      </section>

      {editor ? (
        <section className="space-y-4" aria-labelledby="site-sections-title">
          <header className="space-y-1">
            <h2 id="site-sections-title" className="text-2xl font-semibold tracking-tight">
              {copy.sections.title}
            </h2>
            <p className="text-muted">{copy.sections.intro}</p>
            {isPublished ? (
              <p className="text-sm font-semibold" data-testid="site-live-edits">
                {copy.status.publishedNote}
              </p>
            ) : null}
          </header>
          <ul className="space-y-4">
            {editor.sections.map((section) => (
              <li key={section.kind}>
                <SectionForm weddingId={wedding.id} section={section} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
