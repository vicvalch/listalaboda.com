import "server-only";

import type { PlannerTrialCampaign } from "@/lib/billing/campaigns";
import { getBillingConfig } from "@/lib/billing/config";
import { getBillingCustomerRecorder } from "@/lib/billing/customer-recorder";
import type { BillingRuntime } from "@/lib/billing/service";
import { getStripeGateway } from "@/lib/billing/stripe-gateway";

/**
 * Billing's server dependencies from the environment (BILLING-01), or null
 * when any is missing: then nothing is sold and the billing page says so.
 * Reading it is configuration only (no network call).
 */
export function getBillingRuntime(): BillingRuntime | null {
  const config = getBillingConfig();
  const gateway = config ? getStripeGateway() : null;
  const recorder = gateway ? getBillingCustomerRecorder() : null;
  return config && gateway && recorder ? { config, gateway, recorder } : null;
}

export function isBillingAvailable(): boolean {
  return getBillingRuntime() !== null;
}

/** The planner trial campaigns switched on (BILLING-02); none when billing isn't configured. */
export function getEnabledTrialCampaigns(): readonly PlannerTrialCampaign[] {
  return getBillingRuntime()?.config.trialCampaigns ?? [];
}
