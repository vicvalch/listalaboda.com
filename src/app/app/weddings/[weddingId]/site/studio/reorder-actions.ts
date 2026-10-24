"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { requireWeddingMembership } from "@/lib/authz/wedding";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPhotoEditor, reorderPhotoBlock } from "@/lib/wedding-site/photos/service";
import type { PhotoEditor } from "@/lib/wedding-site/photos/editor";
import { SECTION_KINDS } from "@/lib/wedding-site/sections";
import type { ReorderRequest } from "@/lib/wedding-site/studio-reorder";

export type ReorderResult = Readonly<{ ok: boolean; editor: PhotoEditor | null }>;

/** Reconcile even a refused/ambiguous mutation. Never replay a failed request. */
export async function reorderBlockAction(weddingId: string, request: ReorderRequest): Promise<ReorderResult> {
  await requireUser(`/app/weddings/${encodeURIComponent(weddingId)}/site/studio`);
  const supabase = await createSupabaseServerClient();
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) return { ok: false, editor: null };
  let ok = false;
  try {
    if (request && (request.anchor === null || SECTION_KINDS.includes(request.anchor))) {
      ok = (await reorderPhotoBlock(supabase, weddingId, request)).ok;
    }
  } catch {
    // A lost RPC response can mean a committed move. Read, do not retry.
  }
  let editor: PhotoEditor | null = null;
  try { editor = await getPhotoEditor(supabase, access.access); } catch { /* Reload required. */ }
  revalidatePath(`/app/weddings/${encodeURIComponent(weddingId)}/site`, "layout");
  return { ok: ok && editor !== null, editor };
}
