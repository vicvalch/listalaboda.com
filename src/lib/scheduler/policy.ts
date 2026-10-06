import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { requireWeddingRole, type WeddingAccess } from "@/lib/authz/wedding";
import {
  DEFAULT_AUTOMATIC_REMINDER_DAYS_BEFORE,
  isAutomaticReminderDaysBefore,
  type AutomaticReminderDaysBefore,
} from "@/lib/scheduler/timing";
import type { Database } from "@/lib/supabase/database.types";

/**
 * A wedding's automatic RSVP reminder policy (LB-17, ADR-010 §5), through the
 * member's OWN session (RLS), never the service role.
 *
 * - Reading: any member (owners and collaborators) — collaborators see the
 *   status, read-only. No row = OFF with the default 21 days.
 * - Writing: owners only — this service checks the role first, and the
 *   database function (`set_rsvp_reminder_policy`) checks it again from
 *   `auth.uid()`. Enabling needs the wedding's date and time zone (database-
 *   enforced too). Turning it on stamps `enabled_at` (database clock).
 */

type Client = SupabaseClient<Database>;

export type AutomaticReminderPolicy = Readonly<{
  enabled: boolean;
  daysBefore: AutomaticReminderDaysBefore;
  /** Database clock at the latest off → on switch; null if never enabled. */
  enabledAt: string | null;
}>;

export const DEFAULT_AUTOMATIC_REMINDER_POLICY: AutomaticReminderPolicy = {
  enabled: false,
  daysBefore: DEFAULT_AUTOMATIC_REMINDER_DAYS_BEFORE,
  enabledAt: null,
};

/** The wedding's policy (default OFF), or null when it couldn't be read. */
export async function getAutomaticReminderPolicy(
  supabase: Client,
  access: WeddingAccess,
): Promise<AutomaticReminderPolicy | null> {
  try {
    const { data, error } = await supabase
      .from("wedding_rsvp_reminder_policies")
      .select("enabled, days_before, enabled_at")
      .eq("wedding_id", access.weddingId)
      .maybeSingle();
    if (error) return null;
    if (!data) return DEFAULT_AUTOMATIC_REMINDER_POLICY;
    return {
      enabled: data.enabled,
      daysBefore: isAutomaticReminderDaysBefore(data.days_before)
        ? data.days_before
        : DEFAULT_AUTOMATIC_REMINDER_DAYS_BEFORE,
      enabledAt: data.enabled_at,
    };
  } catch {
    return null;
  }
}

export type SetPolicyInput = Readonly<{ enabled: boolean; daysBefore: number }>;

export type SetPolicyResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      reason: "unauthenticated" | "not_found" | "forbidden" | "invalid" | "needs_date" | "error";
    }>;

/** Owners only: turns automatic reminders on or off and picks 14, 21 or 30 days. */
export async function setAutomaticReminderPolicy(
  supabase: Client,
  weddingId: string,
  input: SetPolicyInput,
): Promise<SetPolicyResult> {
  const access = await requireWeddingRole(supabase, weddingId, ["owner"]);
  if (!access.ok) return { ok: false, reason: access.reason };
  if (typeof input.enabled !== "boolean" || !isAutomaticReminderDaysBefore(input.daysBefore)) {
    return { ok: false, reason: "invalid" };
  }

  try {
    const { data, error } = await supabase.rpc("set_rsvp_reminder_policy", {
      target_wedding_id: access.access.weddingId,
      reminders_enabled: input.enabled,
      reminder_days_before: input.daysBefore,
    });
    if (error) {
      if (error.message.includes("rsvp_reminder_policy_needs_date")) return { ok: false, reason: "needs_date" };
      if (error.code === "42501") return { ok: false, reason: "forbidden" };
      if (error.code === "22023") return { ok: false, reason: "invalid" };
      return { ok: false, reason: "error" };
    }
    // false: no longer a member since the check.
    return data === true ? { ok: true } : { ok: false, reason: "not_found" };
  } catch {
    return { ok: false, reason: "error" };
  }
}
