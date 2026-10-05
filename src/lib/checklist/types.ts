import type { Database } from "@/lib/supabase/database.types";

/**
 * Checklist domain types. The closed sets come from the generated database
 * types (Postgres enums), so TypeScript and the database can't drift.
 */

type Enums = Database["public"]["Enums"];

export type ChecklistStatus = Enums["checklist_item_status"];
export type ChecklistCategory = Enums["checklist_category"];
export type ChecklistTimingMode = Enums["checklist_timing_mode"];

export const CHECKLIST_STATUSES: readonly ChecklistStatus[] = ["pending", "done", "not_applicable"];

/** Display order of the fixed category set (Constitution §5). */
export const CHECKLIST_CATEGORIES: readonly ChecklistCategory[] = [
  "first_steps",
  "venue_and_date",
  "vendors",
  "attire",
  "invitations",
  "ceremony",
  "reception",
  "final_preparations",
  "after_wedding",
];

export function isChecklistStatus(value: string): value is ChecklistStatus {
  return (CHECKLIST_STATUSES as readonly string[]).includes(value);
}

export function isChecklistCategory(value: string): value is ChecklistCategory {
  return (CHECKLIST_CATEGORIES as readonly string[]).includes(value);
}

/**
 * When an item is due, as stored: a rule, never a derived date.
 * `relativeDays` < 0 is before the wedding, 0 the wedding day, > 0 after.
 */
export type ChecklistTiming =
  | Readonly<{ mode: "none" }>
  | Readonly<{ mode: "absolute"; dueDate: string }>
  | Readonly<{ mode: "relative_to_wedding"; relativeDays: number }>;

/** A wedding's checklist item as the app uses it (no provenance internals). */
export type ChecklistItem = Readonly<{
  id: string;
  title: string;
  description: string | null;
  category: ChecklistCategory | null;
  status: ChecklistStatus;
  timing: ChecklistTiming;
  sortOrder: number;
  /**
   * The wedding member responsible for the item (a membership of the same
   * wedding), or null: "Sin asignar". Planning metadata, never authorization.
   */
  assigneeMembershipId: string | null;
  /**
   * The guest party (GuestInvitation) of the same wedding this item is
   * about, or null. Navigation and context only (LB-16, ADR-009): never
   * authorization, and nothing about the party is copied onto the item.
   */
  guestInvitationId: string | null;
}>;
