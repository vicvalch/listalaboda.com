/**
 * The legal pages and the support address (Batch 1). The only place these
 * live: marketing, auth, billing and the legal pages import them, never a
 * literal.
 */

/** Where people write for support, refunds and data requests. */
export const SUPPORT_EMAIL = "soporte@listalaboda.com";

/** The id of the refund and cancellation section inside the Terms (directly linkable). */
export const REFUNDS_SECTION_ID = "reembolsos-y-cancelaciones";

export const LEGAL_LINKS = {
  TERMS: "/terminos",
  PRIVACY: "/privacidad",
  REFUNDS: `/terminos#${REFUNDS_SECTION_ID}`,
  SUPPORT: `mailto:${SUPPORT_EMAIL}`,
} as const;
