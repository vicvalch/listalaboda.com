import "server-only";

import { createClient } from "@supabase/supabase-js";

import { parseRecorderSettings } from "@/lib/email/delivery-recorder";
import { getPublicEnv } from "@/lib/env/public";
import type { Database } from "@/lib/supabase/database.types";
import {
  isPhotoId,
  isPhotoRendition,
  photoObjectName,
  RENDITION_EDGE,
  type PhotoRendition,
} from "@/lib/wedding-site/photos/model";
import { isDeliverableWebp } from "@/lib/wedding-site/photos/webp";
import { isValidSlug } from "@/lib/wedding-site/slug";

/**
 * The photo origin (UX-01B, ADR-022 §4): the SIXTH sanctioned service-role use
 * (ADR-002 §6), separate from every other, and READ-ONLY.
 *
 * Authority: the publication gate itself. Guests have no session, and an anon
 * storage policy would let anyone holding the public anon key download
 * published photos straight from Supabase, bypassing the CDN and the monthly
 * meter, and exhaust the free egress the whole product shares. So the bucket
 * has no anon access and this module is the one reader of published photos.
 *
 * Exactly one operation, `fetchPublishedPhoto(slug, photoId, rendition)`:
 *   1. the fixed service_role-only RPC `claim_published_wedding_photo`, which
 *      returns the object name ONLY for a public photo (ready, alt text,
 *      visible block) of a PUBLISHED wedding at that slug and within the
 *      month's origin budget, which it meters;
 *   2. one download of exactly that object from the private bucket;
 *   3. delivery validation of the bytes (a clean, still WebP within the
 *      rendition's bound, no EXIF/XMP/ICC chunk).
 * It never writes objects or rows (other than the claim's meter), never
 * authorizes members, takes no wedding id or object path from input and
 * returns no client, URL or signer. Every refusal is the same null. The key is
 * read only here (and in the other named stores), never logged or returned.
 */

export type PhotoOrigin = Readonly<{
  fetchPublishedPhoto(slug: string, photoId: string, rendition: PhotoRendition): Promise<Uint8Array | null>;
}>;

type OriginSettings = Readonly<{ supabaseUrl: string; serviceRoleKey: string }>;

const BUCKET = "wedding-photos";

export function createPhotoOrigin({ supabaseUrl, serviceRoleKey }: OriginSettings): PhotoOrigin {
  const privileged = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  return {
    async fetchPublishedPhoto(slug, photoId, rendition) {
      if (!isValidSlug(slug) || !isPhotoId(photoId) || !isPhotoRendition(rendition)) return null;
      try {
        const { data: name, error } = await privileged.rpc("claim_published_wedding_photo", {
          site_slug: slug,
          target_photo_id: photoId,
          rendition,
        });
        // The claim can only name this photo's own rendition.
        if (error || name !== photoObjectName(photoId, rendition)) return null;

        const download = await privileged.storage.from(BUCKET).download(name);
        if (download.error || !download.data) return null;
        const bytes = new Uint8Array(await download.data.arrayBuffer());
        return isDeliverableWebp(bytes, RENDITION_EDGE[rendition]) ? bytes : null;
      } catch {
        return null;
      }
    },
  };
}

/** The origin from the server environment, or null when not configured (photos then 404). */
export function getPhotoOrigin(): PhotoOrigin | null {
  let supabaseUrl: string;
  try {
    supabaseUrl = getPublicEnv().supabaseUrl;
  } catch {
    return null;
  }
  const settings = parseRecorderSettings({
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    // ADR-022 §4, ADR-002 §6: a sanctioned read of this key (ESLint allows it in the named stores only).
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  return settings ? createPhotoOrigin(settings) : null;
}
