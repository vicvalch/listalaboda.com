import { describe, expect, it } from "vitest";

import { getMessages } from "@/lib/i18n";
import {
  SECTION_BODY_MAX_LENGTH,
  SECTION_KINDS,
  isSectionKind,
  parseSectionBody,
  parseSectionInput,
  parseSectionTitle,
  sectionTitle,
  toEditorSections,
  toPublishedSite,
  type PublishedSiteRow,
} from "@/lib/wedding-site/sections";

const copy = getMessages().site;
const v = copy.validation;
const RSVP_DEFAULT = getMessages().publicSite.rsvpDefault;

describe("section kinds", () => {
  it("are exactly the Constitution's website sections, in display order", () => {
    expect(SECTION_KINDS).toEqual(["intro", "ceremony", "reception", "schedule", "dress_code", "faq", "rsvp"]);
    expect(isSectionKind("faq")).toBe(true);
    for (const other of ["travel", "hotel", "gallery", "registry", "", "INTRO"]) {
      expect(isSectionKind(other)).toBe(false);
    }
  });

  it("have neutral default headings and editor labels for every kind", () => {
    for (const kind of SECTION_KINDS) {
      expect(copy.defaultTitles[kind]).toBeTruthy();
      expect(copy.kinds[kind]).toBeTruthy();
    }
    expect(sectionTitle("intro", null)).toBe("Bienvenidos");
    expect(sectionTitle("intro", "Hola")).toBe("Hola");
  });
});

describe("owner-only copy", () => {
  it("names the owner role by its product label, the same everywhere on the site editor", () => {
    const ownerLabel = getMessages().roles.owner.label;
    expect(copy.status.collaboratorNote).toBe(copy.errors.ownerOnly);
    expect(copy.errors.ownerOnly).toContain(`«${ownerLabel}»`);
    expect(copy.header.collaboratorNote).toContain(`«${ownerLabel}»`);
    for (const text of [copy.errors.ownerOnly, copy.header.collaboratorNote]) {
      expect(text).not.toMatch(/quienes organizan|quien organiza/i);
    }
  });
});

describe("parseSectionTitle", () => {
  it("trims; blank means the default heading", () => {
    expect(parseSectionTitle("  Nuestra ceremonia ")).toEqual({ ok: true, value: "Nuestra ceremonia" });
    expect(parseSectionTitle("   ")).toEqual({ ok: true, value: null });
  });

  it("is one line of at most 120 characters", () => {
    expect(parseSectionTitle("ñ".repeat(120)).ok).toBe(true);
    expect(parseSectionTitle("ñ".repeat(121))).toEqual({ ok: false, error: v.titleTooLong });
    expect(parseSectionTitle("Dos\nlíneas")).toEqual({ ok: false, error: v.titleInvalid });
    expect(parseSectionTitle("Tab\there")).toEqual({ ok: false, error: v.titleInvalid });
  });
});

describe("parseSectionBody", () => {
  it("keeps line breaks, normalizing CRLF/CR to LF, and trims the ends", () => {
    expect(parseSectionBody("\r\n Línea 1\r\nLínea 2\rLínea 3 \n")).toEqual({
      ok: true,
      value: "Línea 1\nLínea 2\nLínea 3",
    });
    expect(parseSectionBody(" \n\t ")).toEqual({ ok: true, value: null });
  });

  it("caps at 5000 characters (code points) and refuses other control characters", () => {
    expect(parseSectionBody("💍".repeat(SECTION_BODY_MAX_LENGTH)).ok).toBe(true);
    expect(parseSectionBody("a".repeat(SECTION_BODY_MAX_LENGTH + 1))).toEqual({ ok: false, error: v.bodyTooLong });
    expect(parseSectionBody("con\ttab")).toEqual({ ok: false, error: v.bodyInvalid });
    expect(parseSectionBody("nul\u0000")).toEqual({ ok: false, error: v.bodyInvalid });
    expect(parseSectionBody("c1\u0085")).toEqual({ ok: false, error: v.bodyInvalid });
  });

  it("keeps HTML-looking text as literal text", () => {
    const text = '<script>alert("x")</script> <img src=x onerror=alert(1)> **negrita**';
    expect(parseSectionBody(text)).toEqual({ ok: true, value: text });
  });
});

describe("parseSectionInput", () => {
  it("a visible section needs content, except RSVP", () => {
    expect(parseSectionInput("dress_code", { title: "", body: " ", visible: true })).toEqual({
      ok: false,
      fieldErrors: { body: v.visibleNeedsBody },
    });
    expect(parseSectionInput("rsvp", { title: "", body: "", visible: true })).toEqual({
      ok: true,
      input: { kind: "rsvp", title: null, body: null, isVisible: true },
    });
    expect(parseSectionInput("faq", { title: "", body: "", visible: false })).toEqual({
      ok: true,
      input: { kind: "faq", title: null, body: null, isVisible: false },
    });
  });

  it("every non-RSVP kind needs user-written content to be visible", () => {
    for (const kind of SECTION_KINDS.filter((k) => k !== "rsvp")) {
      for (const body of ["", "   ", "\n\r\n"]) {
        expect(parseSectionInput(kind, { title: "Con título", body, visible: true }), kind).toEqual({
          ok: false,
          fieldErrors: { body: v.visibleNeedsBody },
        });
      }
    }
  });

  it("reports every field error at once", () => {
    expect(parseSectionInput("intro", { title: "a".repeat(121), body: "\u0007", visible: true })).toEqual({
      ok: false,
      fieldErrors: { title: v.titleTooLong, body: v.bodyInvalid },
    });
  });
});

describe("toEditorSections", () => {
  it("returns all seven kinds in order; unsaved ones are blank and hidden", () => {
    const sections = toEditorSections([
      { kind: "faq", title: null, body: "Preguntas", is_visible: true },
      { kind: "intro", title: "Hola", body: null, is_visible: false },
    ]);
    expect(sections.map((s) => s.kind)).toEqual(SECTION_KINDS);
    expect(sections[0]).toEqual({ kind: "intro", title: "Hola", body: null, isVisible: false });
    expect(sections[5]).toEqual({ kind: "faq", title: null, body: "Preguntas", isVisible: true });
    expect(sections[1]).toEqual({ kind: "ceremony", title: null, body: null, isVisible: false });
  });
});

describe("toPublishedSite", () => {
  const header = { wedding_name: "Boda de prueba", wedding_date: "2090-06-01", wedding_city: "Ciudad" };
  const row = (kind: PublishedSiteRow["section_kind"], title: string | null, body: string | null): PublishedSiteRow => ({
    ...header,
    section_kind: kind,
    section_title: title,
    section_body: body,
  });

  it("no rows means no public site", () => {
    expect(toPublishedSite("ana-y-luis", [])).toBeNull();
  });

  it("shapes the safe DTO: canonical order, defaults, RSVP guidance", () => {
    const site = toPublishedSite("ana-y-luis", [
      row("rsvp", null, null),
      row("faq", "Dudas", "¿Niños?\nSí."),
      row("intro", null, "Los esperamos"),
    ]);
    expect(site).toEqual({
      slug: "ana-y-luis",
      name: "Boda de prueba",
      weddingDate: "2090-06-01",
      city: "Ciudad",
      sections: [
        { kind: "intro", title: "Bienvenidos", body: "Los esperamos" },
        { kind: "faq", title: "Dudas", body: "¿Niños?\nSí." },
        { kind: "rsvp", title: "Confirmación de asistencia", body: RSVP_DEFAULT },
      ],
    });
    // Only these keys: nothing private can ride along.
    expect(Object.keys(site ?? {}).sort()).toEqual(["city", "name", "sections", "slug", "weddingDate"]);
  });

  it("a published site without visible sections keeps its header", () => {
    expect(toPublishedSite("solo", [row(null, null, null)])?.sections).toEqual([]);
  });

  it("defensively drops empty non-RSVP sections and duplicate kinds", () => {
    const site = toPublishedSite("x-y-z", [
      row("ceremony", "Vacía", null),
      row("schedule", null, "Primero"),
      row("schedule", null, "Duplicado"),
    ]);
    expect(site?.sections).toEqual([{ kind: "schedule", title: "Programa", body: "Primero" }]);
  });

  it("a blank RSVP section shows only the product default; a custom text replaces it", () => {
    expect(toPublishedSite("x-y-z", [row("rsvp", null, null)])?.sections).toEqual([
      { kind: "rsvp", title: "Confirmación de asistencia", body: RSVP_DEFAULT },
    ]);
    expect(RSVP_DEFAULT).toBe("Para confirmar asistencia, usa el enlace personal que recibiste con tu invitación.");
  });

  it("an RSVP section never carries anything but text", () => {
    const site = toPublishedSite("x-y-z", [row("rsvp", "Confirma", "Usa tu enlace personal.")]);
    expect(site?.sections).toEqual([{ kind: "rsvp", title: "Confirma", body: "Usa tu enlace personal." }]);
  });

  it("dates and cities may be missing", () => {
    const site = toPublishedSite("x-y-z", [
      { ...row("intro", null, "Hola"), wedding_date: null, wedding_city: null },
    ]);
    expect(site).toMatchObject({ weddingDate: null, city: null });
  });
});
