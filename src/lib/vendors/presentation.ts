import { es } from "@/lib/i18n/messages/es";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Vendor presentation (LB-21, ADR-014): the closed category and status sets,
 * their Spanish labels and display order, and the only links the app ever
 * renders for a vendor (mailto:, tel:, and an Instagram profile URL built
 * from a validated handle). Pure: no database calls, no React.
 */

export type VendorCategory = Database["public"]["Enums"]["wedding_vendor_category"];
export type VendorStatus = Database["public"]["Enums"]["wedding_vendor_status"];

/** Display (and form) order: roughly the order couples book them. Mirrors the enum. */
export const VENDOR_CATEGORIES = [
  "venue",
  "catering",
  "photography",
  "video",
  "music",
  "flowers_decor",
  "cake_desserts",
  "beauty",
  "attire",
  "officiant",
  "stationery",
  "transport",
  "lodging",
  "rentals",
  "planning",
  "other",
] as const satisfies readonly VendorCategory[];

/** Form order: the path from first contact to contract, then the way out. */
export const VENDOR_STATUSES = [
  "considering",
  "quoted",
  "selected",
  "booked",
  "discarded",
] as const satisfies readonly VendorStatus[];

export const DEFAULT_VENDOR_STATUS: VendorStatus = "considering";

export function isVendorCategory(value: unknown): value is VendorCategory {
  return typeof value === "string" && (VENDOR_CATEGORIES as readonly string[]).includes(value);
}

export function isVendorStatus(value: unknown): value is VendorStatus {
  return typeof value === "string" && (VENDOR_STATUSES as readonly string[]).includes(value);
}

/**
 * Within a category, the most committed vendors first; discarded ones last
 * (still listed, muted). Lower rank sorts first.
 */
export const VENDOR_STATUS_RANK: Readonly<Record<VendorStatus, number>> = {
  booked: 0,
  selected: 1,
  quoted: 2,
  considering: 3,
  discarded: 4,
};

export function vendorCategoryLabel(category: VendorCategory): string {
  return es.vendors.categories[category];
}

export function vendorStatusLabel(status: VendorStatus): string {
  return es.vendors.statuses[status];
}

/** "Fotografía", or the vendor's own type ("Seguridad") for `other`. */
export function vendorCategoryDisplay(
  vendor: Readonly<{ category: VendorCategory; customCategory: string | null }>,
): string {
  if (vendor.category === "other" && vendor.customCategory) return vendor.customCategory;
  return vendorCategoryLabel(vendor.category);
}

// ------------------------------------------------------------------- links

/** The stored handle form (`wedding_vendors_instagram_handle_valid`): no "@", no URL. */
export const INSTAGRAM_HANDLE_PATTERN = /^[A-Za-z0-9._]{1,30}$/;

/**
 * The profile URL for a VALIDATED handle, or null. Never a user-supplied URL:
 * the only variable part is a handle of letters, digits, dots and underscores.
 */
export function instagramProfileUrl(handle: string): string | null {
  if (!INSTAGRAM_HANDLE_PATTERN.test(handle)) return null;
  return `https://www.instagram.com/${handle}/`;
}

/** The stored phone form (`wedding_vendors_phone_valid`). */
export const PHONE_PATTERN = /^\+?\(?[0-9][0-9 ().-]*[0-9]$/;

/** `tel:` with only "+" and digits; the displayed number stays as typed. */
export function phoneHref(phone: string): string | null {
  if (!PHONE_PATTERN.test(phone)) return null;
  return `tel:${phone.replace(/[^0-9+]/g, "")}`;
}

/**
 * `mailto:` for a stored address. The local part may legally contain
 * characters that mean something in a URL ("?", "#", "%"), so it is encoded;
 * the stored domain is already lowercase letters, digits, dots and hyphens.
 */
export function mailtoHref(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;
  const domain = email.slice(at + 1);
  if (!/^[a-z0-9.-]+$/.test(domain)) return null;
  return `mailto:${encodeURIComponent(email.slice(0, at))}@${domain}`;
}
