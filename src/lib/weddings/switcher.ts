import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { formatWeddingDate } from "@/lib/weddings/format";
import { listMyWeddings } from "@/lib/weddings/service";

/**
 * The wedding switcher's data (LB-24C, ADR-017): the caller's own
 * memberships through ONE `listMyWeddings` request on their RLS client.
 * Never the overview, never a separate read of the current wedding. Only
 * serializable identity and navigation fields reach the client component.
 */
export type SwitcherWedding = Readonly<{
  id: string;
  name: string;
  /** Formatted date, or null ("Fecha por definir" in the component). */
  dateLabel: string | null;
  city: string | null;
  role: "owner" | "collaborator";
}>;

/** null = list failed or one wedding at most: no switcher (the page renders normally). */
export async function loadSwitcherWeddings(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<SwitcherWedding[] | null> {
  const weddings = await listMyWeddings(supabase, userId);
  if (weddings === null || weddings.length <= 1) return null;
  return weddings.map((wedding) => ({
    id: wedding.id,
    name: wedding.name,
    dateLabel: wedding.weddingDate ? formatWeddingDate(wedding.weddingDate) : null,
    city: wedding.city,
    role: wedding.role,
  }));
}
