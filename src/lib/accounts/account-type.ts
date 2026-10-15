import { DEFAULT_NEXT_PATH, safeNextPath } from "@/lib/auth/redirect";
import type { WeddingSummary } from "@/lib/weddings/service";

/**
 * The account type (ACCOUNT-01, ADR-020): one authenticated user is EITHER a
 * wedding planner OR a couple, chosen explicitly once after signing in and
 * never changed (the database enforces it). Pure and dependency-free.
 *
 * It shapes the account's entry and the "create a wedding" affordance; it
 * never grants or restricts access to a wedding (only memberships do,
 * ADR-017 §3).
 */

/** Mirrors the `public.account_type` enum. Values are never removed. */
export const ACCOUNT_TYPES = ["planner", "couple"] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Exactly `planner` or `couple`; anything else (other case, spaces, files) → null. */
export function parseAccountType(value: unknown): AccountType | null {
  return typeof value === "string" && (ACCOUNT_TYPES as readonly string[]).includes(value)
    ? (value as AccountType)
    : null;
}

/** The authenticated first-entry step. Outside `/app`, so the `/app` guard never loops on it. */
export const ACCOUNT_TYPE_ONBOARDING_PATH = "/onboarding/account-type";

/** The onboarding page, carrying a validated continuation when it isn't the default. */
export function accountTypeOnboardingPath(next?: string): string {
  const safe = safeNextPath(next);
  if (safe === DEFAULT_NEXT_PATH || safe.startsWith(ACCOUNT_TYPE_ONBOARDING_PATH)) {
    return ACCOUNT_TYPE_ONBOARDING_PATH;
  }
  return `${ACCOUNT_TYPE_ONBOARDING_PATH}?${new URLSearchParams({ next: safe }).toString()}`;
}

/** Where to continue after the choice (or when it was already made): never back into onboarding. */
export function afterAccountTypePath(next: unknown): string {
  const safe = safeNextPath(next);
  return safe.startsWith(ACCOUNT_TYPE_ONBOARDING_PATH) ? DEFAULT_NEXT_PATH : safe;
}

/**
 * Whether the normal flow offers creating a wedding (ADR-020 §5). Planners:
 * always. Couples: only while they belong to no wedding (their own wedding
 * comes first; a second one is never offered). An unknown wedding count
 * (failed read) denies.
 */
export function canCreateWedding(accountType: AccountType, weddingCount: number | null): boolean {
  if (accountType === "planner") return true;
  return weddingCount === 0;
}

/**
 * `/app` for a couple (ADR-020 §6): "our wedding", never a portfolio.
 *
 * - list failed → error (never empty, never a redirect)
 * - 0 weddings → the couple's empty state (create their wedding)
 * - 1 wedding → straight into it
 * - 2+ weddings → `legacy`: an account from before account types that already
 *   belongs to several weddings. Nothing is deleted, moved or chosen for them:
 *   a plain list of their weddings with a short explanation.
 */
export type CoupleEntry =
  | Readonly<{ kind: "error" }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "redirect"; path: string }>
  | Readonly<{ kind: "legacy"; weddings: readonly WeddingSummary[] }>;

export function decideCoupleEntry(weddings: readonly WeddingSummary[] | null): CoupleEntry {
  if (weddings === null) return { kind: "error" };
  if (weddings.length === 0) return { kind: "empty" };
  if (weddings.length === 1) return { kind: "redirect", path: `/app/weddings/${weddings[0].id}` };
  return { kind: "legacy", weddings };
}
