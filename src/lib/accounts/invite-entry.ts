/**
 * Invite completion without the account-type choice (SIT-01, ADR-020).
 *
 * An invitation decides a person's ROLE in one wedding, never their account
 * type. So someone who has just accepted an invite enters that wedding even
 * if their account has no type yet; the type stays unchosen until they reach
 * the rest of the app normally (`/app`), where the one-time choice applies.
 *
 * The exception is derived from the database, never from the request: the
 * caller's own `wedding_memberships` row for THAT wedding, created within
 * the window below. An account without a type can't create a wedding
 * (`create_wedding` refuses it), so for it such a row can only come from
 * `accept_membership_invite`. No query parameter, cookie or form value is
 * involved. Pure and dependency-free.
 */

/** How long after joining an untyped account may keep entering the wedding without the choice. */
export const INVITE_ENTRY_WINDOW_SECONDS = 30 * 60;

// Tolerates a server clock slightly behind the database's.
const CLOCK_SKEW_SECONDS = 60;

const WEDDING_PATH = /^\/app\/weddings\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;

/** The wedding id of a `/app/weddings/{id}…` path (any section), else null (`/app`, `/app/weddings/new`, …). */
export function weddingIdOfAppPath(path: string | null | undefined): string | null {
  if (!path) return null;
  return WEDDING_PATH.exec(path)?.[1]?.toLowerCase() ?? null;
}

/** Whether a membership created at `createdAt` (database clock) is still within the invite window. */
export function isRecentInviteJoin(createdAt: unknown, nowMs: number): boolean {
  if (typeof createdAt !== "string") return false;
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return false;
  const ageSeconds = (nowMs - createdMs) / 1000;
  return ageSeconds >= -CLOCK_SKEW_SECONDS && ageSeconds <= INVITE_ENTRY_WINDOW_SECONDS;
}
