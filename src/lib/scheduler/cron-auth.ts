import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The scheduler route's authentication (LB-17, ADR-010 §4). The ONLY module
 * that reads `process.env.CRON_SECRET` (ESLint-enforced).
 *
 * Responsibilities, and nothing else:
 *   - parse the `CRON_SECRET` configuration;
 *   - enforce the minimum secret requirements (≥ 32 bytes, no whitespace or
 *     control characters);
 *   - validate an `Authorization: Bearer <secret>` header with a timing-safe
 *     comparison (SHA-256 digests of equal length, compared with
 *     `timingSafeEqual`).
 *
 * It has no Supabase client, never reads the service-role key, calls no RPC
 * or email sender, holds no business policy and never runs the scheduler.
 * The secret is never logged, returned or echoed; a query string is never
 * consulted (the caller passes only the header).
 */

export const CRON_SECRET_MIN_BYTES = 32;

const INVALID_CHARACTERS = /[\s\u0000-\u001f\u007f-\u009f]/;

export type CronSecret = Readonly<{ digest: Buffer }>;

export type CronAuthResult = "authorized" | "unauthorized" | "not_configured";

/** Pure: the configured secret's digest, or null when missing or too weak. */
export function parseCronSecret(raw: string | undefined): CronSecret | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (INVALID_CHARACTERS.test(raw)) return null;
  if (Buffer.byteLength(raw, "utf8") < CRON_SECRET_MIN_BYTES) return null;
  return { digest: createHash("sha256").update(raw, "utf8").digest() };
}

/** Reads `CRON_SECRET` from the server environment. */
export function getCronSecret(): CronSecret | null {
  return parseCronSecret(process.env.CRON_SECRET);
}

const BEARER = /^Bearer ([^\s]+)$/;

/**
 * Checks an `Authorization` header value against the configured secret.
 * Without a valid configuration nothing is authorized.
 */
export function authenticateCronRequest(
  authorizationHeader: string | null,
  secret: CronSecret | null,
): CronAuthResult {
  if (!secret) return "not_configured";
  const presented = authorizationHeader ? BEARER.exec(authorizationHeader)?.[1] : undefined;
  // Always hash and compare, even for a missing header, so the work done
  // doesn't depend on what was presented.
  const candidate = createHash("sha256").update(presented ?? "", "utf8").digest();
  const matches = timingSafeEqual(candidate, secret.digest);
  return presented !== undefined && matches ? "authorized" : "unauthorized";
}
