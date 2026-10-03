import { es } from "@/lib/i18n/messages/es";
import { Constants, type Database } from "@/lib/supabase/database.types";

/**
 * The wedding website's sections (ContentSection): a fixed set of kinds,
 * at most one per wedding, plain text only. Validation here mirrors the
 * database CHECKs, which stay authoritative; it only gives the organizer a
 * useful Spanish message before a round-trip.
 */

export type SectionKind = Database["public"]["Enums"]["content_section_kind"];

/** Canonical (public display) order: the enum order. */
export const SECTION_KINDS: readonly SectionKind[] = Constants.public.Enums.content_section_kind;

export const SECTION_TITLE_MAX_LENGTH = 120;
export const SECTION_BODY_MAX_LENGTH = 5000;

// Control characters (C0, DEL, C1): plain text only.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
// Same, except the line feed (bodies keep their line breaks).
const BODY_CONTROL_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

export function isSectionKind(value: string): value is SectionKind {
  return (SECTION_KINDS as readonly string[]).includes(value);
}

/** The heading a section shows: its own title, or the kind's default. */
export function sectionTitle(kind: SectionKind, title: string | null): string {
  return title ?? es.site.defaultTitles[kind];
}

/**
 * Whether a section has something to show publicly. The RSVP section
 * always does: without text it shows the fixed guidance to use the
 * personal invitation link (never a form).
 */
export function hasPublicContent(kind: SectionKind, body: string | null): boolean {
  return body !== null || kind === "rsvp";
}

// ------------------------------------------------------------- validation

export type SectionTextResult =
  | Readonly<{ ok: true; value: string | null }>
  | Readonly<{ ok: false; error: string }>;

/** Optional heading: trimmed, blank = null (default heading), ≤ 120, one line. */
export function parseSectionTitle(raw: string): SectionTextResult {
  const v = es.site.validation;
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if ([...value].length > SECTION_TITLE_MAX_LENGTH) return { ok: false, error: v.titleTooLong };
  if (CONTROL_CHARACTERS.test(value)) return { ok: false, error: v.titleInvalid };
  return { ok: true, value };
}

/**
 * Plain-text body: line breaks normalized to \n and kept; trimmed; blank =
 * null; ≤ 5000 characters; no other control characters. Text that looks
 * like HTML stays text: it is stored and shown literally, never parsed.
 */
export function parseSectionBody(raw: string): SectionTextResult {
  const v = es.site.validation;
  const value = raw.replace(/\r\n?/g, "\n").trim();
  if (!value) return { ok: true, value: null };
  if ([...value].length > SECTION_BODY_MAX_LENGTH) return { ok: false, error: v.bodyTooLong };
  if (BODY_CONTROL_CHARACTERS.test(value)) return { ok: false, error: v.bodyInvalid };
  return { ok: true, value };
}

export type SectionField = "title" | "body";

export type SectionInput = Readonly<{
  kind: SectionKind;
  title: string | null;
  body: string | null;
  isVisible: boolean;
}>;

export type SectionInputResult =
  | Readonly<{ ok: true; input: SectionInput }>
  | Readonly<{ ok: false; fieldErrors: Partial<Record<SectionField, string>> }>;

/**
 * One section form. A visible section needs content (except RSVP, see
 * hasPublicContent); a hidden one may be blank.
 */
export function parseSectionInput(
  kind: SectionKind,
  raw: { title: string; body: string; visible: boolean },
): SectionInputResult {
  const title = parseSectionTitle(raw.title);
  const body = parseSectionBody(raw.body);
  const fieldErrors: Partial<Record<SectionField, string>> = {};
  if (!title.ok) fieldErrors.title = title.error;
  if (!body.ok) fieldErrors.body = body.error;
  else if (raw.visible && !hasPublicContent(kind, body.value)) {
    fieldErrors.body = es.site.validation.visibleNeedsBody;
  }
  if (!title.ok || !body.ok || fieldErrors.body) return { ok: false, fieldErrors };
  return { ok: true, input: { kind, title: title.value, body: body.value, isVisible: raw.visible } };
}

// ---------------------------------------------------------- editor model

export type EditorSection = Readonly<{
  kind: SectionKind;
  title: string | null;
  body: string | null;
  isVisible: boolean;
}>;

type StoredSection = Readonly<{
  kind: SectionKind;
  title: string | null;
  body: string | null;
  is_visible: boolean;
}>;

/**
 * All seven sections in canonical order; a kind never saved yet is blank
 * and hidden (exactly what a missing row means). Unknown kinds are ignored.
 */
export function toEditorSections(rows: readonly StoredSection[]): EditorSection[] {
  return SECTION_KINDS.map((kind) => {
    const row = rows.find((r) => r.kind === kind);
    return {
      kind,
      title: row?.title ?? null,
      body: row?.body ?? null,
      isVisible: row?.is_visible ?? false,
    };
  });
}

// ------------------------------------------------------------ public DTO

export type PublishedSection = Readonly<{
  kind: SectionKind;
  title: string;
  body: string;
}>;

/**
 * Everything the public site shows, and nothing else: no ids, owners, time
 * zone, timestamps, members, checklist or guest data.
 */
export type PublishedWeddingSite = Readonly<{
  slug: string;
  name: string;
  /** Calendar date `YYYY-MM-DD`, or null (no date shown). */
  weddingDate: string | null;
  city: string | null;
  sections: readonly PublishedSection[];
}>;

/** One row of `get_published_wedding_site` (section fields null when none). */
export type PublishedSiteRow = Readonly<{
  wedding_name: string;
  wedding_date: string | null;
  wedding_city: string | null;
  section_kind: SectionKind | null;
  section_title: string | null;
  section_body: string | null;
}>;

/**
 * Shapes the public read function's rows into the public DTO: sections in
 * canonical order, at most one per kind, only those with something to show,
 * default headings and the RSVP guidance filled in. No rows = no site.
 */
export function toPublishedSite(
  slug: string,
  rows: readonly PublishedSiteRow[],
): PublishedWeddingSite | null {
  const first = rows[0];
  if (!first) return null;

  const sections: PublishedSection[] = [];
  for (const kind of SECTION_KINDS) {
    const row = rows.find((r) => r.section_kind === kind);
    if (!row || !hasPublicContent(kind, row.section_body)) continue;
    sections.push({
      kind,
      title: sectionTitle(kind, row.section_title),
      body: row.section_body ?? es.publicSite.rsvpDefault,
    });
  }

  return {
    slug,
    name: first.wedding_name,
    weddingDate: first.wedding_date,
    city: first.wedding_city,
    sections,
  };
}
