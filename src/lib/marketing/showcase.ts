import {
  toPublishedSite,
  type PublishedSiteRow,
  type PublishedWeddingSite,
  type SectionKind,
} from "@/lib/wedding-site/sections";

/**
 * Fictional wedding content for the marketing theme showcase (Marketing
 * Landing V1). A constant in code: no database, no public read, no real
 * wedding. It goes through the same public shaping as a published site
 * (`toPublishedSite`), so the showcase draws exactly what the real renderer
 * would. No contacts, links, tokens or ids.
 */
const sections: { kind: SectionKind; title: string | null; body: string }[] = [
  { kind: "intro", title: "Nuestra historia", body: "Nos conocimos en un viaje a la playa.\nDiez años después, aquí estamos." },
  { kind: "ceremony", title: null, body: "Sábado a las 3:00 p. m., en el jardín de la hacienda." },
  { kind: "reception", title: null, body: "Cena y baile bajo las estrellas." },
];

const rows: PublishedSiteRow[] = sections.map(({ kind, title, body }) => ({
  wedding_name: "Mariana & Tomás",
  wedding_date: "2027-03-20",
  wedding_city: "Santa Ana",
  section_kind: kind,
  section_title: title,
  section_body: body,
}));

export const SHOWCASE_SITE: PublishedWeddingSite = toPublishedSite("mariana-y-tomas", rows) as PublishedWeddingSite;
