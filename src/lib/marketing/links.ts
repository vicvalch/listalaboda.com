/**
 * Where the marketing pages send people (Marketing Landing V1). The only
 * place these destinations live: components import them, never a literal.
 *
 * Self-signup isn't relied on yet (production signup is pending LB-26), so
 * requesting access goes to the same contact address as the demo and the
 * pilot, each with its own subject line.
 */

/** The contact address shown and mailed from the marketing pages. */
export const MARKETING_CONTACT_EMAIL = "vicvalch@onchainfest.xyz";

function mailto(subject: string): string {
  return `mailto:${MARKETING_CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}

export const MARKETING_LINKS = {
  LOGIN: "/login",
  DEMO: mailto("Solicitud de demo - listalaboda.com"),
  PILOT: mailto("Aplicación al pilot - listalaboda.com"),
  ACCESS: mailto("Solicitud de acceso - listalaboda.com"),
  CONTACT: `mailto:${MARKETING_CONTACT_EMAIL}`,
  /** In-page anchors of the homepage, valid from any marketing page. */
  HOW_IT_WORKS: "/#como-funciona",
  WEDDING_SITES: "/#sitios-de-boda",
} as const;
