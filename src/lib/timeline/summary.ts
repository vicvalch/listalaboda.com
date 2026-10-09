import type { VendorCategory, VendorStatus } from "@/lib/vendors/presentation";
import {
  MINUTES_PER_DAY,
  TIMELINE_PHASES,
  absoluteMinutes,
  clockTime,
  timelineDayDate,
  wallClockPoint,
  type TimelineDayOffset,
  type TimelinePhase,
  type WallClockPoint,
} from "@/lib/timeline/presentation";
import { weddingLocalNow } from "@/lib/weddings/timezone";

/**
 * Timeline derivations (LB-23, ADR-016): canonical order, the timed/untimed
 * split, derived ends, day sections, "Ahora / Siguiente" and the overview.
 * Pure: no database, no React, and no clock — the caller passes `now`.
 *
 * Everything compares wedding-relative wall-clock minutes: minute 0 is
 * midnight starting the wedding day, 1440 midnight starting the next day,
 * 2880 the end of the LB-23 window. Nothing here is stored.
 */

/**
 * The linked vendor as the timeline sees it: identification and day-of
 * contact only. Never email, Instagram, notes, money or payments.
 */
export type TimelineVendor = Readonly<{
  id: string;
  name: string;
  category: VendorCategory;
  customCategory: string | null;
  status: VendorStatus;
  contactName: string | null;
  phone: string | null;
}>;

export type TimelineEntry = Readonly<{
  id: string;
  title: string;
  dayOffset: TimelineDayOffset;
  /** "HH:MM" wall clock; null = "Sin hora". */
  startTime: string | null;
  durationMinutes: number | null;
  phase: TimelinePhase | null;
  location: string | null;
  responsibleName: string | null;
  notes: string | null;
  vendor: TimelineVendor | null;
  createdAt: string;
}>;

// ----------------------------------------------------------------- spans

export type TimelineSpan = Readonly<{
  /** Minutes from midnight starting the wedding day. */
  start: number;
  /** Null for a moment (no duration). */
  end: number | null;
}>;

/** The wall-clock span of a timed entry; null when it has no start time. */
export function entrySpan(entry: TimelineEntry): TimelineSpan | null {
  if (entry.startTime === null) return null;
  const start = absoluteMinutes(entry.dayOffset, entry.startTime);
  if (start === null) return null;
  return { start, end: entry.durationMinutes === null ? null : start + entry.durationMinutes };
}

/**
 * The derived end as a day and "HH:MM": day 0 23:45 + 60 → day 1 00:45;
 * day 1 23:30 + 30 → day 2 00:00 (the end of the window). Null without a
 * start time or without a duration.
 */
export function entryEnd(entry: TimelineEntry): WallClockPoint | null {
  const span = entrySpan(entry);
  return span?.end == null ? null : wallClockPoint(span.end);
}

// -------------------------------------------------------------- ordering

function compareCreated(a: TimelineEntry, b: TimelineEntry): number {
  const at = Date.parse(a.createdAt);
  const bt = Date.parse(b.createdAt);
  if (at !== bt && !Number.isNaN(at) && !Number.isNaN(bt)) return at - bt;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The canonical order: day, timed before untimed, start time, then creation
 * (created_at, id) — simultaneous entries keep the order they were added.
 */
export function compareTimelineEntries(a: TimelineEntry, b: TimelineEntry): number {
  if (a.dayOffset !== b.dayOffset) return a.dayOffset - b.dayOffset;
  const as = entrySpan(a);
  const bs = entrySpan(b);
  if (as === null && bs !== null) return 1;
  if (as !== null && bs === null) return -1;
  if (as !== null && bs !== null && as.start !== bs.start) return as.start - bs.start;
  return compareCreated(a, b);
}

/** A sorted copy in canonical order; the input is never reordered. */
export function sortTimelineEntries<T extends TimelineEntry>(entries: readonly T[]): T[] {
  return [...entries].sort(compareTimelineEntries);
}

export type TimelineDaySection<T extends TimelineEntry> = Readonly<{
  dayOffset: TimelineDayOffset;
  /** The calendar date from the CURRENT wedding date, or null without one. */
  date: string | null;
  entries: readonly T[];
}>;

export type TimelineSections<T extends TimelineEntry> = Readonly<{
  /** Timed entries by day, only days that have any, in canonical order. */
  days: readonly TimelineDaySection<T>[];
  /** "Sin hora": entries without a start time, by day then creation. */
  untimed: readonly T[];
}>;

/** Splits the timeline into its day sections and the "Sin hora" bucket. */
export function timelineSections<T extends TimelineEntry>(
  entries: readonly T[],
  weddingDate: string | null,
): TimelineSections<T> {
  const sorted = sortTimelineEntries(entries);
  const timed = sorted.filter((entry) => entry.startTime !== null);
  const days = ([0, 1] as const)
    .map((dayOffset) => ({
      dayOffset,
      date: timelineDayDate(weddingDate, dayOffset),
      entries: timed.filter((entry) => entry.dayOffset === dayOffset),
    }))
    .filter((day) => day.entries.length > 0);
  return { days, untimed: sorted.filter((entry) => entry.startTime === null) };
}

// --------------------------------------------------------- current / next

export type TimelineContext = Readonly<{
  /** The wedding's CURRENT date (`YYYY-MM-DD`), or null. */
  weddingDate: string | null;
  /** The wedding's IANA time zone, or null: then nothing is "now". */
  timeZone: string | null;
  /** One clock read by the caller. */
  now: Date;
}>;

export type TimelineNow<T extends TimelineEntry> = Readonly<{
  /** Wedding-local now, in timeline minutes. */
  minutes: number;
  /** Wedding-local now as "HH:MM". */
  time: string;
  /** Every timed entry with a duration whose span contains now (overlaps allowed). */
  currentEntries: readonly T[];
  /** Every timed entry sharing the earliest start after now (moments included). */
  nextEntries: readonly T[];
}>;

/**
 * Wedding-local now in timeline minutes, or null when the panel must not
 * show: no wedding date, no time zone, an unknown zone, or a wedding-local
 * calendar day that is neither the wedding day nor the day after. Never the
 * process or browser time zone.
 */
export function timelineNowMinutes(context: TimelineContext): number | null {
  const { weddingDate, timeZone, now } = context;
  if (!weddingDate || !timeZone) return null;
  const local = weddingLocalNow(timeZone, now);
  if (!local) return null;
  if (local.date === weddingDate) return local.minutes;
  if (local.date === timelineDayDate(weddingDate, 1)) return MINUTES_PER_DAY + local.minutes;
  return null;
}

/**
 * "Ahora / Siguiente", derived from the clock, never stored. Untimed entries
 * are never either; moments (no duration) can be next but never current.
 * Past entries are simply past: nothing is "late".
 */
export function timelineNow<T extends TimelineEntry>(
  entries: readonly T[],
  context: TimelineContext,
): TimelineNow<T> | null {
  const minutes = timelineNowMinutes(context);
  if (minutes === null) return null;
  const sorted = sortTimelineEntries(entries);
  const currentEntries = sorted.filter((entry) => {
    const span = entrySpan(entry);
    return span !== null && span.end !== null && span.start <= minutes && minutes < span.end;
  });
  let nextStart: number | null = null;
  for (const entry of sorted) {
    const span = entrySpan(entry);
    if (span !== null && span.start > minutes && (nextStart === null || span.start < nextStart)) nextStart = span.start;
  }
  const nextEntries = nextStart === null ? [] : sorted.filter((entry) => entrySpan(entry)?.start === nextStart);
  return { minutes, time: clockTime(minutes % MINUTES_PER_DAY), currentEntries, nextEntries };
}

// ------------------------------------------------------------- overview

export type TimelineOverview<T extends TimelineEntry> = Readonly<{
  entryCount: number;
  timedCount: number;
  untimedCount: number;
  /** The earliest and latest start, or null with no timed entry. */
  firstStart: WallClockPoint | null;
  lastStart: WallClockPoint | null;
  /** Distinct linked vendors, in timeline order. */
  vendorIds: readonly string[];
  phaseCounts: Readonly<Record<TimelinePhase, number>>;
  /** Present only when the context makes "now" meaningful (see `timelineNow`). */
  now: TimelineNow<T> | null;
}>;

/** What the page header (and a future dashboard, LB-24) can show. */
export function timelineOverview<T extends TimelineEntry>(
  entries: readonly T[],
  context?: TimelineContext,
): TimelineOverview<T> {
  const sorted = sortTimelineEntries(entries);
  const starts = sorted.flatMap((entry) => {
    const span = entrySpan(entry);
    return span ? [span.start] : [];
  });
  const vendorIds: string[] = [];
  const phaseCounts = Object.fromEntries(TIMELINE_PHASES.map((phase) => [phase, 0])) as Record<TimelinePhase, number>;
  for (const entry of sorted) {
    if (entry.vendor && !vendorIds.includes(entry.vendor.id)) vendorIds.push(entry.vendor.id);
    if (entry.phase) phaseCounts[entry.phase] += 1;
  }
  return {
    entryCount: sorted.length,
    timedCount: starts.length,
    untimedCount: sorted.length - starts.length,
    firstStart: starts.length > 0 ? wallClockPoint(Math.min(...starts)) : null,
    lastStart: starts.length > 0 ? wallClockPoint(Math.max(...starts)) : null,
    vendorIds,
    phaseCounts,
    now: context ? timelineNow(sorted, context) : null,
  };
}
