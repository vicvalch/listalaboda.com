import "server-only";

import {
  generateCapabilityToken,
  hashCapabilityToken,
  isWellFormedCapabilityToken,
  type CapabilityToken,
} from "@/lib/security/capability-token";

/**
 * MembershipInvite tokens (ADR-002 §5).
 *
 * The crypto primitive (256-bit CSPRNG token, base64url, SHA-256 lowercase
 * hex hash) is shared with GuestInvitation links through
 * `@/lib/security/capability-token`; everything else — lifetime,
 * single-use acceptance, table and service — is this domain's own.
 *
 * The plaintext exists only to build the invite link returned to the
 * owner. Never log it, persist it, or include it in error messages.
 */

/** Default validity of a new invite. The database caps it at 30 days. */
export const MEMBERSHIP_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type MembershipInviteToken = CapabilityToken;

export function generateMembershipInviteToken(): MembershipInviteToken {
  return generateCapabilityToken();
}

/** Cheap shape check for untrusted input (e.g. a token from a URL). */
export function isWellFormedMembershipInviteToken(value: string): boolean {
  return isWellFormedCapabilityToken(value);
}

/**
 * Hashes a token for storage or lookup. Throws on malformed input without
 * echoing it, so callers can treat any failure as "invalid invite".
 */
export function hashMembershipInviteToken(token: string): string {
  if (!isWellFormedCapabilityToken(token)) {
    throw new Error("Malformed membership invite token.");
  }
  return hashCapabilityToken(token);
}

export function membershipInviteExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + MEMBERSHIP_INVITE_TTL_MS);
}
