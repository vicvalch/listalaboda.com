import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { requireWeddingMembership, type WeddingAccess } from "@/lib/authz/wedding";
import type { Database } from "@/lib/supabase/database.types";
import { isTimelineDayOffset, storedTimeToClock } from "@/lib/timeline/presentation";
import type { TimelineEntry, TimelineVendor } from "@/lib/timeline/summary";
import { isValidTimelineInput, type TimelineInput } from "@/lib/timeline/validation";
import type { VendorCategory, VendorStatus } from "@/lib/vendors/presentation";

/**
 * Wedding timeline application layer (LB-23, ADR-016): one wedding's run of
 * show ("Cronograma"). Any member of the wedding — owner or collaborator —
 * manages it identically; the data is PRIVATE organizer data.
 *
 * Every function takes the current user's RLS-bound client (never the service
 * role) and resolves membership server-side first (`@/lib/authz/wedding`).
 * An entry or vendor id from the browser is a lookup key only: every write is
 * scoped to the authorized wedding, and the database accepts a vendor only
 * from the SAME wedding (composite foreign key). Input is validated again
 * here before any write; database errors map to a closed set of reasons and
 * raw messages never leave this module.
 *
 * Nothing here sends email, writes activity history, schedules anything or
 * touches the checklist, guests, payments or public projections. There is no
 * execution status. Concurrent edits are last-write-wins.
 */

type Client = SupabaseClient<Database>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `not_found` is about the WEDDING (missing or not a member: callers 404).
 * `invalid_target` means the wedding is accessible but the entry isn't in it
 * (deleted a moment ago, another wedding's, made up): indistinguishably.
 * `invalid_vendor`: the chosen vendor isn't a vendor of this wedding (another
 * wedding's, deleted, made up), indistinguishably.
 */
export type TimelineFailureReason =
  | "unauthenticated"
  | "not_found"
  | "forbidden"
  | "invalid_input"
  | "invalid_target"
  | "invalid_vendor"
  | "database_error";

export type TimelineResult =
  | Readonly<{ ok: true; entryId: string }>
  | Readonly<{ ok: false; reason: TimelineFailureReason }>;

type DbError = Readonly<{ code?: string; message?: string }>;

const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const NOT_NULL_VIOLATION = "23502";
const INVALID_TEXT_REPRESENTATION = "22P02";
const INVALID_DATETIME_FORMAT = "22007";
const DATETIME_FIELD_OVERFLOW = "22008";
const INSUFFICIENT_PRIVILEGE = "42501";

/**
 * Maps a database error to a closed reason. Exported for tests. The only
 * foreign key a client write can hit is the same-wedding vendor reference.
 */
export function timelineFailure(error: DbError): TimelineFailureReason {
  switch (error.code) {
    case FOREIGN_KEY_VIOLATION:
      return "invalid_vendor";
    case CHECK_VIOLATION:
    case NOT_NULL_VIOLATION:
    case INVALID_TEXT_REPRESENTATION:
    case INVALID_DATETIME_FORMAT:
    case DATETIME_FIELD_OVERFLOW:
      return "invalid_input";
    case INSUFFICIENT_PRIVILEGE:
      return "forbidden";
    default:
      return "database_error";
  }
}

function fail(reason: TimelineFailureReason): TimelineResult {
  return { ok: false, reason };
}

/**
 * Checks membership, then runs one write scoped to the authorized wedding.
 * Zero affected rows means the entry isn't in this wedding.
 */
async function mutate(
  supabase: Client,
  weddingId: string,
  entryId: string | null,
  run: (access: WeddingAccess) => PromiseLike<{ data: { id: string }[] | null; error: DbError | null }>,
): Promise<TimelineResult> {
  const access = await requireWeddingMembership(supabase, weddingId);
  // An unexpected failure resolving membership is a database error.
  if (!access.ok) return fail(access.reason === "error" ? "database_error" : access.reason);
  // A malformed id can't be an entry of this wedding.
  if (entryId !== null && !UUID_PATTERN.test(entryId)) return fail("invalid_target");

  try {
    const { data, error } = await run(access.access);
    if (error) return fail(timelineFailure(error));
    const row = data?.[0];
    if (!row) return fail("invalid_target");
    return { ok: true, entryId: row.id };
  } catch {
    return fail("database_error");
  }
}

/** The stored columns of a normalized input (never ids, wedding, provenance or timestamps). */
function entryColumns(input: TimelineInput) {
  return {
    title: input.title,
    day_offset: input.dayOffset,
    start_time: input.startTime,
    duration_minutes: input.durationMinutes,
    phase: input.phase,
    location: input.location,
    responsible_name: input.responsibleName,
    wedding_vendor_id: input.weddingVendorId,
    notes: input.notes,
  };
}

// -------------------------------------------------------------------- read

/**
 * The ONLY vendor columns the timeline reads: identification and day-of
 * contact. Never email, Instagram, notes, currency, amounts or payments.
 */
export const TIMELINE_VENDOR_COLUMNS = "id, name, category, custom_category, status, contact_name, phone";

/** The picker's columns: enough to label an option, no contact data. */
const VENDOR_OPTION_COLUMNS = "id, name, category, custom_category, status";

const ENTRY_COLUMNS = `id, title, day_offset, start_time, duration_minutes, phase, location, responsible_name, notes, created_at, wedding_vendors!wedding_timeline_entries_vendor_same_wedding(${TIMELINE_VENDOR_COLUMNS})`;

const WEDDING_COLUMNS = `id, name, wedding_date, time_zone, wedding_vendors!wedding_vendors_wedding_id_fkey(${VENDOR_OPTION_COLUMNS})`;

export type TimelineVendorRow = Readonly<{
  id: string;
  name: string;
  category: VendorCategory;
  custom_category: string | null;
  status: VendorStatus;
  contact_name: string | null;
  phone: string | null;
}>;

/**
 * The timeline's vendor shape, built field by field from the approved
 * projection: whatever else a row might carry is never copied. Exported for
 * tests.
 */
export function toTimelineVendor(row: TimelineVendorRow): TimelineVendor {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    customCategory: row.custom_category,
    status: row.status,
    contactName: row.contact_name,
    phone: row.phone,
  };
}

export type TimelineVendorOption = Readonly<{
  id: string;
  name: string;
  category: VendorCategory;
  customCategory: string | null;
  status: VendorStatus;
}>;

export type TimelineData = Readonly<{
  weddingId: string;
  weddingName: string;
  weddingDate: string | null;
  timeZone: string | null;
  entries: readonly TimelineEntry[];
  /** The wedding's vendors for the picker, by name. */
  vendorOptions: readonly TimelineVendorOption[];
}>;

/**
 * The timeline page's data in TWO queries, whatever the size: the wedding
 * (name, date, time zone) with its vendors embedded for the picker, and every
 * entry with its linked vendor's operational projection embedded (never one
 * query per entry or vendor). Takes the `WeddingAccess` of a successful
 * membership check. Ordering and everything else is derived in memory
 * (`@/lib/timeline/summary`). Returns null on failure.
 */
export async function getTimelineData(supabase: Client, access: WeddingAccess): Promise<TimelineData | null> {
  try {
    const [wedding, entries] = await Promise.all([
      supabase.from("weddings").select(WEDDING_COLUMNS).eq("id", access.weddingId).maybeSingle(),
      supabase
        .from("wedding_timeline_entries")
        .select(ENTRY_COLUMNS)
        .eq("wedding_id", access.weddingId)
        .order("day_offset", { ascending: true })
        .order("start_time", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true })
        .order("id", { ascending: true }),
    ]);
    if (wedding.error || !wedding.data || entries.error || !entries.data) return null;

    const mapped: TimelineEntry[] = [];
    for (const row of entries.data) {
      const startTime = storedTimeToClock(row.start_time);
      // The CHECKs make these impossible; a drifted row fails closed.
      if (!isTimelineDayOffset(row.day_offset) || (row.start_time !== null && startTime === null)) return null;
      mapped.push({
        id: row.id,
        title: row.title,
        dayOffset: row.day_offset,
        startTime,
        durationMinutes: row.duration_minutes,
        phase: row.phase,
        location: row.location,
        responsibleName: row.responsible_name,
        notes: row.notes,
        vendor: row.wedding_vendors ? toTimelineVendor(row.wedding_vendors) : null,
        createdAt: row.created_at,
      });
    }

    const vendorOptions = wedding.data.wedding_vendors
      .map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category,
        customCategory: row.custom_category,
        status: row.status,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "es") || (a.id < b.id ? -1 : 1));

    return {
      weddingId: wedding.data.id,
      weddingName: wedding.data.name,
      weddingDate: wedding.data.wedding_date,
      timeZone: wedding.data.time_zone,
      entries: mapped,
      vendorOptions,
    };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ writes

/** Adds an entry to the wedding's timeline. Provenance and timestamps come from the database. */
export async function createTimelineEntry(
  supabase: Client,
  weddingId: string,
  input: TimelineInput,
): Promise<TimelineResult> {
  if (!isValidTimelineInput(input)) return fail("invalid_input");

  return mutate(supabase, weddingId, null, (access) =>
    supabase
      .from("wedding_timeline_entries")
      .insert({ wedding_id: access.weddingId, ...entryColumns(input) })
      .select("id"),
  );
}

/**
 * Replaces every editable field of one entry in one write (vendor link
 * included). Never moves it to another wedding.
 */
export async function updateTimelineEntry(
  supabase: Client,
  weddingId: string,
  entryId: string,
  input: TimelineInput,
): Promise<TimelineResult> {
  if (!isValidTimelineInput(input)) return fail("invalid_input");

  return mutate(supabase, weddingId, entryId, (access) =>
    supabase
      .from("wedding_timeline_entries")
      .update(entryColumns(input))
      .eq("id", entryId)
      .eq("wedding_id", access.weddingId)
      .select("id"),
  );
}

/** Hard-deletes one entry. The linked vendor is never touched. */
export function deleteTimelineEntry(supabase: Client, weddingId: string, entryId: string): Promise<TimelineResult> {
  return mutate(supabase, weddingId, entryId, (access) =>
    supabase
      .from("wedding_timeline_entries")
      .delete()
      .eq("id", entryId)
      .eq("wedding_id", access.weddingId)
      .select("id"),
  );
}
