import type { WeddingRole } from "@/lib/authz/wedding";

/**
 * Wedding switching (LB-24C, ADR-017). Pure: no auth, Supabase or React.
 * The current wedding exists only in the URL; switching is plain navigation
 * to another wedding the switcher was given (the caller's own memberships).
 */

const WEDDINGS_PREFIX = "/app/weddings/";

/** Sections that exist for every member and keep their place on a switch. */
const SHARED_SECTIONS = ["guests", "seating", "vendors", "budget", "timeline", "site", "activity"] as const;

export type SwitchTarget = Readonly<{ id: string; role: WeddingRole }>;

/**
 * Where switching from `pathname` to `target` leads: the same KNOWN section
 * in the target wedding, else its home. `vendors/*` opens the vendor list
 * (a vendor id never belongs to another wedding); settings are kept only
 * when the target role is owner. Query strings and hashes are always
 * dropped: view modes, filters and flags never cross weddings.
 */
export function switchWeddingPath(pathname: string, target: SwitchTarget): string {
  const home = `${WEDDINGS_PREFIX}${encodeURIComponent(target.id)}`;
  const path = pathname.split(/[?#]/, 1)[0];
  if (!path.startsWith(WEDDINGS_PREFIX)) return home;

  // ["<weddingId>", "<section>", ...rest]
  const [, section, ...rest] = path.slice(WEDDINGS_PREFIX.length).split("/");
  if (section === undefined || section === "") return home;

  if (section === "settings") {
    return rest.every((part) => part === "") && target.role === "owner" ? `${home}/settings` : home;
  }
  if (section === "vendors") return `${home}/vendors`;
  if ((SHARED_SECTIONS as readonly string[]).includes(section) && rest.every((part) => part === "")) {
    return `${home}/${section}`;
  }
  return home;
}

/** Accent- and case-insensitive comparison form (Spanish), for the switcher's local search. */
export function searchForm(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("es");
}

/** True when the trimmed query is empty or appears in the wedding's name or city. */
export function matchesWeddingSearch(
  wedding: Readonly<{ name: string; city: string | null }>,
  query: string,
): boolean {
  const needle = searchForm(query.trim());
  if (needle === "") return true;
  return searchForm(wedding.name).includes(needle) || (wedding.city !== null && searchForm(wedding.city).includes(needle));
}
