import "server-only";

import { createHash, randomBytes } from "node:crypto";

/**
 * The crypto primitive behind the product's link tokens (ADR-002 §5), shared
 * by MembershipInvite and GuestInvitation links. Only the primitive is
 * shared: each domain keeps its own table, service, lifetime and semantics.
 *
 * - 32 bytes (256 bits) from the OS CSPRNG, encoded as base64url (43 chars,
 *   URL-safe, no padding).
 * - Only the SHA-256 hash (lowercase hex) is ever stored. A fast hash is
 *   sufficient because the token itself is high-entropy, not a password.
 * - The plaintext exists only to build the one link returned to the
 *   organizer. Never log it, persist it, or include it in error messages.
 */

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type CapabilityToken = Readonly<{
  /** Plaintext token for the link. Never store or log it. */
  token: string;
  /** SHA-256 hex digest; the only form persisted. */
  tokenHash: string;
}>;

export function generateCapabilityToken(): CapabilityToken {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return Object.freeze({ token, tokenHash: hashCapabilityToken(token) });
}

/** Cheap shape check for untrusted input (e.g. a token from a URL or cookie). */
export function isWellFormedCapabilityToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

/**
 * Hashes a token for storage or lookup. Throws on malformed input without
 * echoing it, so callers can treat any failure as "invalid link".
 */
export function hashCapabilityToken(token: string): string {
  if (!isWellFormedCapabilityToken(token)) {
    throw new Error("Malformed capability token.");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}
