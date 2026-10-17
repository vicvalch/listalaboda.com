import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AccountType } from "@/lib/accounts/account-type";
import { getCoupleBillingStatus, getPlannerBillingStatus } from "@/lib/billing/entitlements";
import { coupleBillingView, plannerBillingView, type CoupleBillingView, type PlannerBillingView } from "@/lib/billing/presentation";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The billing pages' read (BILLING-01): two queries on the user's own RLS
 * client, then the pure view. Null = a read failed (never shown as "not
 * paid"). Reading never writes and never calls Stripe.
 */
export async function loadBillingView(
  supabase: SupabaseClient<Database>,
  userId: string,
  accountType: AccountType,
  available: boolean,
): Promise<PlannerBillingView | CoupleBillingView | null> {
  if (accountType === "planner") {
    const status = await getPlannerBillingStatus(supabase, userId);
    return status ? plannerBillingView(status, available) : null;
  }
  const status = await getCoupleBillingStatus(supabase, userId);
  return status ? coupleBillingView(status, available) : null;
}
