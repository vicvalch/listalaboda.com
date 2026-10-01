import "server-only";

import { createHash, randomBytes } from "node:crypto";

/**
 * MembershipInvite tokens (ADR-002 §5).
 *
 * - 32 bytes (256 bits) from the OS CSPRNG, encoded as base64url (43 chars,
 *   URL-safe, no padding).
 * - Only the SHA-256 hash (lowercase hex) is ever stored. A fast hash is
 *   sufficient because the token itself is high-entropy, not a password.
 * - The plaintext exists only to build the invite link returned to the
 *   owner. Never log it, persist it, or include it in error messages.
 */

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Default validity of a new invite. The database caps it at 30 days. */
export const MEMBERSHIP_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type MembershipInviteToken = Readonly<{
  /** Plaintext token for the invite link. Never store or log it. */
  token: string;
  /** SHA-256 hex digest; the only form persisted. */
  tokenHash: string;
}>;

export function generateMembershipInviteToken(): MembershipInviteToken {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return Object.freeze({ token, tokenHash: hashMembershipInviteToken(token) });
}

/** Cheap shape check for untrusted input (e.g. a token from a URL). */
export function isWellFormedMembershipInviteToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

/**
 * Hashes a token for storage or lookup. Throws on malformed input without
 * echoing it, so callers can treat any failure as "invalid invite".
 */
export function hashMembershipInviteToken(token: string): string {
  if (!isWellFormedMembershipInviteToken(token)) {
    throw new Error("Malformed membership invite token.");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function membershipInviteExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + MEMBERSHIP_INVITE_TTL_MS);
}
