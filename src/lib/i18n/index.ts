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

/**
 * Fills `{name}` placeholders in a catalog string. Unknown placeholders are
 * left as-is so a missing value is visible rather than silently blank.
 */
export function interpolate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? values[name] : match,
  );
}

export type { Messages };
