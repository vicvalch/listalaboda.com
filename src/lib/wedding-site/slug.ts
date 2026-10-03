import { es } from "@/lib/i18n/messages/es";

/**
 * The wedding website's public address: `/boda/<slug>`. A slug is a public
 * locator, not a secret and not an authorization input: it resolves only
 * while the wedding is published.
 *
 * Canonical form: lowercase ASCII letters and digits in words joined by
 * single hyphens, 3–80 characters, not a reserved word. Mirrors the
 * database CHECKs on `wedding_publications.slug`, which stay authoritative
 * (as does its global uniqueness).
 *
 * What the owner types is saved as typed (only surrounding whitespace is
 * trimmed): no silent lowercasing or transliteration on save. A suggestion
 * from the wedding name is only ever a prefilled, editable value.
 */

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 80;

/** Words that read as the app's own routes. Mirrors the database CHECK. */
export const RESERVED_SLUGS: readonly string[] = [
  "admin",
  "api",
  "app",
  "auth",
  "boda",
  "invite",
  "login",
  "rsvp",
  "signup",
];

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const PUBLIC_SITE_BASE_PATH = "/boda";

/** The public path of a site. Only call with a canonical slug. */
export function publicSitePath(slug: string): string {
  return `${PUBLIC_SITE_BASE_PATH}/${slug}`;
}

/** Canonical, allowed slug (format, length, not reserved). */
export function isValidSlug(value: string): boolean {
  return (
    value.length >= SLUG_MIN_LENGTH &&
    value.length <= SLUG_MAX_LENGTH &&
    SLUG_PATTERN.test(value) &&
    !RESERVED_SLUGS.includes(value)
  );
}

export type SlugResult =
  | Readonly<{ ok: true; slug: string }>
  | Readonly<{ ok: false; error: string }>;

export function parseSlug(raw: string): SlugResult {
  const messages = es.site.slug.validation;
  const value = raw.trim();
  if (!value) return { ok: false, error: messages.required };
  if (value.length < SLUG_MIN_LENGTH) return { ok: false, error: messages.tooShort };
  if (value.length > SLUG_MAX_LENGTH) return { ok: false, error: messages.tooLong };
  if (!SLUG_PATTERN.test(value)) return { ok: false, error: messages.invalid };
  if (RESERVED_SLUGS.includes(value)) return { ok: false, error: messages.reserved };
  return { ok: true, slug: value };
}

/**
 * A deterministic suggestion from the wedding name ("Boda de Ana y Luis" →
 * "boda-de-ana-y-luis"): accents removed, lowercased, anything else becomes
 * a single hyphen. Returns "" when nothing valid comes out. Never saved by
 * itself.
 */
export function suggestSlug(name: string): string {
  const words = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suggestion = words.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, "");
  return isValidSlug(suggestion) ? suggestion : "";
}
