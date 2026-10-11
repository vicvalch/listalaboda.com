import type { WeddingSummary } from "@/lib/weddings/service";

/**
 * Account entry (`/app`, LB-24A, ADR-017): what the signed-in user sees,
 * decided only from their own membership-based wedding list. Never from a
 * persona, metadata, cookie or stored "active" wedding: the URL stays the
 * only wedding selector.
 *
 * - list failed → error (never read as "no weddings")
 * - 0 weddings → empty state
 * - 1 wedding → straight into it (owner or collaborator alike)
 * - 2+ weddings, or the explicit "Mis bodas" list → the list
 */

/** "Mis bodas" always shows the list, even with one wedding. Presentation only. */
export const MY_WEDDINGS_LIST_PATH = "/app?all=1";

export type WeddingEntry =
  | Readonly<{ kind: "error" }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "redirect"; path: string }>
  | Readonly<{ kind: "list"; weddings: readonly WeddingSummary[] }>;

/** Closed: only `all=1` asks for the list; any other value is ignored. */
export function wantsWeddingList(all: string | string[] | undefined): boolean {
  return all === "1";
}

export function decideWeddingEntry(
  weddings: readonly WeddingSummary[] | null,
  options: Readonly<{ showList: boolean }>,
): WeddingEntry {
  if (weddings === null) return { kind: "error" };
  if (weddings.length === 0) return { kind: "empty" };
  if (weddings.length === 1 && !options.showList) {
    return { kind: "redirect", path: `/app/weddings/${weddings[0].id}` };
  }
  return { kind: "list", weddings };
}
