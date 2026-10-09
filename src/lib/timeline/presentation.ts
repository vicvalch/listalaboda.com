import { addDaysToIsoDate } from "@/lib/checklist/timing";
import { formatDate, formatNumber } from "@/lib/i18n";
import { es } from "@/lib/i18n/messages/es";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Timeline presentation (LB-23, ADR-016): the closed phase set and its
 * Spanish labels, wall-clock time arithmetic and formatting, durations and
 * day labels. Pure: no database, no React, no clock.
 *
 * Times are wall-clock values ("15:30"), never instants: they are parsed and
 * formatted as text and minutes, never through a JavaScript `Date`, so no
 * process, browser or wedding time zone can shift what is shown.
 */

export type TimelinePhase = Database["public"]["Enums"]["wedding_timeline_phase"];

/** Form and display order: the day as it unfolds. Mirrors the enum. */
export const TIMELINE_PHASES = [
  "getting_ready",
  "setup",
  "ceremony",
  "photos",
  "cocktail",
  "reception",
  "closing",
] as const satisfies readonly TimelinePhase[];

export function isTimelinePhase(value: unknown): value is TimelinePhase {
  return typeof value === "string" && (TIMELINE_PHASES as readonly string[]).includes(value);
}

export function timelinePhaseLabel(phase: TimelinePhase): string {
  return es.timeline.phases[phase];
}

/** 0 = the wedding day, 1 = the next calendar day (after midnight). Nothing else. */
export type TimelineDayOffset = 0 | 1;

export const TIMELINE_DAY_OFFSETS = [0, 1] as const satisfies readonly TimelineDayOffset[];

export function isTimelineDayOffset(value: unknown): value is TimelineDayOffset {
  return value === 0 || value === 1;
}

export const MINUTES_PER_DAY = 1440;

/** The end of the LB-23 window: midnight at the end of day 1. */
export const TIMELINE_WINDOW_END_MINUTES = 2 * MINUTES_PER_DAY;

// --------------------------------------------------------- wall-clock times

/** Strict "HH:MM", 00:00–23:59: two-digit hours and minutes, nothing else. */
const CLOCK_TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/** Minutes since midnight for a strict "HH:MM", or null. */
export function clockMinutes(value: string): number | null {
  const match = CLOCK_TIME.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** "HH:MM" for minutes since midnight (0–1439). */
export function clockTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/**
 * The stored `time` ("15:30:00", as the Data API returns it) as "HH:MM", or
 * null when it isn't a whole-minute time of day (the database forbids that).
 */
export function storedTimeToClock(value: string | null): string | null {
  if (value === null) return null;
  const match = /^([0-9]{2}:[0-9]{2})(?::00(?:\.0+)?)?$/.exec(value);
  if (!match || clockMinutes(match[1]) === null) return null;
  return match[1];
}

/** Minutes from the start of the wedding day (day 1 00:30 → 1470). */
export function absoluteMinutes(dayOffset: TimelineDayOffset, clock: string): number | null {
  const minutes = clockMinutes(clock);
  return minutes === null ? null : dayOffset * MINUTES_PER_DAY + minutes;
}

export type WallClockPoint = Readonly<{
  /** 0, 1, or 2 only for the very end of the window (midnight after day 1). */
  dayOffset: number;
  /** "HH:MM". */
  time: string;
}>;

/** An absolute minute (from the wedding day's midnight) as a day and "HH:MM". */
export function wallClockPoint(absolute: number): WallClockPoint {
  const dayOffset = Math.floor(absolute / MINUTES_PER_DAY);
  return { dayOffset, time: clockTime(absolute - dayOffset * MINUTES_PER_DAY) };
}

/** Whether a timed span stays inside the window (ends by midnight after day 1). */
export function endsWithinWindow(dayOffset: TimelineDayOffset, clock: string, durationMinutes: number): boolean {
  const start = absoluteMinutes(dayOffset, clock);
  return start !== null && start + durationMinutes <= TIMELINE_WINDOW_END_MINUTES;
}

// --------------------------------------------------------------- durations

/** "45 min", "1 h", "1 h 30 min", "24 h". */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${formatNumber(rest)} min`;
  if (rest === 0) return `${formatNumber(hours)} h`;
  return `${formatNumber(hours)} h ${formatNumber(rest)} min`;
}

/** Whole hours and the remaining minutes, for the form's two fields. */
export function durationParts(minutes: number): Readonly<{ hours: number; minutes: number }> {
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

// -------------------------------------------------------------------- days

/**
 * The calendar date of a timeline day: the CURRENT wedding date plus the
 * offset, or null without a wedding date. Derived, never stored.
 */
export function timelineDayDate(weddingDate: string | null, dayOffset: number): string | null {
  return weddingDate ? addDaysToIsoDate(weddingDate, dayOffset) : null;
}

/**
 * "sábado, 14 de agosto de 2027". A calendar date has no time zone, so it is
 * rendered in UTC to never shift by a day.
 */
export function formatTimelineDate(isoDate: string): string {
  return formatDate(new Date(`${isoDate}T00:00:00Z`), {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export type TimelineDayLabel = Readonly<{
  /** The calendar date when the wedding has one; else "Día de la boda" / "Día siguiente". */
  title: string;
  /** "después de medianoche" for day 1; null for day 0. */
  detail: string | null;
}>;

/** A day section's heading, from the wedding's CURRENT date. */
export function timelineDayLabel(weddingDate: string | null, dayOffset: TimelineDayOffset): TimelineDayLabel {
  const copy = es.timeline.days;
  const date = timelineDayDate(weddingDate, dayOffset);
  const title = date ? formatTimelineDate(date) : dayOffset === 0 ? copy.weddingDay : copy.nextDay;
  return { title, detail: dayOffset === 1 ? copy.afterMidnight : null };
}

/** The short name of a day, for the "Sin hora" rows and the form. */
export function timelineDayName(dayOffset: TimelineDayOffset): string {
  return dayOffset === 0 ? es.timeline.days.weddingDay : es.timeline.days.nextDay;
}
