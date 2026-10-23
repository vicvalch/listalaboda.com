"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { formText, type FormState } from "@/lib/forms/result";
import { getMessages, interpolate } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireWeddingMembership } from "@/lib/authz/wedding";
import {
  orderedBlocks,
  parseAltText,
  parseAnchor,
  parseBlockBody,
  parseBlockTitle,
  parseCaption,
  parseFocal,
  parseVariant,
  photosIn,
  type TextResult,
} from "@/lib/wedding-site/photos/editor";
import { isPhotoBlockKind, PHOTO_BLOCK_VARIANTS, type PhotoBlockKind } from "@/lib/wedding-site/photos/model";
import {
  addPhotoToBlock,
  createPhotoBlock,
  deletePhotoBlock,
  deleteWeddingPhoto,
  getPhotoEditor,
  movePhotoItem,
  removePhotoFromBlock,
  setCoverPhoto,
  updatePhotoBlock,
  updateWeddingPhoto,
  type PhotoFailureReason,
} from "@/lib/wedding-site/photos/service";

/**
 * Wedding-site photo edits (UX-01B, ADR-022) for any member. Forms carry only
 * lookup keys (wedding, photo or block id) and typed values; the caller and
 * their membership are derived on the server by the service, and the
 * database re-checks every write. Messages are catalog strings only.
 */

export type PhotoFormState = FormState<never, { message: string; nonce: string }> | null;
export type PhotoConfirmState = FormState<never> | null;

function photosPath(weddingId: string): string {
  return `/app/weddings/${encodeURIComponent(weddingId)}/site/photos`;
}

function refresh(weddingId: string): void {
  // The site page's summary card and the preview read the same rows.
  revalidatePath(`/app/weddings/${encodeURIComponent(weddingId)}/site`, "layout");
}

/** The Spanish message for a closed failure. */
export async function photoErrorMessage(reason: PhotoFailureReason): Promise<string> {
  const errors = getMessages().site.photos.errors;
  switch (reason) {
    case "unsupported":
      return errors.unsupported;
    case "too_small":
      return errors.tooSmall;
    case "too_large":
      return errors.tooLarge;
    case "limit":
      return errors.limit;
    case "busy":
      return errors.busy;
    case "daily_limit":
      return errors.dailyLimit;
    case "storage_limit":
      return errors.storageLimit;
    case "paused":
      return errors.paused;
    case "block_full":
      return errors.blockFull;
    case "block_limit":
      return errors.blockLimit;
    case "invalid":
      return errors.invalid;
    case "not_found":
      return errors.notFound;
    case "disabled":
      return errors.disabled;
    case "unprocessable":
    case "unauthenticated":
    case "error":
      return errors.failed;
  }
}

async function failure(weddingId: string, reason: PhotoFailureReason): Promise<{ ok: false; formError: string }> {
  if (reason === "unauthenticated") await requireUser(photosPath(weddingId));
  if (reason === "disabled") notFound();
  return { ok: false, formError: await photoErrorMessage(reason) };
}

function done(message: string): PhotoFormState {
  return { ok: true, data: { message, nonce: crypto.randomUUID() } };
}

function textError(result: TextResult, tooLong: string): string | null {
  if (result.ok) return null;
  return result.error === "too_long" ? tooLong : getMessages().site.photos.errors.textInvalid;
}

// ---------------------------------------------------------------- photos

export async function savePhotoAction(_prev: PhotoFormState, formData: FormData): Promise<PhotoFormState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(photosPath(weddingId));
  const copy = getMessages().site.photos;

  const alt = parseAltText(formText(formData, "altText"));
  const caption = parseCaption(formText(formData, "caption"));
  const altError = textError(alt, copy.errors.altTooLong);
  const captionError = textError(caption, copy.errors.captionTooLong);
  if (altError || captionError || !alt.ok || !caption.ok) {
    return { ok: false, formError: altError ?? captionError ?? copy.errors.invalid };
  }
  const focalX = parseFocal(formText(formData, "focalX"));
  const focalY = parseFocal(formText(formData, "focalY"));
  if (focalX === null || focalY === null) return { ok: false, formError: copy.errors.focalInvalid };

  const result = await updateWeddingPhoto(await createSupabaseServerClient(), weddingId, formText(formData, "photoId"), {
    altText: alt.value,
    caption: caption.value,
    focalX,
    focalY,
  });
  if (!result.ok) return failure(weddingId, result.reason);
  refresh(weddingId);
  return done(copy.library.saved);
}

export async function setCoverAction(_prev: PhotoFormState, formData: FormData): Promise<PhotoFormState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(photosPath(weddingId));
  const result = await setCoverPhoto(await createSupabaseServerClient(), weddingId, formText(formData, "photoId"));
  if (!result.ok) return failure(weddingId, result.reason);
  refresh(weddingId);
  return done(getMessages().site.photos.library.coverSet);
}

export async function addToBlockAction(_prev: PhotoFormState, formData: FormData): Promise<PhotoFormState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(photosPath(weddingId));
  const result = await addPhotoToBlock(
    await createSupabaseServerClient(),
    weddingId,
    formText(formData, "photoId"),
    formText(formData, "blockId"),
  );
  if (!result.ok) return failure(weddingId, result.reason);
  refresh(weddingId);
  return done(getMessages().site.photos.library.added);
}

export async function removeFromBlockAction(_prev: PhotoFormState, formData: FormData): Promise<PhotoFormState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(photosPath(weddingId));
  const result = await removePhotoFromBlock(await createSupabaseServerClient(), weddingId, formText(formData, "photoId"));
  if (!result.ok) return failure(weddingId, result.reason);
  refresh(weddingId);
  return done(getMessages().site.photos.library.removedFromBlock);
}

/** "Quitar portada" (two-step confirmation): the photo returns to the library. */
export async function removeCoverAction(_prev: PhotoConfirmState, formData: FormData): Promise<PhotoConfirmState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(photosPath(weddingId));
  const result = await removePhotoFromBlock(await createSupabaseServerClient(), weddingId, formText(formData, "photoId"));
  if (!result.ok) return failure(weddingId, result.reason);
  refresh(weddingId);
  return { ok: true, data: undefined };
}

/** "Eliminar foto" (two-step confirmation): objects and row, then the CDN purge. */
export async function deletePhotoAction(_prev: PhotoConfirmState, formData: FormData): Promise<PhotoConfirmState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(photosPath(weddingId));
  const result = await deleteWeddingPhoto(await createSupabaseServerClient(), weddingId, formText(formData, "photoId"));
  if (!result.ok) return failure(weddingId, result.reason);
  refresh(weddingId);
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------- blocks

type BlockFields =
  | Readonly<{ ok: true; variant: string; anchor: ReturnType<typeof parseAnchor>; title: string | null; body: string | null }>
  | Readonly<{ ok: false; formError: string }>;

function readBlockFields(formData: FormData, kind: PhotoBlockKind): BlockFields {
  const copy = getMessages().site.photos;
  const title = kind === "photo_text" ? parseBlockTitle(formText(formData, "title")) : ({ ok: true, value: null } as const);
  const body = kind === "photo_text" ? parseBlockBody(formText(formData, "body")) : ({ ok: true, value: null } as const);
  const error = textError(title, copy.errors.titleTooLong) ?? textError(body, copy.errors.bodyTooLong);
  if (error || !title.ok || !body.ok) return { ok: false, formError: error ?? copy.errors.invalid };
  return {
    ok: true,
    variant: formText(formData, "variant"),
    anchor: parseAnchor(formText(formData, "anchor")),
    title: title.value,
    body: body.value,
  };
}

/** Closed reasons the site editor may show after "Agregar sección aquí" (`?error=`). */
export type InsertFailure = "block_limit" | "invalid" | "not_found" | "error";

function sitePath(weddingId: string): string {
  return `/app/weddings/${encodeURIComponent(weddingId)}/site`;
}

/**
 * "Agregar sección aquí" (UX-01D): a gallery, carousel or photo with text at
 * one slot of the site editor. The form names only the kind and the slot's
 * anchor; the block starts hidden with the kind's default design and, since
 * the database appends new blocks, lands at the end of that slot, which is
 * where the button was. Then back to the editor, opened on the new section
 * (`?nueva=<id>`, compared against the wedding's own blocks), or with a
 * closed `?error=`.
 */
export async function insertBlockAction(formData: FormData): Promise<void> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(sitePath(weddingId));
  const kind = formText(formData, "kind");
  const anchor = parseAnchor(formText(formData, "anchor"));
  const back = (error: InsertFailure) => redirect(`${sitePath(weddingId)}?error=${error}#secciones`);
  if (!isPhotoBlockKind(kind) || kind === "cover" || anchor === undefined) back("invalid");
  const blockKind = kind as Exclude<PhotoBlockKind, "cover">;

  const result = await createPhotoBlock(await createSupabaseServerClient(), weddingId, blockKind, {
    variant: PHOTO_BLOCK_VARIANTS[blockKind][0],
    anchor: anchor ?? null,
    title: null,
    body: null,
  });
  if (!result.ok) {
    if (result.reason === "unauthenticated") await requireUser(sitePath(weddingId));
    if (result.reason === "disabled") notFound();
    back(result.reason === "block_limit" || result.reason === "invalid" || result.reason === "not_found" ? result.reason : "error");
    return;
  }
  refresh(weddingId);
  redirect(`${sitePath(weddingId)}?nueva=${result.value}#bloque-${result.value}`);
}

/** "Mostrar / Ocultar" on a photo section's row (the cover included): visibility only. */
export async function setBlockVisibilityAction(_prev: PhotoFormState, formData: FormData): Promise<PhotoFormState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(photosPath(weddingId));
  const isVisible = formText(formData, "visible") === "on";
  const name = formText(formData, "name").slice(0, 120);
  const result = await updatePhotoBlock(await createSupabaseServerClient(), weddingId, formText(formData, "blockId"), {
    isVisible,
  });
  if (!result.ok) return failure(weddingId, result.reason);
  refresh(weddingId);
  const copy = getMessages().site.compose;
  return done(interpolate(isVisible ? copy.shownMessage : copy.hiddenMessage, { name }));
}

export async function saveBlockAction(_prev: PhotoFormState, formData: FormData): Promise<PhotoFormState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(photosPath(weddingId));
  const copy = getMessages().site.photos;

  const kind = formText(formData, "kind");
  if (!isPhotoBlockKind(kind)) return { ok: false, formError: copy.errors.invalid };
  const isVisible = formData.get("visible") === "on";
  const supabase = await createSupabaseServerClient();

  if (kind === "cover") {
    const result = await updatePhotoBlock(supabase, weddingId, formText(formData, "blockId"), { isVisible });
    if (!result.ok) return failure(weddingId, result.reason);
    refresh(weddingId);
    return done(copy.cover.saved);
  }

  const fields = readBlockFields(formData, kind);
  if (!fields.ok) return fields;
  const variant = parseVariant(kind, fields.variant);
  if (!variant || fields.anchor === undefined) return { ok: false, formError: copy.errors.invalid };
  const result = await updatePhotoBlock(supabase, weddingId, formText(formData, "blockId"), {
    isVisible,
    variant,
    anchor: fields.anchor,
    title: fields.title,
    body: fields.body,
  });
  if (!result.ok) return failure(weddingId, result.reason);
  refresh(weddingId);
  return done(copy.blocks.saved);
}

export async function deleteBlockAction(_prev: PhotoConfirmState, formData: FormData): Promise<PhotoConfirmState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(photosPath(weddingId));
  const result = await deletePhotoBlock(await createSupabaseServerClient(), weddingId, formText(formData, "blockId"));
  if (!result.ok) return failure(weddingId, result.reason);
  refresh(weddingId);
  return { ok: true, data: undefined };
}

/**
 * "Mover antes / Mover después" for a block or a photo in a block. The
 * message names the new position ("posición 2 de 3") for the live region.
 */
export async function moveAction(_prev: PhotoFormState, formData: FormData): Promise<PhotoFormState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(photosPath(weddingId));
  const copy = getMessages().site.photos.blocks;

  const targetKind = formText(formData, "target") === "photo" ? "photo" : "block";
  const id = formText(formData, "id");
  const direction = formText(formData, "direction") === "before" ? "before" : "after";
  const name = formText(formData, "name").slice(0, 120);
  const supabase = await createSupabaseServerClient();

  const result = await movePhotoItem(supabase, weddingId, { kind: targetKind, id }, direction);
  if (!result.ok) return failure(weddingId, result.reason);
  refresh(weddingId);
  if (!result.value) return done(interpolate(copy.notMoved, { name }));

  // The new position, read back as the editor will show it.
  const access = await requireWeddingMembership(supabase, weddingId);
  const editor = access.ok ? await getPhotoEditor(supabase, access.access) : null;
  if (!editor) return done(interpolate(copy.notMoved, { name }));
  let siblings: readonly { id: string }[] = [];
  if (targetKind === "block") {
    const blocks = orderedBlocks(editor);
    const anchor = blocks.find((block) => block.id === id)?.anchor;
    siblings = blocks.filter((block) => block.anchor === anchor);
  } else {
    const blockId = editor.photos.find((photo) => photo.id === id)?.blockId;
    siblings = blockId ? photosIn(editor, blockId) : [];
  }
  const position = siblings.findIndex((item) => item.id === id) + 1;
  return done(interpolate(copy.moved, { name, position: String(position), total: String(siblings.length) }));
}
