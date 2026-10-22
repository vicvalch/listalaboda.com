import { memberPhotoResponse, notFoundResponse, readPhotoRequest } from "@/lib/wedding-site/photos/delivery";
import { readMemberPhoto } from "@/lib/wedding-site/photos/service";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * A photo for members (UX-01B, ADR-022 §4): the editor's thumbnails and the
 * member preview, published or not, hidden or not. The member's own session
 * reads the object under the bucket's policy; `private, no-store`. Anyone
 * else, and every failure, gets the same 404.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: RouteContext<"/app/weddings/[weddingId]/site/photos/[photoId]/[rendition]">,
) {
  const { weddingId, photoId, rendition } = await params;
  const target = readPhotoRequest(request.url, { photoId, rendition });
  if (!target) return notFoundResponse();
  const bytes = await readMemberPhoto(await createSupabaseServerClient(), weddingId, target.photoId, target.rendition);
  return bytes ? memberPhotoResponse(bytes) : notFoundResponse();
}
