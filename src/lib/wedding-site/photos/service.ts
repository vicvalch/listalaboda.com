import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { requireWeddingMembership, type WeddingAccess } from "@/lib/authz/wedding";
import type { Database } from "@/lib/supabase/database.types";
import type { EditorBlock, EditorPhoto, PhotoEditor } from "@/lib/wedding-site/photos/editor";
import { isWeddingSitePhotosEnabled } from "@/lib/wedding-site/photos/flag";
import {
  isPhotoId,
  isVariantOf,
  PHOTO_LIMITS,
  PHOTO_RENDITIONS,
  photoObjectName,
  RENDITION_EDGE,
  type PhotoBlockKind,
  type PhotoBlockVariant,
  type PhotoRendition,
} from "@/lib/wedding-site/photos/model";
import { processPhoto } from "@/lib/wedding-site/photos/process";
import { purgePhotoCache } from "@/lib/wedding-site/photos/purge";
import { isDeliverableWebp, sniffImageFormat } from "@/lib/wedding-site/photos/webp";
import type { SectionKind } from "@/lib/wedding-site/sections";

/**
 * Organizer side of wedding-site photos (UX-01B, ADR-022). Any member (owner
 * or collaborator) uploads, describes, places, orders, hides and deletes
 * photos, like the site's other content; publication stays owner-only and
 * unchanged.
 *
 * Every operation takes the caller's RLS-bound client and resolves membership
 * server-side first (`@/lib/authz/wedding`); a photo or block id from the
 * browser is only a lookup key, always scoped to the authorized wedding, and
 * the database re-checks every write (RLS, column grants, composite FKs,
 * triggers, quota functions). Storage objects are written, read and removed
 * with the MEMBER's session under the bucket's policies; the service role is
 * never used here. With the flag off everything is `disabled`.
 */

type Client = SupabaseClient<Database>;
type DbError = Readonly<{ code?: string; message?: string }>;

const BUCKET = "wedding-photos";

export type PhotoFailureReason =
  | "unauthenticated"
  | "not_found"
  | "disabled"
  | "invalid"
  | "unsupported"
  | "too_small"
  | "too_large"
  | "unprocessable"
  | "limit"
  | "busy"
  | "daily_limit"
  | "storage_limit"
  | "paused"
  | "block_full"
  | "block_limit"
  | "error";

export type PhotoResult<T = undefined> =
  | (T extends undefined ? Readonly<{ ok: true }> : Readonly<{ ok: true; value: T }>)
  | Readonly<{ ok: false; reason: PhotoFailureReason }>;

function fail(reason: PhotoFailureReason): Readonly<{ ok: false; reason: PhotoFailureReason }> {
  return { ok: false, reason };
}

/** Named database refusals → closed reasons. Exported for tests. */
export function photoFailure(error: DbError): PhotoFailureReason {
  switch (error.message) {
    case "not_authenticated":
      return "unauthenticated";
    case "wedding_not_found":
    case "wedding_photo_not_found":
      return "not_found";
    case "wedding_photo_limit":
      return "limit";
    case "wedding_photo_busy":
      return "busy";
    case "wedding_photo_daily_limit":
      return "daily_limit";
    case "wedding_photo_storage_limit":
      return "storage_limit";
    case "wedding_photos_paused":
      return "paused";
    case "wedding_photo_block_full":
      return "block_full";
    case "wedding_site_photo_block_limit":
      return "block_limit";
    case "wedding_photo_invalid":
    case "wedding_photo_incomplete":
      return "invalid";
  }
  if (error.code === "23514" || error.code === "23503" || error.code === "22P02") return "invalid";
  if (error.code === "23505") return "invalid";
  if (error.code === "42501") return "not_found";
  return "error";
}

type Authorized = Readonly<{ ok: true; access: WeddingAccess }> | Readonly<{ ok: false; reason: PhotoFailureReason }>;

async function authorize(supabase: Client, weddingId: string): Promise<Authorized> {
  if (!isWeddingSitePhotosEnabled()) return fail("disabled");
  const result = await requireWeddingMembership(supabase, weddingId);
  if (!result.ok) {
    if (result.reason === "unauthenticated") return fail("unauthenticated");
    if (result.reason === "not_found") return fail("not_found");
    return fail("error");
  }
  return { ok: true, access: result.access };
}

function objectNames(photoId: string): string[] {
  return PHOTO_RENDITIONS.map((rendition) => photoObjectName(photoId, rendition));
}

/** Removes a photo's objects with the member's session (the row must still exist: the policy derives the wedding from it). */
async function removeObjects(supabase: Client, photoIds: readonly string[]): Promise<boolean> {
  if (photoIds.length === 0) return true;
  try {
    const { error } = await supabase.storage.from(BUCKET).remove(photoIds.flatMap(objectNames));
    return !error;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ read

/** The editor's photos and blocks in two queries, after a membership check by the caller. Null on failure. */
export async function getPhotoEditor(supabase: Client, access: WeddingAccess): Promise<PhotoEditor | null> {
  try {
    const [photos, blocks] = await Promise.all([
      supabase
        .from("wedding_photos")
        .select("id, state, block_id, position, alt_text, caption, focal_x, focal_y, width, height, bytes, created_at")
        .eq("wedding_id", access.weddingId),
      supabase
        .from("wedding_site_photo_blocks")
        .select("id, kind, variant, anchor, position, is_visible, title, body")
        .eq("wedding_id", access.weddingId),
    ]);
    if (photos.error || !photos.data || blocks.error || !blocks.data) return null;
    return {
      photos: photos.data.map(
        (row): EditorPhoto => ({
          id: row.id,
          state: row.state,
          blockId: row.block_id,
          position: row.position,
          altText: row.alt_text,
          caption: row.caption,
          focalX: row.focal_x,
          focalY: row.focal_y,
          width: row.width,
          height: row.height,
          bytes: row.bytes,
          createdAt: row.created_at,
        }),
      ),
      blocks: blocks.data
        .filter((row) => isVariantOf(row.kind, row.variant))
        .map(
          (row): EditorBlock => ({
            id: row.id,
            kind: row.kind,
            variant: row.variant,
            anchor: row.anchor,
            position: row.position,
            isVisible: row.is_visible,
            title: row.title,
            body: row.body,
          }),
        ),
    };
  } catch {
    return null;
  }
}

/**
 * One rendition's bytes for the member preview (member session, storage
 * SELECT policy), validated like the public delivery. Null for anything else.
 */
export async function readMemberPhoto(
  supabase: Client,
  weddingId: string,
  photoId: string,
  rendition: PhotoRendition,
): Promise<Uint8Array | null> {
  const auth = await authorize(supabase, weddingId);
  if (!auth.ok || !isPhotoId(photoId)) return null;
  try {
    const { data: row, error } = await supabase
      .from("wedding_photos")
      .select("id")
      .eq("id", photoId)
      .eq("wedding_id", auth.access.weddingId)
      .eq("state", "ready")
      .maybeSingle();
    if (error || !row) return null;
    const download = await supabase.storage.from(BUCKET).download(photoObjectName(photoId, rendition));
    if (download.error || !download.data) return null;
    const bytes = new Uint8Array(await download.data.arrayBuffer());
    return isDeliverableWebp(bytes, RENDITION_EDGE[rendition]) ? bytes : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- upload

/**
 * One photo (ADR-022 §3, §13): authorize → cheap signature check → sweep this
 * wedding's stale pending uploads (objects first, member session) → reserve
 * (`create_wedding_photo`: quotas and breakers under the wedding lock) →
 * decode and re-encode both renditions → upload them with the member's
 * session → `complete_wedding_photo` (sizes read from storage). Any failure
 * after the reservation removes what was written, so a failed upload leaves
 * no object and no row behind (and a leftover is never served).
 */
export async function uploadWeddingPhoto(
  supabase: Client,
  weddingId: string,
  input: Uint8Array,
): Promise<PhotoResult<string>> {
  const auth = await authorize(supabase, weddingId);
  if (!auth.ok) return auth;
  if (input.byteLength === 0 || input.byteLength > PHOTO_LIMITS.requestBytes) return fail("too_large");
  if (!sniffImageFormat(input)) return fail("unsupported");

  const access = auth.access;
  await sweepStalePending(supabase, access.weddingId);

  const reserved = await supabase.rpc("create_wedding_photo", { target_wedding_id: access.weddingId });
  if (reserved.error || typeof reserved.data !== "string" || !isPhotoId(reserved.data)) {
    return fail(reserved.error ? photoFailure(reserved.error) : "error");
  }
  const photoId = reserved.data;

  const abandon = async (reason: PhotoFailureReason) => {
    await removeObjects(supabase, [photoId]);
    await supabase.from("wedding_photos").delete().eq("id", photoId).eq("wedding_id", access.weddingId);
    return fail(reason);
  };

  const processed = await processPhoto(input);
  if (!processed.ok) return abandon(processed.reason);

  for (const rendition of PHOTO_RENDITIONS) {
    const { data } = processed.renditions[rendition];
    try {
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(photoObjectName(photoId, rendition), data, { contentType: "image/webp", upsert: false });
      if (error) return abandon("error");
    } catch {
      return abandon("error");
    }
  }

  const large = processed.renditions["1600"];
  const completed = await supabase.rpc("complete_wedding_photo", {
    target_photo_id: photoId,
    rendition_width: large.width,
    rendition_height: large.height,
  });
  if (completed.error || completed.data !== true) {
    return abandon(completed.error ? photoFailure(completed.error) : "error");
  }
  return { ok: true, value: photoId };
}

/** Removes the objects of this wedding's pending uploads older than 15 minutes; the reservation then deletes their rows. */
async function sweepStalePending(supabase: Client, weddingId: string): Promise<void> {
  try {
    const before = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from("wedding_photos")
      .select("id")
      .eq("wedding_id", weddingId)
      .eq("state", "pending")
      .lte("created_at", before);
    if (data && data.length > 0) await removeObjects(supabase, data.map((row) => row.id));
  } catch {
    // Best effort: a leftover object without a row is never served (operator reconcile).
  }
}

// ----------------------------------------------------------------- edits

export type PhotoDetails = Readonly<{ altText: string | null; caption: string | null; focalX: number; focalY: number }>;

/** Description, caption and focal point. Clearing the description stops the photo being public, so it is purged. */
export async function updateWeddingPhoto(
  supabase: Client,
  weddingId: string,
  photoId: string,
  details: PhotoDetails,
): Promise<PhotoResult> {
  const auth = await authorize(supabase, weddingId);
  if (!auth.ok) return auth;
  if (!isPhotoId(photoId)) return fail("not_found");
  const { data, error } = await supabase
    .from("wedding_photos")
    .update({ alt_text: details.altText, caption: details.caption, focal_x: details.focalX, focal_y: details.focalY })
    .eq("id", photoId)
    .eq("wedding_id", auth.access.weddingId)
    .eq("state", "ready")
    .select("id");
  if (error) return fail(photoFailure(error));
  if (!data || data.length === 0) return fail("not_found");
  if (details.altText === null) purgePhotoCache([photoId]);
  return { ok: true };
}

/** Deletes a photo: its objects first (the policy needs the row), then the row; its cached copies are purged. */
export async function deleteWeddingPhoto(supabase: Client, weddingId: string, photoId: string): Promise<PhotoResult> {
  const auth = await authorize(supabase, weddingId);
  if (!auth.ok) return auth;
  if (!isPhotoId(photoId)) return fail("not_found");
  const { data: row, error: readError } = await supabase
    .from("wedding_photos")
    .select("id")
    .eq("id", photoId)
    .eq("wedding_id", auth.access.weddingId)
    .maybeSingle();
  if (readError) return fail("error");
  if (!row) return fail("not_found");

  if (!(await removeObjects(supabase, [photoId]))) return fail("error");
  const { error } = await supabase.from("wedding_photos").delete().eq("id", photoId).eq("wedding_id", auth.access.weddingId);
  purgePhotoCache([photoId]);
  if (error) return fail(photoFailure(error));
  return { ok: true };
}

/** Makes a ready photo the cover (the previous one returns to the library); both are purged. */
export async function setCoverPhoto(supabase: Client, weddingId: string, photoId: string): Promise<PhotoResult> {
  const auth = await authorize(supabase, weddingId);
  if (!auth.ok) return auth;
  if (!isPhotoId(photoId)) return fail("not_found");
  const { data, error } = await supabase.rpc("set_wedding_cover_photo", {
    target_wedding_id: auth.access.weddingId,
    target_photo_id: photoId,
  });
  if (error) return fail(photoFailure(error));
  // The previous cover left the site; the new one may have left a visible block for a hidden cover.
  purgePhotoCache(typeof data === "string" ? [data, photoId] : [photoId]);
  return { ok: true };
}

/** Takes a photo out of its block (back to the library); purged. */
export async function removePhotoFromBlock(supabase: Client, weddingId: string, photoId: string): Promise<PhotoResult> {
  const auth = await authorize(supabase, weddingId);
  if (!auth.ok) return auth;
  if (!isPhotoId(photoId)) return fail("not_found");
  const { data, error } = await supabase
    .from("wedding_photos")
    .update({ block_id: null })
    .eq("id", photoId)
    .eq("wedding_id", auth.access.weddingId)
    .select("id");
  if (error) return fail(photoFailure(error));
  if (!data || data.length === 0) return fail("not_found");
  purgePhotoCache([photoId]);
  return { ok: true };
}

/** Places a ready library photo (or one from another block) in a block; the database enforces room and same wedding. */
export async function addPhotoToBlock(
  supabase: Client,
  weddingId: string,
  photoId: string,
  blockId: string,
): Promise<PhotoResult> {
  const auth = await authorize(supabase, weddingId);
  if (!auth.ok) return auth;
  if (!isPhotoId(photoId) || !isPhotoId(blockId)) return fail("not_found");
  const { data, error } = await supabase
    .from("wedding_photos")
    .update({ block_id: blockId })
    .eq("id", photoId)
    .eq("wedding_id", auth.access.weddingId)
    .eq("state", "ready")
    .select("id");
  if (error) return fail(photoFailure(error));
  if (!data || data.length === 0) return fail("not_found");
  // It may have left a visible block for a hidden one.
  purgePhotoCache([photoId]);
  return { ok: true };
}

export type BlockInput = Readonly<{
  variant: PhotoBlockVariant;
  anchor: SectionKind | null;
  title: string | null;
  body: string | null;
}>;

/** A new gallery, carousel or photo-with-text block (hidden). The cover block is made by `setCoverPhoto`. */
export async function createPhotoBlock(
  supabase: Client,
  weddingId: string,
  kind: Exclude<PhotoBlockKind, "cover">,
  input: BlockInput,
): Promise<PhotoResult<string>> {
  const auth = await authorize(supabase, weddingId);
  if (!auth.ok) return auth;
  if (!isVariantOf(kind, input.variant)) return fail("invalid");
  const { data, error } = await supabase
    .from("wedding_site_photo_blocks")
    .insert({
      wedding_id: auth.access.weddingId,
      kind,
      variant: input.variant,
      anchor: input.anchor,
      title: kind === "photo_text" ? input.title : null,
      body: kind === "photo_text" ? input.body : null,
    })
    .select("id")
    .single();
  if (error || !data) return fail(error ? photoFailure(error) : "error");
  return { ok: true, value: data.id };
}

async function blockPhotoIds(supabase: Client, weddingId: string, blockId: string): Promise<string[]> {
  const { data } = await supabase
    .from("wedding_photos")
    .select("id")
    .eq("wedding_id", weddingId)
    .eq("block_id", blockId);
  return (data ?? []).map((row) => row.id);
}

/** A block's variant, slot, visibility and text (the cover: visibility only). Hiding purges its photos. */
export async function updatePhotoBlock(
  supabase: Client,
  weddingId: string,
  blockId: string,
  input: Readonly<{ isVisible: boolean }> & Partial<BlockInput>,
): Promise<PhotoResult> {
  const auth = await authorize(supabase, weddingId);
  if (!auth.ok) return auth;
  if (!isPhotoId(blockId)) return fail("not_found");
  const { data: current, error: readError } = await supabase
    .from("wedding_site_photo_blocks")
    .select("kind")
    .eq("id", blockId)
    .eq("wedding_id", auth.access.weddingId)
    .maybeSingle();
  if (readError) return fail("error");
  if (!current) return fail("not_found");

  const changes: Database["public"]["Tables"]["wedding_site_photo_blocks"]["Update"] = { is_visible: input.isVisible };
  if (current.kind !== "cover") {
    if (input.variant !== undefined) {
      if (!isVariantOf(current.kind, input.variant)) return fail("invalid");
      changes.variant = input.variant;
    }
    if (input.anchor !== undefined) changes.anchor = input.anchor;
    if (current.kind === "photo_text") {
      if (input.title !== undefined) changes.title = input.title;
      if (input.body !== undefined) changes.body = input.body;
    }
  }

  const { data, error } = await supabase
    .from("wedding_site_photo_blocks")
    .update(changes)
    .eq("id", blockId)
    .eq("wedding_id", auth.access.weddingId)
    .select("id");
  if (error) return fail(photoFailure(error));
  if (!data || data.length === 0) return fail("not_found");
  if (!input.isVisible) purgePhotoCache(await blockPhotoIds(supabase, auth.access.weddingId, blockId));
  return { ok: true };
}

/** Deletes a block; its photos return to the library (FK SET NULL) and are purged. */
export async function deletePhotoBlock(supabase: Client, weddingId: string, blockId: string): Promise<PhotoResult> {
  const auth = await authorize(supabase, weddingId);
  if (!auth.ok) return auth;
  if (!isPhotoId(blockId)) return fail("not_found");
  const photoIds = await blockPhotoIds(supabase, auth.access.weddingId, blockId);
  const { data, error } = await supabase
    .from("wedding_site_photo_blocks")
    .delete()
    .eq("id", blockId)
    .eq("wedding_id", auth.access.weddingId)
    .select("id");
  if (error) return fail(photoFailure(error));
  if (!data || data.length === 0) return fail("not_found");
  purgePhotoCache(photoIds);
  return { ok: true };
}

export type MoveDirection = "before" | "after";

/** "Mover antes / después" for a block (in its slot) or a photo (in its block). `false` = already first/last. */
export async function movePhotoItem(
  supabase: Client,
  weddingId: string,
  target: Readonly<{ kind: "block" | "photo"; id: string }>,
  direction: MoveDirection,
): Promise<PhotoResult<boolean>> {
  const auth = await authorize(supabase, weddingId);
  if (!auth.ok) return auth;
  if (!isPhotoId(target.id)) return fail("not_found");
  // Scope to the authorized wedding before the invoker function runs.
  const table = target.kind === "block" ? "wedding_site_photo_blocks" : "wedding_photos";
  const { data: row } = await supabase
    .from(table)
    .select("id")
    .eq("id", target.id)
    .eq("wedding_id", auth.access.weddingId)
    .maybeSingle();
  if (!row) return fail("not_found");
  const { data, error } =
    target.kind === "block"
      ? await supabase.rpc("move_wedding_site_photo_block", { target_block_id: target.id, direction })
      : await supabase.rpc("move_wedding_photo", { target_photo_id: target.id, direction });
  if (error) return fail(photoFailure(error));
  return { ok: true, value: data === true };
}

/** Every photo of a wedding: purged after unpublishing or a new address (old URLs must not keep serving). */
export async function purgeWeddingPhotos(supabase: Client, weddingId: string): Promise<void> {
  try {
    const { data } = await supabase.from("wedding_photos").select("id").eq("wedding_id", weddingId);
    purgePhotoCache((data ?? []).map((row) => row.id));
  } catch {
    // Best effort.
  }
}

/** One RPC, never a sequence of adjacent swaps. */
export async function reorderPhotoBlock(supabase: Client, weddingId: string, request: import("@/lib/wedding-site/studio-reorder").ReorderRequest): Promise<PhotoResult<readonly string[]>> {
  const auth = await authorize(supabase, weddingId);
  if (!auth.ok) return auth;
  if (!isPhotoId(request.blockId) || (request.beforeId !== null && !isPhotoId(request.beforeId)) ||
      !Array.isArray(request.order) || request.order.length > 12 || !request.order.every(isPhotoId)) return fail("invalid");
  const { data, error } = await supabase.rpc("reorder_wedding_site_photo_block", {
    target_wedding_id: auth.access.weddingId,
    target_block_id: request.blockId,
    expected_anchor: request.anchor ?? "top",
    expected_order: [...request.order],
    ...(request.beforeId === null ? {} : { before_block_id: request.beforeId }),
  });
  if (error || !data) return fail("error");
  return { ok: true, value: data };
}
