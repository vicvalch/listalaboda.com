"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { formText, type FormState } from "@/lib/forms/result";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isSectionKind, parseSectionInput, type SectionField } from "@/lib/wedding-site/sections";
import {
  publishWeddingSite,
  saveContentSection,
  setWeddingSiteSlug,
  unpublishWeddingSite,
} from "@/lib/wedding-site/service";
import { parseSlug } from "@/lib/wedding-site/slug";

/**
 * Wedding website mutations. Section content is for any member (owner or
 * collaborator); the address, publishing and unpublishing are owner-only
 * (service + database). Forms carry only lookup keys (wedding id, section
 * kind) and the typed values; the caller, their membership and role are
 * derived on the server by the service, and the database re-checks every
 * write. No form field can claim a role.
 */

function sitePath(weddingId: string): string {
  return `/app/weddings/${encodeURIComponent(weddingId)}/site`;
}

/** Shared handling of access failures; returns the form message for the rest. */
async function handleFailure(weddingId: string, reason: string): Promise<string> {
  const copy = getMessages().site.errors;
  switch (reason) {
    case "unauthenticated":
      await requireUser(sitePath(weddingId));
      return copy.failed;
    case "not_found":
      // Non-members get the same 404 as a nonexistent wedding.
      notFound();
    case "forbidden":
      // A collaborator invoking an owner-only action directly.
      return copy.ownerOnly;
    default:
      return copy.failed;
  }
}

// ---------------------------------------------------------------- section

export type SectionFormState =
  | FormState<SectionField | "visible", { message: string; nonce: string }>
  | null;

export async function saveSectionAction(
  _prev: SectionFormState,
  formData: FormData,
): Promise<SectionFormState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(sitePath(weddingId));
  const copy = getMessages().site;

  const visible = formData.get("visible") === "on";
  const values = {
    title: formText(formData, "title"),
    body: formText(formData, "body"),
    visible: visible ? "on" : "",
  };
  const kind = formText(formData, "kind");
  if (!isSectionKind(kind)) return { ok: false, formError: copy.errors.failed, values };

  const parsed = parseSectionInput(kind, { title: values.title, body: values.body, visible });
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors, values };

  const result = await saveContentSection(await createSupabaseServerClient(), weddingId, parsed.input);
  if (!result.ok) {
    if (result.reason === "invalid") return { ok: false, formError: copy.validation.bodyInvalid, values };
    return { ok: false, formError: await handleFailure(weddingId, result.reason), values };
  }

  revalidatePath(sitePath(weddingId));
  return { ok: true, data: { message: copy.sections.saved, nonce: crypto.randomUUID() } };
}

// ------------------------------------------------------------------- slug

export type SlugFormState = FormState<"slug", { message: string; nonce: string }> | null;

export async function setSlugAction(_prev: SlugFormState, formData: FormData): Promise<SlugFormState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(sitePath(weddingId));
  const copy = getMessages().site.slug;

  const values = { slug: formText(formData, "slug") };
  const parsed = parseSlug(values.slug);
  if (!parsed.ok) return { ok: false, fieldErrors: { slug: parsed.error }, values };

  const result = await setWeddingSiteSlug(await createSupabaseServerClient(), weddingId, parsed.slug);
  if (!result.ok) {
    // Never says which wedding holds the address.
    if (result.reason === "already_used") return { ok: false, fieldErrors: { slug: copy.validation.taken }, values };
    if (result.reason === "invalid") return { ok: false, fieldErrors: { slug: copy.validation.invalid }, values };
    return { ok: false, formError: await handleFailure(weddingId, result.reason), values };
  }

  revalidatePath(sitePath(weddingId));
  return { ok: true, data: { message: copy.saved, nonce: crypto.randomUUID() } };
}

// ---------------------------------------------------- publish / unpublish

export type PublicationState = FormState<never> | null;

export async function publishSiteAction(
  _prev: PublicationState,
  formData: FormData,
): Promise<PublicationState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(sitePath(weddingId));
  const copy = getMessages().site.publish;

  const result = await publishWeddingSite(await createSupabaseServerClient(), weddingId);
  if (!result.ok) {
    if (result.reason === "slug_required") return { ok: false, formError: copy.needsSlug };
    if (result.reason === "empty") return { ok: false, formError: copy.empty };
    return { ok: false, formError: await handleFailure(weddingId, result.reason) };
  }
  revalidatePath(sitePath(weddingId));
  // A fixed flag, no data: the page announces it.
  redirect(`${sitePath(weddingId)}?done=published`);
}

export async function unpublishSiteAction(
  _prev: PublicationState,
  formData: FormData,
): Promise<PublicationState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(sitePath(weddingId));

  const result = await unpublishWeddingSite(await createSupabaseServerClient(), weddingId);
  if (!result.ok) return { ok: false, formError: await handleFailure(weddingId, result.reason) };
  revalidatePath(sitePath(weddingId));
  redirect(`${sitePath(weddingId)}?done=unpublished`);
}
