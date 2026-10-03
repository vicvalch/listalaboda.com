import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  requireWeddingMembership,
  requireWeddingRole,
  type WeddingAccess,
} from "@/lib/authz/wedding";
import type { Database } from "@/lib/supabase/database.types";
import {
  toEditorSections,
  type EditorSection,
  type SectionInput,
} from "@/lib/wedding-site/sections";
import { isValidSlug } from "@/lib/wedding-site/slug";

/**
 * Organizer side of the wedding website (ContentSection + publication).
 *
 * Content is ordinary wedding planning: any member (owner or collaborator)
 * edits sections and their visibility. Publication is an external
 * visibility boundary — choosing the public address, publishing and
 * unpublishing — so it is owner-only: checked here first
 * (`requireWeddingRole`), then by the database (the publication functions
 * re-check the owner role from auth.uid(), and clients hold no write
 * privilege on wedding_publications at all).
 *
 * Every function takes the current user's RLS-bound client and resolves
 * membership server-side first (`@/lib/authz/wedding`). A section is
 * addressed by (authorized wedding, kind), never by an id from the browser,
 * so another wedding's section can't be targeted.
 */

type Client = SupabaseClient<Database>;

type DbError = Readonly<{ code?: string; message?: string }>;

/** Denials meaning the caller can't act on this wedding at all. */
type AccessDenial = "unauthenticated" | "not_found" | "error";

function accessDenial(reason: "unauthenticated" | "not_found" | "forbidden" | "error"): AccessDenial {
  // Content needs membership only; "forbidden" (a member lacking a role)
  // can't happen, and is treated as unexpected.
  return reason === "forbidden" ? "error" : reason;
}

/** Errors raised by the owner-only publication functions. */
function publicationError(error: DbError): "unauthenticated" | "not_found" | "forbidden" | "error" {
  if (error.message === "site_publication_owner_only") return "forbidden";
  if (error.message === "wedding_not_found") return "not_found";
  if (error.message === "not_authenticated") return "unauthenticated";
  return "error";
}

// ------------------------------------------------------------------ editor

export type SitePublication = Readonly<{
  slug: string;
  /** null = not published. */
  publishedAt: string | null;
}>;

export type WeddingSiteEditor = Readonly<{
  /** null = no address chosen yet (never published). */
  publication: SitePublication | null;
  /** All seven sections, canonical order. */
  sections: readonly EditorSection[];
}>;

/**
 * The editor's data in two queries (publication + sections), after a
 * successful membership check. Members (owners and collaborators) read
 * both. Returns null on failure.
 */
export async function getWeddingSiteEditor(
  supabase: Client,
  access: WeddingAccess,
): Promise<WeddingSiteEditor | null> {
  try {
    const [publication, sections] = await Promise.all([
      supabase
        .from("wedding_publications")
        .select("slug, published_at")
        .eq("wedding_id", access.weddingId)
        .maybeSingle(),
      supabase
        .from("content_sections")
        .select("kind, title, body, is_visible")
        .eq("wedding_id", access.weddingId),
    ]);
    if (publication.error || sections.error || !sections.data) return null;
    return {
      publication: publication.data
        ? { slug: publication.data.slug, publishedAt: publication.data.published_at }
        : null,
      sections: toEditorSections(sections.data),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- sections

export type SaveSectionResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: AccessDenial | "invalid" }>;

/**
 * Saves one section — title, body and visibility — for any member. Inserted
 * the first time, updated afterwards (one row per kind). If the site is
 * published, a visible section's change is public at once.
 */
export async function saveContentSection(
  supabase: Client,
  weddingId: string,
  input: SectionInput,
): Promise<SaveSectionResult> {
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) return { ok: false, reason: accessDenial(access.reason) };

  try {
    const { error } = await supabase.rpc("save_wedding_site_section", {
      target_wedding_id: access.access.weddingId,
      section_kind: input.kind,
      // "" is stored as null (no title / no content).
      section_title: input.title ?? "",
      section_body: input.body ?? "",
      section_visible: input.isVisible,
    });
    if (error) {
      // check_violation: over-long, control characters, visible without content.
      if (error.code === "23514" || error.code === "22P02") return { ok: false, reason: "invalid" };
      // RLS: the membership changed since the check.
      if (error.code === "42501") return { ok: false, reason: "not_found" };
      return { ok: false, reason: "error" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}

// ------------------------------------------------------------- publication

type OwnerDenial = "unauthenticated" | "not_found" | "forbidden" | "error";

export type SetSlugResult =
  | Readonly<{ ok: true; slug: string }>
  | Readonly<{ ok: false; reason: OwnerDenial | "invalid" | "already_used" }>;

/**
 * Owner-only: chooses or changes the site's address. Doesn't publish. On a
 * published site the old address stops resolving at once (no redirects).
 * A slug held by another wedding is `already_used`, without saying which.
 */
export async function setWeddingSiteSlug(
  supabase: Client,
  weddingId: string,
  slug: string,
): Promise<SetSlugResult> {
  const access = await requireWeddingRole(supabase, weddingId, ["owner"]);
  if (!access.ok) return { ok: false, reason: access.reason };
  if (!isValidSlug(slug)) return { ok: false, reason: "invalid" };

  try {
    const { data, error } = await supabase.rpc("set_wedding_site_slug", {
      target_wedding_id: access.access.weddingId,
      new_slug: slug,
    });
    if (error) {
      // unique_violation on wedding_publications_slug_key.
      if (error.code === "23505") return { ok: false, reason: "already_used" };
      if (error.code === "23514") return { ok: false, reason: "invalid" };
      return { ok: false, reason: publicationError(error) };
    }
    if (data !== slug) return { ok: false, reason: "error" };
    return { ok: true, slug: data };
  } catch {
    return { ok: false, reason: "error" };
  }
}

export type PublishResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: OwnerDenial | "slug_required" | "empty" }>;

/**
 * Owner-only: publishes the site at its chosen address. Needs an address
 * and at least one visible section. Publishing a published site is a no-op.
 */
export async function publishWeddingSite(supabase: Client, weddingId: string): Promise<PublishResult> {
  const access = await requireWeddingRole(supabase, weddingId, ["owner"]);
  if (!access.ok) return { ok: false, reason: access.reason };

  try {
    const { error } = await supabase.rpc("publish_wedding_site", {
      target_wedding_id: access.access.weddingId,
    });
    if (error) {
      if (error.message === "wedding_site_slug_required") return { ok: false, reason: "slug_required" };
      if (error.message === "wedding_site_empty") return { ok: false, reason: "empty" };
      return { ok: false, reason: publicationError(error) };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}

export type UnpublishResult = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: OwnerDenial }>;

/**
 * Owner-only: the public address stops resolving immediately. Content,
 * visibility and the address are kept; guest RSVP links keep working.
 */
export async function unpublishWeddingSite(
  supabase: Client,
  weddingId: string,
): Promise<UnpublishResult> {
  const access = await requireWeddingRole(supabase, weddingId, ["owner"]);
  if (!access.ok) return { ok: false, reason: access.reason };

  try {
    const { error } = await supabase.rpc("unpublish_wedding_site", {
      target_wedding_id: access.access.weddingId,
    });
    if (error) return { ok: false, reason: publicationError(error) };
    return { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}
