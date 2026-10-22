import { getPhotoOrigin } from "@/lib/wedding-site/photo-origin";
import { notFoundResponse, publicPhotoResponse, readPhotoRequest } from "@/lib/wedding-site/photos/delivery";
import { isWeddingSitePhotosEnabled } from "@/lib/wedding-site/photos/flag";

/**
 * A published wedding photo (UX-01B, ADR-022 §4): `/boda/<slug>/fotos/<id>/<1600|640>`.
 * No account, no cookies (excluded from the session proxy); the publication
 * gate is re-checked on every origin request by the read-only photo origin,
 * and Vercel's CDN serves repeat views. Flag off, a query string, an unknown,
 * unpublished, hidden, deleted or foreign photo, a spent monthly budget and
 * any error are all the same 404.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: RouteContext<"/boda/[slug]/fotos/[photoId]/[rendition]">) {
  if (!isWeddingSitePhotosEnabled()) return notFoundResponse();
  const { slug, photoId, rendition } = await params;
  const target = readPhotoRequest(request.url, { photoId, rendition });
  const origin = getPhotoOrigin();
  if (!target || !origin) return notFoundResponse();

  const bytes = await origin.fetchPublishedPhoto(slug, target.photoId, target.rendition);
  return bytes ? publicPhotoResponse(target.photoId, bytes) : notFoundResponse();
}
