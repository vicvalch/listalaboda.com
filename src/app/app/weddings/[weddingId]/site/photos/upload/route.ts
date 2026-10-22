import { revalidatePath } from "next/cache";

import { PHOTO_LIMITS } from "@/lib/wedding-site/photos/model";
import { uploadWeddingPhoto } from "@/lib/wedding-site/photos/service";
import { isAcceptableUploadLength, isSameOriginUpload } from "@/lib/wedding-site/photos/upload-request";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * "Subir fotos" (UX-01B, ADR-022 §3, §13.1): one photo per POST, multipart
 * field `photo`, sent by the editor with upload progress. Same-origin only;
 * the member's session, membership, the flag and every quota are checked by
 * the service and the database. The answer is a closed JSON result (never a
 * path, bucket or provider message) and is never cached.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };

function answer(body: Readonly<Record<string, unknown>>, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function POST(request: Request, { params }: RouteContext<"/app/weddings/[weddingId]/site/photos/upload">) {
  if (!isSameOriginUpload(request.headers)) return answer({ ok: false, reason: "invalid" }, 403);
  if (!isAcceptableUploadLength(request.headers)) return answer({ ok: false, reason: "too_large" }, 413);

  const { weddingId } = await params;
  let file: File | null = null;
  try {
    const form = await request.formData();
    const value = form.get("photo");
    file = value instanceof File ? value : null;
  } catch {
    file = null;
  }
  if (!file || file.size === 0) return answer({ ok: false, reason: "invalid" }, 400);
  if (file.size > PHOTO_LIMITS.requestBytes) return answer({ ok: false, reason: "too_large" }, 413);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await uploadWeddingPhoto(await createSupabaseServerClient(), weddingId, bytes);
  if (!result.ok) {
    const status = result.reason === "unauthenticated" ? 401 : result.reason === "not_found" || result.reason === "disabled" ? 404 : 200;
    return answer({ ok: false, reason: result.reason }, status);
  }
  revalidatePath(`/app/weddings/${encodeURIComponent(weddingId)}/site`, "layout");
  return answer({ ok: true });
}
