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
  /** MKT-2: the page for wedding planners, and the brand's home (`/` redirects here, ACCOUNT-01). */
  PLANNERS: "/planners",
  /** MKT-3: the page for couples organizing their own wedding. */
  COUPLES: "/parejas",
  LOGIN: "/login",
  DEMO: mailto("Solicitud de demo - listalaboda.com"),
  PILOT: mailto("Aplicación al pilot - listalaboda.com"),
  ACCESS: mailto("Solicitud de acceso - listalaboda.com"),
  CONTACT: `mailto:${MARKETING_CONTACT_EMAIL}`,
  /** ACCOUNT-01: the shared "Cómo funciona" section of the CURRENT page (both landings have it). */
  HOW_IT_WORKS: "#como-funciona",
} as const;
