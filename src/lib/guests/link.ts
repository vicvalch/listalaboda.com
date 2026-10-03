/**
 * Guest link (GuestInvitation token) lifetime and state, derived — never
 * stored (ADR-002 §5: "valid until a defined point after the wedding").
 *
 * Mirrors `private.guest_invitation_expires_at`, which is what actually
 * enforces expiry inside the guest token functions; this copy only labels
 * links for organizers ("Enlace activo", "Vence el …").
 *
 * - Dated wedding: the link works until 00:00 UTC of (wedding date + 31
 *   days) — at least 30 full days after the wedding day in any time zone,
 *   enough for late answers and changes. Moving the wedding moves it.
 * - No wedding date yet: 365 days after the link was generated.
 * - Never infinite. Revoking or generating a new link ends it earlier.
 */

export const GUEST_LINK_DAYS_AFTER_WEDDING = 30;
export const GUEST_LINK_UNDATED_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type GuestLinkState = "active" | "revoked" | "expired";

/** When a link issued at `tokenIssuedAt` stops working, for the CURRENT wedding date. */
export function guestLinkExpiresAt(tokenIssuedAt: string, weddingDate: string | null): Date {
  const match = weddingDate ? ISO_DATE.exec(weddingDate) : null;
  if (match) {
    const [, year, month, day] = match;
    return new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day) + GUEST_LINK_DAYS_AFTER_WEDDING + 1),
    );
  }
  return new Date(new Date(tokenIssuedAt).getTime() + GUEST_LINK_UNDATED_DAYS * DAY_MS);
}

export function guestLinkState(
  link: Readonly<{ tokenIssuedAt: string; revokedAt: string | null }>,
  weddingDate: string | null,
  now: Date,
): GuestLinkState {
  if (link.revokedAt) return "revoked";
  if (now.getTime() >= guestLinkExpiresAt(link.tokenIssuedAt, weddingDate).getTime()) {
    return "expired";
  }
  return "active";
}

/** Path of a guest link. The token travels in the path, never a query string. */
export function guestRsvpPath(token: string): string {
  return `/rsvp/${token}`;
}
