import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { decideWeddingEntry, type WeddingEntry } from "@/lib/weddings/entry";
import { loadWeddingsOverview } from "@/lib/weddings/overview/service";
import type { WeddingsOverview } from "@/lib/weddings/overview/types";
import { listMyWeddings, type WeddingSummary } from "@/lib/weddings/service";

/**
 * `/app` data (LB-24C, ADR-017 §7, ADR-018 §12). The entry is decided from
 * the caller's memberships first; only the list mode pays for the overview,
 * called ONCE with the request's one clock read:
 *
 *   empty / redirect / error → 1 request (the membership list)
 *   list                     → 1 + the overview's 6 = 7
 *   overview error/over_limit → 2 (the list + the overview's own list read)
 *
 * The overview reads the memberships again on purpose (LB-24B stays
 * self-contained); the first list is the fallback when it fails.
 */
export type MyWeddingsPageData =
  | Exclude<WeddingEntry, { kind: "list" }>
  | Readonly<{ kind: "list"; weddings: readonly WeddingSummary[]; overview: WeddingsOverview }>;

export async function loadMyWeddingsPage(
  supabase: SupabaseClient<Database>,
  userId: string,
  options: Readonly<{ showList: boolean; now: Date }>,
): Promise<MyWeddingsPageData> {
  const entry = decideWeddingEntry(await listMyWeddings(supabase, userId), { showList: options.showList });
  if (entry.kind !== "list") return entry;
  return { kind: "list", weddings: entry.weddings, overview: await loadWeddingsOverview(supabase, userId, options.now) };
}
