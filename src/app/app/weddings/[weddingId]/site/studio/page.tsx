import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { Notice } from "@/components/ui/Notice";
import { loginPath } from "@/lib/auth/redirect";
import { requireUser } from "@/lib/auth/session";
import { requireWeddingMembership } from "@/lib/authz/wedding";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isWeddingSitePhotosEnabled } from "@/lib/wedding-site/photos/flag";
import { getPhotoEditor } from "@/lib/wedding-site/photos/service";
import { getWeddingSiteEditor } from "@/lib/wedding-site/service";
import { getWeddingDetail } from "@/lib/weddings/service";

import { Studio } from "./Studio";

export const metadata: Metadata = {
  title: getMessages().site.studio.metaTitle,
  robots: { index: false, follow: false },
};

/**
 * ListaLaBoda Studio (STUDIO-01): the visual editor of the wedding's site,
 * for any member (owner or collaborator). Membership is checked server-side
 * first; a non-member, a nonexistent wedding and a malformed id all get the
 * same 404. The data is what the member already reads through RLS (the same
 * reads as the site page and the member preview); opening it never writes.
 * Publishing stays on the site page, owner-only.
 */
export default async function WeddingSiteStudioPage({ params }: PageProps<"/app/weddings/[weddingId]/site/studio">) {
  const { weddingId } = await params;
  const selfPath = `/app/weddings/${encodeURIComponent(weddingId)}/site/studio`;
  await requireUser(selfPath);

  const supabase = await createSupabaseServerClient();
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) {
    if (access.reason === "unauthenticated") redirect(loginPath(selfPath));
    notFound();
  }

  const photosEnabled = isWeddingSitePhotosEnabled();
  const [wedding, editor, photos] = await Promise.all([
    getWeddingDetail(supabase, access.access.weddingId),
    getWeddingSiteEditor(supabase, access.access),
    photosEnabled ? getPhotoEditor(supabase, access.access) : Promise.resolve(null),
  ]);
  if (!wedding) notFound();
  if (!editor) return <Notice tone="error">{getMessages().site.loadFailed}</Notice>;

  return (
    <Studio
      data={{
        weddingId: wedding.id,
        header: { name: wedding.name, weddingDate: wedding.weddingDate, city: wedding.city },
        slug: editor.publication?.slug ?? "",
        isPublished: Boolean(editor.publication?.publishedAt),
        isOwner: access.access.role === "owner",
        sections: editor.sections,
        design: editor.design,
        photos,
      }}
    />
  );
}
