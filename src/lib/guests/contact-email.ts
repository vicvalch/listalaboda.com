import { es } from "@/lib/i18n/messages/es";

/**
 * A party's contact email (GuestInvitation.contact_email): where its
 * invitation is sent. Optional, PRIVATE wedding data (members only).
 *
 * Deliberately conservative, mirroring the database CHECK
 * (`guest_invitations_contact_email_valid`):
 * - trimmed; blank means "no email" (null);
 * - plain ASCII `local@domain.tld`: common local-part characters, dotted
 *   domain labels and a letters-only top-level domain; no spaces, control
 *   characters, quotes-with-spaces or IP literals;
 * - ≤ 254 characters, local part ≤ 64;
 * - only the DOMAIN is lowercased (case-insensitive by definition); the
 *   local part is kept exactly as typed, never silently rewritten.
 *
 * Addresses outside this set (internationalized domains, quoted local
 * parts) are refused with a clear message rather than guessed at.
 */

export const CONTACT_EMAIL_MAX_LENGTH = 254;
export const CONTACT_EMAIL_LOCAL_MAX_LENGTH = 64;

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export type ContactEmailResult =
  | Readonly<{ ok: true; value: string | null }>
  | Readonly<{ ok: false; error: string }>;

/** Normalizes and validates typed input. Blank → `{ ok: true, value: null }` (remove). */
export function parseContactEmail(raw: string): ContactEmailResult {
  const v = es.guests.contactEmail.validation;
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > CONTACT_EMAIL_MAX_LENGTH) return { ok: false, error: v.tooLong };

  const normalized = normalizeContactEmail(trimmed);
  return normalized ? { ok: true, value: normalized } : { ok: false, error: v.invalid };
}

/**
 * The stored form of a syntactically valid address, or null. Pure; also
 * used to re-check a stored value before handing it to the email provider.
 */
export function normalizeContactEmail(value: string): string | null {
  if (value.length > CONTACT_EMAIL_MAX_LENGTH) return null;
  const at = value.lastIndexOf("@");
  if (at <= 0 || value.indexOf("@") !== at) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1).toLowerCase();
  if (local.length > CONTACT_EMAIL_LOCAL_MAX_LENGTH) return null;
  if (!LOCAL_PART.test(local) || !DOMAIN.test(domain)) return null;
  return `${local}@${domain}`;
}

/**
 * LB-18.3 (ADR-011 §14): the form two addresses are COMPARED in for delivery
 * safety (bounced / suppressed / complained blocks, the warning, and "the
 * address changed"): trimmed and lowercased as a whole. Comparison only:
 * stored and displayed values keep their casing, and nothing provider-specific
 * is applied (dots and `+tags` stay significant). The database's twin is
 * `private.email_comparison_form`.
 */
export function normalizeEmailForComparison(email: string): string {
  return email.trim().toLowerCase();
}

/** True when `value` is already in stored form (what the database accepts). */
export function isStoredContactEmail(value: string): boolean {
  return normalizeContactEmail(value) === value;
}
