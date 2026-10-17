import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  parseSubscriptionStatus,
  subscriptionGrantsAccess,
  type BillingEntitlementKey,
  type BillingSubscriptionStatus,
} from "@/lib/billing/plans";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Paid access, read from the DATABASE as the current user through their own
 * RLS-bound client (BILLING-01, ADR-021 §9). Stripe is never called on a
 * request: the webhook keeps `billing_entitlements` current.
 *
 * Entitlements are product access only: they never authorize wedding data
 * (memberships do, Constitution §11) and nothing gates on them yet
 * (ADR-021 §11 is the proposed matrix).
 */

type Client = SupabaseClient<Database>;

export type EntitlementState = "active" | "inactive";

/**
 * The user's entitlement for `key`: `active`, `inactive` (no row, or lapsed),
 * or null when the read failed. Callers must never read a failure as active.
 */
export async function getBillingEntitlement(
  supabase: Client,
  userId: string,
  key: BillingEntitlementKey,
): Promise<EntitlementState | null> {
  try {
    const { data, error } = await supabase
      .from("billing_entitlements")
      .select("status")
      .eq("user_id", userId)
      .eq("entitlement_key", key)
      .maybeSingle();
    if (error) return null;
    return data?.status === "active" ? "active" : "inactive";
  } catch {
    return null;
  }
}

/** Fail-closed boolean form: a failed read is "no". */
export async function hasEntitlement(supabase: Client, userId: string, key: BillingEntitlementKey): Promise<boolean> {
  return (await getBillingEntitlement(supabase, userId, key)) === "active";
}

export type PlannerBillingStatus = Readonly<{
  kind: "planner";
  entitlement: EntitlementState;
  /** Newest first; display only (the entitlement decides). */
  subscriptions: readonly Readonly<{
    status: BillingSubscriptionStatus;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  }>[];
}>;

export type CoupleBillingStatus = Readonly<{
  kind: "couple";
  entitlement: EntitlementState;
  /** Newest first. */
  purchases: readonly Readonly<{ status: Database["public"]["Enums"]["billing_purchase_status"]; purchasedAt: string | null }>[];
}>;

/** Everything the billing page shows, in two reads; null when either failed. */
export async function getPlannerBillingStatus(supabase: Client, userId: string): Promise<PlannerBillingStatus | null> {
  try {
    const [entitlement, subscriptions] = await Promise.all([
      getBillingEntitlement(supabase, userId, "planner_pro"),
      supabase
        .from("billing_subscriptions")
        .select("status, current_period_end, cancel_at_period_end")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);
    if (entitlement === null || subscriptions.error) return null;
    return {
      kind: "planner",
      entitlement,
      subscriptions: subscriptions.data.flatMap((row) => {
        const status = parseSubscriptionStatus(row.status);
        return status
          ? [{ status, currentPeriodEnd: row.current_period_end, cancelAtPeriodEnd: row.cancel_at_period_end }]
          : [];
      }),
    };
  } catch {
    return null;
  }
}

export async function getCoupleBillingStatus(supabase: Client, userId: string): Promise<CoupleBillingStatus | null> {
  try {
    const [entitlement, purchases] = await Promise.all([
      getBillingEntitlement(supabase, userId, "couple_access"),
      supabase
        .from("billing_purchases")
        .select("status, purchased_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);
    if (entitlement === null || purchases.error) return null;
    return {
      kind: "couple",
      entitlement,
      purchases: purchases.data.map((row) => ({ status: row.status, purchasedAt: row.purchased_at })),
    };
  } catch {
    return null;
  }
}

/** The subscription a planner's page talks about: a granting one, else the newest. */
export function currentSubscription(status: PlannerBillingStatus): PlannerBillingStatus["subscriptions"][number] | null {
  return status.subscriptions.find((s) => subscriptionGrantsAccess(s.status)) ?? status.subscriptions[0] ?? null;
}
