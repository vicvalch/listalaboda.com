import { es } from "@/lib/i18n/messages/es";
import {
  MINUTES_PER_DAY,
  clockMinutes,
  durationParts,
  endsWithinWindow,
  isTimelinePhase,
  type TimelineDayOffset,
  type TimelinePhase,
} from "@/lib/timeline/presentation";

/**
 * Timeline entry validation (LB-23, ADR-016). Mirrors the
 * `wedding_timeline_entries` CHECKs so the organizer gets a Spanish message
 * per field before a round-trip; the service runs it again before any write
 * and the database stays authoritative. Text is kept as typed (trimmed, never
 * re-cased). Times are strict "HH:MM" wall-clock text: no `Date` is involved.
 */

export const TIMELINE_TITLE_MAX_LENGTH = 120;
export const TIMELINE_LOCATION_MAX_LENGTH = 120;
export const TIMELINE_RESPONSIBLE_MAX_LENGTH = 120;
export const TIMELINE_NOTES_MAX_LENGTH = 4000;
export const TIMELINE_DURATION_MAX_MINUTES = MINUTES_PER_DAY;
export const TIMELINE_DURATION_MAX_HOURS = TIMELINE_DURATION_MAX_MINUTES / 60;

// Control characters (C0, DEL, C1): plain text only.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
// Notes may span lines: line feed, carriage return and tab are allowed.
const NOTES_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WHOLE_NUMBER = /^[0-9]{1,4}$/;

/** What a timeline form posts: every field as typed. */
export type TimelineFormField =
  | "title"
  | "dayOffset"
  | "startTime"
  | "durationHours"
  | "durationMinutes"
  | "phase"
  | "location"
  | "responsibleName"
  | "weddingVendorId"
  | "notes";

/** Form fields plus `duration`, where errors about the combined length land. */
export type TimelineField = TimelineFormField | "duration";

export type TimelineFormValues = Readonly<Record<TimelineFormField, string>>;

/** A normalized entry, exactly as it is stored. */
export type TimelineInput = Readonly<{
  title: string;
  dayOffset: TimelineDayOffset;
  /** Strict "HH:MM"; null = "Sin hora". */
  startTime: string | null;
  durationMinutes: number | null;
  phase: TimelinePhase | null;
  location: string | null;
  responsibleName: string | null;
  weddingVendorId: string | null;
  notes: string | null;
}>;

export type TimelineInputResult =
  | Readonly<{ ok: true; input: TimelineInput }>
  | Readonly<{ ok: false; fieldErrors: Partial<Record<TimelineField, string>> }>;

type FieldResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: string }>;

const v = es.timeline.validation;

function length(value: string): number {
  return [...value].length;
}

function plainText(
  raw: string,
  max: number,
  messages: Readonly<{ required?: string; tooLong: string; invalid: string }>,
): FieldResult<string | null> {
  const value = raw.trim();
  if (!value) return messages.required ? { ok: false, error: messages.required } : { ok: true, value: null };
  if (length(value) > max) return { ok: false, error: messages.tooLong };
  if (CONTROL_CHARACTERS.test(value)) return { ok: false, error: messages.invalid };
  return { ok: true, value };
}

export function parseTimelineTitle(raw: string): FieldResult<string> {
  const result = plainText(raw, TIMELINE_TITLE_MAX_LENGTH, {
    required: v.titleRequired,
    tooLong: v.titleTooLong,
    invalid: v.titleInvalid,
  });
  if (!result.ok) return result;
  return result.value === null ? { ok: false, error: v.titleRequired } : { ok: true, value: result.value };
}

/** "0" (the wedding day) or "1" (after midnight). Never inferred from the time. */
export function parseTimelineDayOffset(raw: string): FieldResult<TimelineDayOffset> {
  const value = raw.trim();
  if (value === "0") return { ok: true, value: 0 };
  if (value === "1") return { ok: true, value: 1 };
  return { ok: false, error: v.dayInvalid };
}

/** Blank → null ("Sin hora"); otherwise strict "HH:MM", 00:00–23:59. */
export function parseTimelineStartTime(raw: string): FieldResult<string | null> {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  return clockMinutes(value) === null ? { ok: false, error: v.startTimeInvalid } : { ok: true, value };
}

/**
 * Hours and minutes → total minutes. Both blank → null (a moment, or not
 * known). One blank alongside a number counts as 0 ("1 h" → 60). Whole
 * numbers only, minutes 0–59, total 1–1440. Typed zeros ("0 h 0 min") are
 * NOT blank: refused.
 */
export function parseTimelineDuration(rawHours: string, rawMinutes: string): FieldResult<number | null> {
  const hoursText = rawHours.trim();
  const minutesText = rawMinutes.trim();
  if (!hoursText && !minutesText) return { ok: true, value: null };
  if ((hoursText && !WHOLE_NUMBER.test(hoursText)) || (minutesText && !WHOLE_NUMBER.test(minutesText))) {
    return { ok: false, error: v.durationInvalid };
  }
  const hours = hoursText ? Number(hoursText) : 0;
  const minutes = minutesText ? Number(minutesText) : 0;
  if (minutes > 59) return { ok: false, error: v.durationInvalid };
  const total = hours * 60 + minutes;
  if (total === 0) return { ok: false, error: v.durationZero };
  if (total > TIMELINE_DURATION_MAX_MINUTES) return { ok: false, error: v.durationTooLong };
  return { ok: true, value: total };
}

/** Blank → no phase. */
export function parseTimelinePhase(raw: string): FieldResult<TimelinePhase | null> {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  return isTimelinePhase(value) ? { ok: true, value } : { ok: false, error: v.phaseInvalid };
}

export function parseTimelineLocation(raw: string): FieldResult<string | null> {
  return plainText(raw, TIMELINE_LOCATION_MAX_LENGTH, { tooLong: v.locationTooLong, invalid: v.locationInvalid });
}

export function parseTimelineResponsible(raw: string): FieldResult<string | null> {
  return plainText(raw, TIMELINE_RESPONSIBLE_MAX_LENGTH, {
    tooLong: v.responsibleTooLong,
    invalid: v.responsibleInvalid,
  });
}

/**
 * Blank → no vendor; otherwise a UUID-shaped id. Whether it is a vendor of
 * THIS wedding is the database's decision (same-wedding composite FK).
 */
export function parseTimelineVendorId(raw: string): FieldResult<string | null> {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  return UUID_PATTERN.test(value) ? { ok: true, value: value.toLowerCase() } : { ok: false, error: v.vendorInvalid };
}

/**
 * Trimmed, ≤ 4000 characters, multiline. Line endings are kept as typed
 * (browsers post CRLF); the database allows \n, \r and \t only.
 */
export function parseTimelineNotes(raw: string): FieldResult<string | null> {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (length(value) > TIMELINE_NOTES_MAX_LENGTH) return { ok: false, error: v.notesTooLong };
  if (NOTES_CONTROL_CHARACTERS.test(value)) return { ok: false, error: v.notesInvalid };
  return { ok: true, value };
}

/**
 * Every field at once, with one Spanish message per invalid field. A timed
 * entry with a duration must end by midnight after the next day (the LB-23
 * window); it is refused, never clipped.
 */
export function parseTimelineInput(raw: TimelineFormValues): TimelineInputResult {
  const fieldErrors: Partial<Record<TimelineField, string>> = {};
  const take = <T>(field: TimelineField, result: FieldResult<T>): T | undefined => {
    if (result.ok) return result.value;
    fieldErrors[field] = result.error;
    return undefined;
  };

  const title = take("title", parseTimelineTitle(raw.title));
  const dayOffset = take("dayOffset", parseTimelineDayOffset(raw.dayOffset));
  const startTime = take("startTime", parseTimelineStartTime(raw.startTime));
  const durationMinutes = take("duration", parseTimelineDuration(raw.durationHours, raw.durationMinutes));
  const phase = take("phase", parseTimelinePhase(raw.phase));
  const location = take("location", parseTimelineLocation(raw.location));
  const responsibleName = take("responsibleName", parseTimelineResponsible(raw.responsibleName));
  const weddingVendorId = take("weddingVendorId", parseTimelineVendorId(raw.weddingVendorId));
  const notes = take("notes", parseTimelineNotes(raw.notes));

  if (
    dayOffset !== undefined &&
    startTime !== undefined &&
    startTime !== null &&
    durationMinutes !== undefined &&
    durationMinutes !== null &&
    !endsWithinWindow(dayOffset, startTime, durationMinutes)
  ) {
    fieldErrors.duration = v.endOutsideWindow;
  }

  if (
    Object.keys(fieldErrors).length > 0 ||
    title === undefined ||
    dayOffset === undefined ||
    startTime === undefined ||
    durationMinutes === undefined ||
    phase === undefined ||
    location === undefined ||
    responsibleName === undefined ||
    weddingVendorId === undefined ||
    notes === undefined
  ) {
    return { ok: false, fieldErrors };
  }

  return {
    ok: true,
    input: { title, dayOffset, startTime, durationMinutes, phase, location, responsibleName, weddingVendorId, notes },
  };
}

/** A stored/parsed entry back to form text: what an edit form starts with. */
export function timelineFormValues(input: TimelineInput): TimelineFormValues {
  const duration = input.durationMinutes === null ? null : durationParts(input.durationMinutes);
  return {
    title: input.title,
    dayOffset: String(input.dayOffset),
    startTime: input.startTime ?? "",
    durationHours: duration ? String(duration.hours) : "",
    durationMinutes: duration ? String(duration.minutes) : "",
    phase: input.phase ?? "",
    location: input.location ?? "",
    responsibleName: input.responsibleName ?? "",
    weddingVendorId: input.weddingVendorId ?? "",
    notes: input.notes ?? "",
  };
}

/** The blank create form: the wedding day, nothing else chosen. */
export const EMPTY_TIMELINE_FORM: TimelineFormValues = {
  title: "",
  dayOffset: "0",
  startTime: "",
  durationHours: "",
  durationMinutes: "",
  phase: "",
  location: "",
  responsibleName: "",
  weddingVendorId: "",
  notes: "",
};

function sameInput(a: TimelineInput, b: TimelineInput): boolean {
  return (Object.keys(a) as (keyof TimelineInput)[]).every((key) => a[key] === b[key]);
}

/**
 * The service's re-check: a `TimelineInput` is accepted only if it is
 * already exactly what `parseTimelineInput` produces (normalized, in range,
 * inside the window). Never trusts that a caller parsed it.
 */
export function isValidTimelineInput(input: TimelineInput): boolean {
  if (input.durationMinutes !== null && !Number.isSafeInteger(input.durationMinutes)) return false;
  const reparsed = parseTimelineInput(timelineFormValues(input));
  return reparsed.ok && sameInput(reparsed.input, input);
}
