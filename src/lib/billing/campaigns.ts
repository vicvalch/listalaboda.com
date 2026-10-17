import type { AccountType } from "@/lib/accounts/account-type";
import { BILLING_PATH } from "@/lib/billing/plans";

/**
 * Planner free-trial campaigns (BILLING-02, ADR-021 §15). Pure and
 * dependency-free.
 *
 * A campaign is a closed SEMANTIC key (`planner_trial_14`), never a number:
 * the browser may name one (`/app/billing?campaign=planner_trial_14`), and
 * the server maps it to its trial length here. No other input decides a
 * trial, and no numeric duration is ever read from a request.
 *
 * A key grants a trial only when ALL of these hold, checked on the server
 * at Checkout time (`resolvePlannerTrial`):
 *   - the account is a planner (a couple's one-time payment has no trial);
 *   - the campaign is in this allowlist AND enabled by configuration
 *     (`PLANNER_TRIAL_CAMPAIGNS`, `@/lib/billing/config`; none by default);
 *   - the planner has never had a subscription (no repeat trials).
 * Otherwise the key is ignored: a normal subscription, no error.
 */

/** The approved campaigns and their trial length in days. Keys are never reused for another length. */
export const PLANNER_TRIAL_CAMPAIGNS = {
  planner_trial_7: 7,
  planner_trial_14: 14,
  planner_trial_30: 30,
} as const;

export type PlannerTrialCampaign = keyof typeof PLANNER_TRIAL_CAMPAIGNS;

export const PLANNER_TRIAL_CAMPAIGN_KEYS = Object.keys(PLANNER_TRIAL_CAMPAIGNS) as readonly PlannerTrialCampaign[];

/** The query parameter (and form field) that names a campaign. */
export const BILLING_CAMPAIGN_PARAM = "campaign";

export type PlannerTrial = Readonly<{ campaign: PlannerTrialCampaign; days: number }>;

/** A known campaign key, exactly; anything else (numbers, other text, arrays) is null. */
export function parsePlannerTrialCampaign(value: unknown): PlannerTrialCampaign | null {
  return typeof value === "string" && (PLANNER_TRIAL_CAMPAIGN_KEYS as readonly string[]).includes(value)
    ? (value as PlannerTrialCampaign)
    : null;
}

/** The enabled campaigns from configuration: a comma-separated list of keys; unknown entries are dropped. */
export function parseEnabledTrialCampaigns(raw: string | undefined): readonly PlannerTrialCampaign[] {
  const enabled = new Set<PlannerTrialCampaign>();
  for (const part of (raw ?? "").split(",")) {
    const campaign = parsePlannerTrialCampaign(part.trim());
    if (campaign) enabled.add(campaign);
  }
  return [...enabled];
}

/**
 * The trial a Checkout gets, or null (no trial). `hasSubscriptionHistory`
 * = the planner has any subscription row, in any status.
 */
export function resolvePlannerTrial(input: {
  accountType: AccountType;
  requested: unknown;
  enabled: readonly PlannerTrialCampaign[];
  hasSubscriptionHistory: boolean;
}): PlannerTrial | null {
  if (input.accountType !== "planner" || input.hasSubscriptionHistory) return null;
  const campaign = parsePlannerTrialCampaign(input.requested);
  if (!campaign || !input.enabled.includes(campaign)) return null;
  return { campaign, days: PLANNER_TRIAL_CAMPAIGNS[campaign] };
}

/** The billing page, keeping a VALID campaign key (only a closed value is ever echoed). */
export function billingPathWithCampaign(requested: unknown): string {
  const campaign = parsePlannerTrialCampaign(requested);
  return campaign ? `${BILLING_PATH}?${new URLSearchParams({ [BILLING_CAMPAIGN_PARAM]: campaign }).toString()}` : BILLING_PATH;
}
