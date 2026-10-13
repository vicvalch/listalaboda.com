import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { toWeddingSiteDesign, type WeddingSiteDesign } from "@/lib/wedding-site/design/resolve";
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
 * Content and presentation come back separately: `site` (what the couple
 * published) and `design` (the chosen theme and its customization,
 * ADR-019). No theme, or one this code doesn't know, is Classic; the stored
 * customization is re-read here, field by field, and never trusted.
 *
 * A malformed, unknown or unpublished slug is the same `unavailable`, so a
 * site's existence can't be probed before it is published.
 */

type Client = SupabaseClient<Database>;

export type PublishedSiteResult =
  | Readonly<{ ok: true; site: PublishedWeddingSite; design: WeddingSiteDesign }>
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
    // Every row repeats the design. Read as unknown: a database from before
    // the theme or customization column (deploy skew) has none, which is
    // Classic / no customization.
    const first = data[0] as { site_theme?: unknown; site_customization?: unknown } | undefined;
    return { ok: true, site, design: toWeddingSiteDesign(first?.site_theme, first?.site_customization) };
  } catch {
    return { ok: false, reason: "error" };
  }
}
