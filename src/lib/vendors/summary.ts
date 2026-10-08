import { VENDOR_CURRENCIES, type VendorCurrency } from "@/lib/vendors/money";
import {
  VENDOR_CATEGORIES,
  VENDOR_STATUSES,
  VENDOR_STATUS_RANK,
  isVendorCategory,
  isVendorStatus,
  type VendorCategory,
  type VendorStatus,
} from "@/lib/vendors/presentation";

/**
 * The vendor list's derived views (LB-21, ADR-014): counts, the contracted
 * total per currency, category groups, ordering and the local search and
 * filters. Pure and in memory over the one list query: no database, no URL.
 *
 * Money rules: amounts in different currencies are NEVER added together and
 * nothing is converted. Only `booked` vendors' contracted amounts count
 * toward "Contratado"; quotes are never summed (competing quotes for the same
 * service would double count).
 */

/** One row of the list query (no notes, no provenance). */
export type VendorListItem = Readonly<{
  id: string;
  name: string;
  category: VendorCategory;
  customCategory: string | null;
  status: VendorStatus;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  instagramHandle: string | null;
  currency: VendorCurrency | null;
  quotedAmountMinor: number | null;
  contractedAmountMinor: number | null;
  updatedAt: string;
}>;

export type CurrencyTotal = Readonly<{ currency: VendorCurrency; totalMinor: bigint }>;

export type VendorSummary = Readonly<{
  total: number;
  byStatus: Readonly<Record<VendorStatus, number>>;
  /** Booked vendors' contracted amounts, one entry per currency present (CRC, then USD). */
  contractedTotals: readonly CurrencyTotal[];
}>;

export function summarizeVendors(vendors: readonly VendorListItem[]): VendorSummary {
  const byStatus = Object.fromEntries(VENDOR_STATUSES.map((status) => [status, 0])) as Record<VendorStatus, number>;
  // BigInt: a sum of many maximal amounts can pass Number.MAX_SAFE_INTEGER.
  const totals = new Map<VendorCurrency, bigint>();

  for (const vendor of vendors) {
    byStatus[vendor.status] += 1;
    if (vendor.status === "booked" && vendor.contractedAmountMinor !== null && vendor.currency !== null) {
      totals.set(vendor.currency, (totals.get(vendor.currency) ?? BigInt(0)) + BigInt(vendor.contractedAmountMinor));
    }
  }

  return {
    total: vendors.length,
    byStatus,
    contractedTotals: VENDOR_CURRENCIES.flatMap((currency) => {
      const totalMinor = totals.get(currency);
      return totalMinor === undefined ? [] : [{ currency, totalMinor }];
    }),
  };
}

/** The amount a card shows: the contracted amount when there is one, else the quote. */
export type VendorMainAmount = Readonly<{
  kind: "contracted" | "quote";
  minor: number;
  currency: VendorCurrency;
}>;

export function vendorMainAmount(vendor: VendorListItem): VendorMainAmount | null {
  if (vendor.currency === null) return null;
  if (vendor.contractedAmountMinor !== null) {
    return { kind: "contracted", minor: vendor.contractedAmountMinor, currency: vendor.currency };
  }
  if (vendor.quotedAmountMinor !== null) {
    return { kind: "quote", minor: vendor.quotedAmountMinor, currency: vendor.currency };
  }
  return null;
}

// ---------------------------------------------------------------- ordering

const nameCollator = new Intl.Collator("es", { sensitivity: "base" });

/** Most committed first (Contratado → … → Descartado), then by name (Spanish order), then id. */
export function compareVendors(
  a: Pick<VendorListItem, "status" | "name" | "id">,
  b: Pick<VendorListItem, "status" | "name" | "id">,
): number {
  const byRank = VENDOR_STATUS_RANK[a.status] - VENDOR_STATUS_RANK[b.status];
  if (byRank !== 0) return byRank;
  const byName = nameCollator.compare(a.name, b.name);
  if (byName !== 0) return byName;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type VendorCategoryGroup<T extends VendorListItem> = Readonly<{
  category: VendorCategory;
  vendors: readonly T[];
}>;

/** Non-empty groups in category display order, each sorted by `compareVendors`. */
export function groupVendorsByCategory<T extends VendorListItem>(
  vendors: readonly T[],
): readonly VendorCategoryGroup<T>[] {
  return VENDOR_CATEGORIES.flatMap((category) => {
    const inCategory = vendors.filter((vendor) => vendor.category === category);
    return inCategory.length === 0 ? [] : [{ category, vendors: [...inCategory].sort(compareVendors) }];
  });
}

/**
 * The form's currency suggestion: the currency of the most recently updated
 * vendor that has one. A preselection only; the organizer can change it, and
 * it is dropped if no amount is entered.
 */
export function suggestedCurrency(vendors: readonly VendorListItem[]): VendorCurrency | null {
  let latest: VendorListItem | null = null;
  for (const vendor of vendors) {
    if (vendor.currency === null) continue;
    if (!latest || vendor.updatedAt > latest.updatedAt) latest = vendor;
  }
  return latest?.currency ?? null;
}

// ------------------------------------------------------- search + filters

/** Case- and accent-insensitive form: "Fotografía" → "fotografia". */
export function normalizeSearchText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

export type VendorFilters = Readonly<{
  /** Free text, matched against the vendor and contact names only. Never put in a URL. */
  query: string;
  category: VendorCategory | null;
  status: VendorStatus | null;
}>;

export function matchesVendorSearch(vendor: Pick<VendorListItem, "name" | "contactName">, query: string): boolean {
  const needle = normalizeSearchText(query);
  if (!needle) return true;
  return [vendor.name, vendor.contactName].some(
    (field) => field !== null && normalizeSearchText(field).includes(needle),
  );
}

export function filterVendors<T extends VendorListItem>(vendors: readonly T[], filters: VendorFilters): T[] {
  return vendors.filter(
    (vendor) =>
      (filters.category === null || vendor.category === filters.category) &&
      (filters.status === null || vendor.status === filters.status) &&
      matchesVendorSearch(vendor, filters.query),
  );
}

/**
 * `?category=` / `?status=` (presentation only, never a boundary: RLS already
 * decided what is visible). Unknown, repeated or missing values mean "all".
 * The free-text search is deliberately NOT a URL parameter.
 */
export function parseVendorCategoryParam(value: string | string[] | undefined): VendorCategory | null {
  return isVendorCategory(value) ? value : null;
}

export function parseVendorStatusParam(value: string | string[] | undefined): VendorStatus | null {
  return isVendorStatus(value) ? value : null;
}

/** The list URL's query for the two URL-backed filters ("" when none). */
export function vendorFilterQuery(filters: Pick<VendorFilters, "category" | "status">): string {
  const params = new URLSearchParams();
  if (filters.category) params.set("category", filters.category);
  if (filters.status) params.set("status", filters.status);
  const query = params.toString();
  return query ? `?${query}` : "";
}
