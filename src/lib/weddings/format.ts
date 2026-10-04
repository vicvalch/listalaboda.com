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

/**
 * Formats a timestamp (`timestamptz`) as a Spanish date and time in the
 * wedding's time zone, or in UTC when the wedding has none (never the
 * server's or browser's local zone). The zone is always named.
 */
export function formatWeddingTimestamp(timestamp: string, timeZone: string | null): string {
  // Explicit fields: dateStyle/timeStyle can't be combined with timeZoneName.
  return formatDate(new Date(timestamp), {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timeZone ?? "UTC",
    timeZoneName: "short",
  });
}
