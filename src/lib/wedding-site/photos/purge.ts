import "server-only";

import { revalidateTag } from "next/cache";

import { isPhotoId, photoCacheTag } from "@/lib/wedding-site/photos/model";

/**
 * Removes photos' public renditions from Vercel's CDN (ADR-022 §7, §13.6):
 * delete semantics (`expire: 0`), so the next request reaches the origin,
 * which re-checks the publication gate. Called after a write that stops a
 * photo being public (hide, remove from a block, delete, unpublish, a new
 * address). Best effort: a failed purge never fails the write, and browsers
 * may keep a copy for up to 10 minutes (stated in the editor).
 */
export function purgePhotoCache(photoIds: Iterable<string>): void {
  for (const id of new Set(photoIds)) {
    if (!isPhotoId(id)) continue;
    try {
      revalidateTag(photoCacheTag(id), { expire: 0 });
    } catch {
      // Outside a request scope (tests, scripts): nothing cached to purge.
    }
  }
}
