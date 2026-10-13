import { toPublishedSite, type PublishedSiteRow, type PublishedWeddingSite } from "@/lib/wedding-site/sections";

/**
 * Published-site fixtures for exercising the themes (ADR-019, CP2) in unit
 * tests and the E2E visual check. Nothing in the app selects or stores a
 * theme yet, so these are the only way to draw Editorial and Minimal. Names
 * and places are generic fakes.
 */

function row(overrides: Partial<PublishedSiteRow>): PublishedSiteRow {
  return {
    wedding_name: "Sofía & Andrés",
    wedding_date: "2027-02-14",
    wedding_city: "San José",
    section_kind: null,
    section_title: null,
    section_body: null,
    ...overrides,
  };
}

export function siteFrom(rows: PublishedSiteRow[]): PublishedWeddingSite {
  const built = toPublishedSite("sofia-y-andres", rows);
  if (!built) throw new Error("fixture has no rows");
  return built;
}

/** Every section kind with text, a custom title, multi-line text and RSVP guidance. */
const FULL = siteFrom([
  row({
    section_kind: "intro",
    section_title: "Nuestra historia",
    section_body: "Nos conocimos en una librería.\nY aquí estamos.",
  }),
  row({ section_kind: "ceremony", section_body: "Iglesia de La Merced, 3:00 p. m." }),
  row({ section_kind: "reception", section_body: "Hacienda El Rodeo." }),
  row({ section_kind: "schedule", section_body: "15:00 Ceremonia\n17:00 Recepción\n23:00 Cierre" }),
  row({ section_kind: "dress_code", section_body: "Formal. Por favor, sin blanco." }),
  row({ section_kind: "faq", section_title: "Preguntas", section_body: "¿Niños? Sí, bienvenidos." }),
  row({ section_kind: "rsvp", section_body: null }),
]);

const LONG_NAME = siteFrom([
  row({
    wedding_name: "Maximiliano Fernández-Altamirano & Guadalupe Villalobos-Quesada",
    section_kind: "intro",
    section_title: "Unaparabrasinespaciosquenodeberíadesbordarlapantallaenningúntema",
    section_body: "Bienvenidos.",
  }),
  row({
    wedding_name: "Maximiliano Fernández-Altamirano & Guadalupe Villalobos-Quesada",
    section_kind: "rsvp",
  }),
]);

/** One very long surname with no break opportunity, in the name itself. */
const LONG_WORD = siteFrom([
  row({
    wedding_name: "Ana Wolfeschlegelsteinhausenbergerdorffvoralternwarengewissenhaft & Luis",
    section_kind: "intro",
    section_body: "Bienvenidos.",
  }),
]);

const NO_DATE = siteFrom([
  row({ wedding_date: null, section_kind: "ceremony", section_body: "Capilla del Carmen." }),
  row({ wedding_date: null, section_kind: "rsvp" }),
]);

const LONG_CITY = siteFrom([
  row({
    wedding_city: "Santa María de los Ángeles de Monteverde, Puntarenas, Costa Rica",
    section_kind: "reception",
    section_body: "Finca La Esperanza.",
  }),
]);

const MULTILINE = siteFrom([
  row({
    section_kind: "schedule",
    section_body:
      "14:30 Llegada de invitados\n15:00 Ceremonia\n16:00 Fotos\n17:00 Recepción y cena\n" +
      "20:00 Primer baile\n23:30 Cierre\n\nPor favor, llega con tiempo: el estacionamiento es limitado y " +
      "queremos empezar puntuales para disfrutar la tarde con todos ustedes.",
  }),
  row({ section_kind: "faq", section_body: "¿Hay transporte?\nSí, desde el hotel.\n\n¿Niños?\nSí." }),
]);

export const THEME_FIXTURES = {
  full: FULL,
  "long-name": LONG_NAME,
  "long-word": LONG_WORD,
  "no-date": NO_DATE,
  "long-city": LONG_CITY,
  multiline: MULTILINE,
} as const satisfies Record<string, PublishedWeddingSite>;

export const FIXTURE_ROW = row;
