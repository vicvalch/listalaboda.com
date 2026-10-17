"use server";

import { redirect } from "next/navigation";

import { requireAccountType } from "@/lib/accounts/session";
import { BILLING_CAMPAIGN_PARAM, billingPathWithCampaign, parsePlannerTrialCampaign } from "@/lib/billing/campaigns";
import { BILLING_PATH, type BillingError } from "@/lib/billing/plans";
import { getBillingRuntime } from "@/lib/billing/runtime";
import { openBillingPortal, startBillingCheckout } from "@/lib/billing/service";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Billing's two actions (BILLING-01, ADR-021). The user, account type,
 * plan, price, mode and customer all come from the server session,
 * configuration and the user's own rows. The ONE form field read is the
 * optional `campaign` key (BILLING-02): a closed value the service resolves
 * against the trial allowlist and the enabled campaigns; it is never a
 * number, a coupon or a promotion code, and is ignored for couples. An
 * untyped account is sent to the one-time account-type choice first
 * (`requireAccountType`), so it can never start a purchase.
 *
 * Both end in a redirect: to Stripe's hosted page, or back to the billing
 * page with a closed `?error=` value. Neither grants anything.
 */

function backWithError(reason: BillingError): never {
  redirect(`${BILLING_PATH}?${new URLSearchParams({ error: reason }).toString()}`);
}

export async function startCheckoutAction(formData?: FormData): Promise<void> {
  const campaign = parsePlannerTrialCampaign(formData?.get(BILLING_CAMPAIGN_PARAM));
  const { user, accountType } = await requireAccountType(billingPathWithCampaign(campaign));
  const supabase = await createSupabaseServerClient();
  const result = await startBillingCheckout({ supabase, userId: user.id, accountType }, getBillingRuntime(), campaign);
  // Outside any try/catch: redirect() throws Next's control-flow signal.
  if (result.ok) redirect(result.url);
  backWithError(result.reason);
}

export async function openPortalAction(): Promise<void> {
  const { user, accountType } = await requireAccountType(BILLING_PATH);
  const supabase = await createSupabaseServerClient();
  const result = await openBillingPortal({ supabase, userId: user.id, accountType }, getBillingRuntime());
  if (result.ok) redirect(result.url);
  backWithError(result.reason);
}
