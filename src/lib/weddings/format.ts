import { formatDate } from "@/lib/i18n";

/**
 * Formats a Postgres `date` (`YYYY-MM-DD`) as a long Spanish date. A
 * calendar date has no time zone, so it's rendered in UTC to never shift
 * by a day.
 */
export function formatWeddingDate(isoDate: string): string {
  return formatDate(new Date(`${isoDate}T00:00:00Z`), { dateStyle: "long", timeZone: "UTC" });
}

/** Formats a timestamp (`timestamptz`) as a medium Spanish date. */
export function formatTimestampDate(timestamp: string): string {
  return formatDate(new Date(timestamp), { dateStyle: "medium" });
}
