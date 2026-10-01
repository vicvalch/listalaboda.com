/**
 * Spanish (es) message catalog — the product's primary and only UI locale.
 *
 * Group keys by surface. Copy is product language ("pendientes", "boda"),
 * never project-management language.
 */
export const es = {
  metadata: {
    title: "listalaboda.com",
    description: "Organiza tu boda, un pendiente a la vez.",
  },
  home: {
    brand: "listalaboda.com",
    tagline: "Organiza tu boda, un pendiente a la vez.",
    status: "Estamos preparando la base de la aplicación.",
  },
} as const;

/** Shape every future locale catalog must satisfy. */
export type Messages = typeof es;
