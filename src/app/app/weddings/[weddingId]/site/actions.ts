"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { formText, type FormState } from "@/lib/forms/result";
import { getMessages, interpolate } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  CUSTOMIZATION_GROUPS,
  customizationDocument,
  parseCustomization,
  type CustomizationGroup,
} from "@/lib/wedding-site/design/customization";
import { CUSTOMIZABLE_FIELDS, isWeddingSiteThemeKey, type CustomizableField } from "@/lib/wedding-site/design/themes";
import { siteCustomPreviewPath } from "@/lib/wedding-site/preview";
import { isSectionKind, parseSectionInput, type SectionField } from "@/lib/wedding-site/sections";
import {
  publishWeddingSite,
  resetWeddingSiteCustomization,
  saveContentSection,
  saveWeddingSiteDesign,
  saveWeddingSiteTheme,
  setWeddingSiteSlug,
  unpublishWeddingSite,
} from "@/lib/wedding-site/service";
import { parseSlug } from "@/lib/wedding-site/slug";

/**
 * Wedding website mutations. Section content and the design (theme and
 * customization) are for any member (owner or collaborator); the address,
 * publishing and unpublishing are owner-only (service + database). Forms carry only lookup keys (wedding id, section
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

// ------------------------------------------------------------------ theme

export type ThemeFormState = FormState<never, { message: string; nonce: string }> | null;

/**
 * "Usar este estilo" (ADR-019, CP5), from the selector or the preview. The
 * form carries the wedding id and the chosen key (a submit button's value);
 * anything that isn't exactly a theme key is refused before the service.
 * Saving writes only the theme: it never publishes, unpublishes or touches
 * content, and a published site shows the new look at once (its page reads
 * on every request).
 */
export async function saveThemeAction(_prev: ThemeFormState, formData: FormData): Promise<ThemeFormState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(sitePath(weddingId));
  const copy = getMessages().site;

  const theme = formText(formData, "theme");
  if (!isWeddingSiteThemeKey(theme)) return { ok: false, formError: copy.design.invalid };

  const result = await saveWeddingSiteTheme(await createSupabaseServerClient(), weddingId, theme);
  if (!result.ok) {
    if (result.reason === "invalid") return { ok: false, formError: copy.design.invalid };
    return { ok: false, formError: await handleFailure(weddingId, result.reason) };
  }

  revalidatePath(sitePath(weddingId), "layout");
  const saved = interpolate(copy.design.saved, { name: copy.themes[result.themeKey].name });
  return {
    ok: true,
    data: {
      message: result.dropped.length > 0 ? `${saved} ${copy.design.dropped}` : saved,
      nonce: crypto.randomUUID(),
    },
  };
}

// ---------------------------------------------------------- customization

export type CustomizeFormState = FormState<never, { message: string; nonce: string }> | null;

type CustomizeIntent = "save" | "preview" | Readonly<{ reset: CustomizationGroup | "all" }>;

function customizeIntent(value: string): CustomizeIntent | null {
  if (value === "save" || value === "preview") return value;
  const [verb, group] = value.split(":");
  if (verb !== "reset" || !group) return null;
  if (group === "all" || (CUSTOMIZATION_GROUPS as readonly string[]).includes(group)) {
    return { reset: group as CustomizationGroup | "all" };
  }
  return null;
}

/**
 * "Personalizar" (ADR-019, CP6), from the site page or the preview. The form
 * carries the wedding id, the theme it was drawn for, one radio value per
 * customizable field and the clicked button's intent:
 *   * `save`: the theme + those choices, through the one design write;
 *   * `preview`: no write; checks the choices and opens the member-only
 *     preview with them (closed values in the URL, never JSON);
 *   * `reset:<group>` / `reset:all`: the STORED customization loses that
 *     group (or everything); the theme stays.
 * Only known field names are read, every value must be one of the theme's
 * options (else nothing is saved or previewed), and the caller and
 * membership come from the server.
 */
export async function saveCustomizationAction(
  _prev: CustomizeFormState,
  formData: FormData,
): Promise<CustomizeFormState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(sitePath(weddingId));
  const copy = getMessages().site;

  const intent = customizeIntent(formText(formData, "intent"));
  const theme = formText(formData, "theme");
  if (!intent || !isWeddingSiteThemeKey(theme)) return { ok: false, formError: copy.customize.invalid };
  const done = (message: string): CustomizeFormState => {
    revalidatePath(sitePath(weddingId), "layout");
    return { ok: true, data: { message, nonce: crypto.randomUUID() } };
  };

  if (typeof intent === "object") {
    const result = await resetWeddingSiteCustomization(await createSupabaseServerClient(), weddingId, intent.reset);
    if (!result.ok) {
      if (result.reason === "invalid") return { ok: false, formError: copy.customize.invalid };
      return { ok: false, formError: await handleFailure(weddingId, result.reason) };
    }
    return done(
      intent.reset === "all"
        ? interpolate(copy.customize.resetAllDone, { name: copy.themes[result.design.themeKey].name })
        : interpolate(copy.customize.resetDone, { group: copy.customize.groups[intent.reset] }),
    );
  }

  const values: Partial<Record<CustomizableField, string>> = {};
  for (const field of CUSTOMIZABLE_FIELDS) {
    const value = formText(formData, field);
    if (value) values[field] = value;
  }
  const document = customizationDocument(values);

  if (intent === "preview") {
    const parsed = parseCustomization(theme, document);
    if (!parsed.ok) return { ok: false, formError: copy.customize.invalid };
    redirect(siteCustomPreviewPath(weddingId, { themeKey: theme, customization: parsed.overrides }));
  }

  const result = await saveWeddingSiteDesign(await createSupabaseServerClient(), weddingId, theme, document);
  if (!result.ok) {
    if (result.reason === "invalid") return { ok: false, formError: copy.customize.invalid };
    return { ok: false, formError: await handleFailure(weddingId, result.reason) };
  }
  return done(interpolate(copy.customize.saved, { name: copy.themes[result.design.themeKey].name }));
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
