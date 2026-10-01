import { es, type Messages } from "./messages/es";

/** The product ships in Spanish only (Constitution §13). No locale routing. */
export const DEFAULT_LOCALE = "es";

export type Locale = typeof DEFAULT_LOCALE;

const catalogs: Record<Locale, Messages> = { es };

export function getMessages(locale: Locale = DEFAULT_LOCALE): Messages {
  return catalogs[locale];
}

/** Locale-aware date formatting; all user-facing dates go through Intl. */
export function formatDate(
  date: Date,
  options: Intl.DateTimeFormatOptions = { dateStyle: "long" },
  locale: Locale = DEFAULT_LOCALE,
): string {
  return new Intl.DateTimeFormat(locale, options).format(date);
}

/** Locale-aware number formatting (counts, percentages, currency later). */
export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export type { Messages };
