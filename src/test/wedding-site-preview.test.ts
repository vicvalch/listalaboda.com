import { describe, expect, it } from "vitest";

import { WEDDING_SITE_THEME_KEYS } from "@/lib/wedding-site/design/themes";
import {
  previewThemeKey,
  sitePreviewPath,
  THUMBNAIL_BODY_LENGTH,
  THUMBNAIL_SECTIONS,
  toPreviewSite,
  toThumbnailSite,
} from "@/lib/wedding-site/preview";
import { toEditorSections, toPublishedSite, type PublishedSiteRow } from "@/lib/wedding-site/sections";

// The member-only preview (ADR-019, CP5) is the public page's content, built
// from member reads: the same shaping as the public read, only visible
// sections, and only the header fields the public site shows.

const HEADER = { name: "Sofía & Andrés", weddingDate: "2090-06-01", city: "Ciudad de Prueba" };

const STORED = [
  { kind: "intro" as const, title: null, body: "Bienvenidos.", is_visible: true },
  { kind: "ceremony" as const, title: "La ceremonia", body: "Texto oculto de la ceremonia", is_visible: false },
  { kind: "faq" as const, title: null, body: "Preguntas", is_visible: true },
  { kind: "rsvp" as const, title: null, body: null, is_visible: true },
];

describe("toPreviewSite", () => {
  it("equals what the public read would return for the same wedding", () => {
    // The rows get_published_wedding_site returns: visible sections only.
    const publicRows: PublishedSiteRow[] = STORED.filter((s) => s.is_visible).map((s) => ({
      wedding_name: HEADER.name,
      wedding_date: HEADER.weddingDate,
      wedding_city: HEADER.city,
      section_kind: s.kind,
      section_title: s.title,
      section_body: s.body,
    }));
    const preview = toPreviewSite(HEADER, toEditorSections(STORED), "sofia-y-andres");
    expect(preview).toEqual(toPublishedSite("sofia-y-andres", publicRows));
    expect(preview.sections.map((s) => s.kind)).toEqual(["intro", "faq", "rsvp"]);
  });

  it("never carries hidden sections or any field beyond the public DTO", () => {
    const header = { ...HEADER, id: "w-1", timeZone: "America/Costa_Rica", memberCounts: { owner: 1, collaborator: 2 } };
    const preview = toPreviewSite(header, toEditorSections(STORED), "");
    expect(Object.keys(preview).sort()).toEqual(["city", "name", "sections", "slug", "weddingDate"]);
    for (const section of preview.sections) expect(Object.keys(section).sort()).toEqual(["body", "kind", "title"]);
    const json = JSON.stringify(preview);
    for (const secret of ["Texto oculto", "La ceremonia", "w-1", "America/Costa_Rica", "collaborator"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("a site with nothing visible is the header alone, like the public read's single row", () => {
    const preview = toPreviewSite(HEADER, toEditorSections([]), "");
    expect(preview).toEqual({ slug: "", name: HEADER.name, weddingDate: HEADER.weddingDate, city: HEADER.city, sections: [] });
  });

  it("fills in default headings and the RSVP guidance exactly as the public page does", () => {
    const preview = toPreviewSite(HEADER, toEditorSections(STORED), "");
    expect(preview.sections[0].title).toBe("Bienvenidos");
    expect(preview.sections[2].body).toBe("Para confirmar asistencia, usa el enlace personal que recibiste con tu invitación.");
  });
});

describe("toThumbnailSite", () => {
  it("keeps the header and the first sections, with long text cut", () => {
    const long = "á".repeat(THUMBNAIL_BODY_LENGTH + 50);
    const site = {
      slug: "",
      ...HEADER,
      sections: [
        { kind: "intro" as const, title: "Uno", body: long },
        { kind: "ceremony" as const, title: "Dos", body: "Corto" },
        { kind: "faq" as const, title: "Tres", body: "Fuera" },
      ],
    };
    const thumbnail = toThumbnailSite(site);
    expect(thumbnail.name).toBe(HEADER.name);
    expect(thumbnail.sections).toHaveLength(THUMBNAIL_SECTIONS);
    expect([...thumbnail.sections[0].body]).toHaveLength(THUMBNAIL_BODY_LENGTH + 1);
    expect(thumbnail.sections[0].body.endsWith("…")).toBe(true);
    expect(thumbnail.sections[1].body).toBe("Corto");
  });
});

describe("previewThemeKey", () => {
  it("uses the query value only when it is exactly a theme key", () => {
    for (const key of WEDDING_SITE_THEME_KEYS) expect(previewThemeKey(key, "romantic")).toBe(key);
  });

  it.each([[undefined], ["neon"], ["Editorial"], [" minimal"], [""], [["editorial", "minimal"]], ["__proto__"]])(
    "%j falls back to the current theme",
    (raw) => {
      expect(previewThemeKey(raw, "tropical")).toBe("tropical");
      expect(previewThemeKey(raw)).toBe("classic");
    },
  );
});

describe("sitePreviewPath", () => {
  it("is the organizer preview route with the theme key", () => {
    expect(sitePreviewPath("8d0f6b8e-0000-4000-8000-000000000001", "romantic")).toBe(
      "/app/weddings/8d0f6b8e-0000-4000-8000-000000000001/site/preview?theme=romantic",
    );
  });
});
