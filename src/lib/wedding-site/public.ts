import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import {
  toPublishedSite,
  type PublishedSiteRow,
  type PublishedWeddingSite,
} from "@/lib/wedding-site/sections";
import { isValidSlug } from "@/lib/wedding-site/slug";

/**
 * The public read path of the wedding website: no account, no membership,
 * no token. A slug is only a locator; the database function
 * `get_published_wedding_site` decides everything (published or not, which
 * sections are visible) and returns a fixed safe projection, shaped here
 * into the public DTO. Whatever session the client carries is irrelevant.
 *
 * A malformed, unknown or unpublished slug is the same `unavailable`, so a
 * site's existence can't be probed before it is published.
 */

type Client = SupabaseClient<Database>;

export type PublishedSiteResult =
  | Readonly<{ ok: true; site: PublishedWeddingSite }>
  | Readonly<{ ok: false; reason: "unavailable" | "error" }>;

export async function getPublishedWeddingSite(
  supabase: Client,
  slug: string,
): Promise<PublishedSiteResult> {
  if (!isValidSlug(slug)) return { ok: false, reason: "unavailable" };
  try {
    const { data, error } = await supabase.rpc("get_published_wedding_site", { site_slug: slug });
    if (error || !data) return { ok: false, reason: "error" };
    // The generated return type marks every column non-null; section fields
    // (and date/city) can be null, so they are read as nullable.
    const rows: readonly PublishedSiteRow[] = data;
    const site = toPublishedSite(slug, rows);
    if (!site) return { ok: false, reason: "unavailable" };
    return { ok: true, site };
  } catch {
    return { ok: false, reason: "error" };
  }
}
