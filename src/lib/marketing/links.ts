/**
 * Where the marketing pages send people (Marketing Landing V1). The only
 * place these destinations live: components import them, never a literal.
 *
 * Self-signup isn't relied on yet (production signup is pending LB-26), so
 * requesting access goes to the same contact address as the demo and the
 * pilot, each with its own subject line.
 */

import { SUPPORT_EMAIL } from "@/lib/legal/links";

/** The contact address shown and mailed from the marketing pages: the support address (Batch 1). */
export const MARKETING_CONTACT_EMAIL = SUPPORT_EMAIL;

function mailto(subject: string): string {
  return `mailto:${MARKETING_CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}

export const MARKETING_LINKS = {
  /** MKT-2: the page for wedding planners, and the brand's home (`/` redirects here, ACCOUNT-01). */
  PLANNERS: "/planners",
  /** MKT-3: the page for couples organizing their own wedding. */
  COUPLES: "/parejas",
  LOGIN: "/login",
  /**
   * BILLING-02 / MKT-7: the pricing calls to action. Login carrying the
   * billing page as `next` (= `loginPath(BILLING_PATH)`), so the EXISTING
   * flow does the rest: signed in → straight to billing; new → "Crea una
   * aquí" keeps `next` through signup; untyped → the account-type choice,
   * then billing. Never a direct /signup link (LB-26) and never a plan or
   * account type in the URL (ADR-020: the type is chosen, never inferred).
   */
  START_BILLING: "/login?next=%2Fapp%2Fbilling",
  DEMO: mailto("Solicitud de demo - listalaboda.com"),
  PILOT: mailto("Aplicación al pilot - listalaboda.com"),
  ACCESS: mailto("Solicitud de acceso - listalaboda.com"),
  CONTACT: `mailto:${MARKETING_CONTACT_EMAIL}`,
  /** ACCOUNT-01: the shared "Cómo funciona" section of the CURRENT page (both landings have it). */
  HOW_IT_WORKS: "#como-funciona",
} as const;
