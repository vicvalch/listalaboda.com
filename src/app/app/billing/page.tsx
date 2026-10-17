import type { Metadata } from "next";

import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { cardClass } from "@/components/ui/styles";
import { requireAccountType } from "@/lib/accounts/session";
import { loadBillingView } from "@/lib/billing/billing-page";
import { BILLING_CAMPAIGN_PARAM, billingPathWithCampaign, resolvePlannerTrial } from "@/lib/billing/campaigns";
import { displayPrice } from "@/lib/billing/display-prices";
import { parseBillingError } from "@/lib/billing/plans";
import type { CoupleBillingView, PlannerBillingView } from "@/lib/billing/presentation";
import { getEnabledTrialCampaigns, isBillingAvailable } from "@/lib/billing/runtime";
import { formatDate, getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import { openPortalAction, startCheckoutAction } from "./actions";

export const metadata: Metadata = { title: getMessages().billing.title };

/** Billing dates are account-level (no wedding time zone): shown as UTC calendar dates. */
function billingDate(iso: string): string {
  return formatDate(new Date(iso), { dateStyle: "long", timeZone: "UTC" });
}

function PlannerDetails({ view }: { view: PlannerBillingView }) {
  const copy = getMessages().billing.planner;
  const body = {
    active: copy.activeBody,
    trialing: copy.trialingBody,
    problem: copy.problemBody,
    none: copy.noneBody,
  }[view.state];
  return (
    <>
      <p>{body}</p>
      {view.periodEnd ? (
        <p className="text-muted text-sm">
          {(view.cancelAtPeriodEnd ? copy.endsOn : copy.renewsOn).replace("{date}", billingDate(view.periodEnd))}
        </p>
      ) : null}
    </>
  );
}

function CoupleDetails({ view }: { view: CoupleBillingView }) {
  const copy = getMessages().billing.couple;
  const body = { active: copy.activeBody, pending: copy.pendingBody, none: copy.noneBody }[view.state];
  return (
    <>
      <p>{body}</p>
      {view.paidAt ? <p className="text-muted text-sm">{copy.paidOn.replace("{date}", billingDate(view.paidAt))}</p> : null}
    </>
  );
}

/**
 * The account's plan (BILLING-01, ADR-021): planners see their monthly
 * subscription, couples their one-time access. Everything shown comes from
 * the database (kept current by the verified Stripe webhook); the page
 * never calls Stripe and never grants anything. Untyped accounts never get
 * here (`requireAccountType` → the account-type choice, keeping a valid
 * `?campaign=` key).
 *
 * BILLING-02: the frozen display price; promotion codes are typed in Stripe
 * Checkout (the page only says so). A planner trial is SHOWN only when the
 * same rule the Checkout action applies would grant it
 * (`resolvePlannerTrial`); the action re-resolves it, so this display is
 * never the authority. An unknown or disabled campaign is silently ignored.
 */
export default async function BillingPage({ searchParams }: PageProps<"/app/billing">) {
  const query = await searchParams;
  const { user, accountType } = await requireAccountType(billingPathWithCampaign(query[BILLING_CAMPAIGN_PARAM]));
  const { billing } = getMessages();
  const available = isBillingAvailable();
  const supabase = await createSupabaseServerClient();
  const view = await loadBillingView(supabase, user.id, accountType, available);
  const error = parseBillingError(query.error);
  const price = displayPrice(accountType);
  const trial =
    view?.kind === "planner" && view.action === "subscribe"
      ? resolvePlannerTrial({
          accountType,
          requested: query[BILLING_CAMPAIGN_PARAM],
          enabled: getEnabledTrialCampaigns(),
          hasSubscriptionHistory: view.everSubscribed,
        })
      : null;

  const plan = accountType === "planner" ? billing.planner : billing.couple;
  const statusLabel = view
    ? view.kind === "planner"
      ? billing.planner.status[view.state]
      : billing.couple.status[view.state]
    : null;

  return (
    <section className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{billing.title}</h1>
      {error ? <Notice tone="error">{billing.errors[error]}</Notice> : null}
      {!available ? <Notice tone="info">{billing.notAvailable}</Notice> : null}

      <div className={`${cardClass} space-y-4`} data-testid="billing-plan">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">{plan.planName}</h2>
          <p className="text-muted text-sm">{plan.cadence}</p>
        </div>
        {trial ? (
          <div className="space-y-1" data-testid="billing-trial">
            <p className="text-xl font-semibold">{billing.planner.trialOffer.replace("{days}", String(trial.days))}</p>
            <p data-testid="billing-price">{billing.planner.trialThen.replace("{price}", price)}</p>
          </div>
        ) : (
          <p className="text-xl font-semibold" data-testid="billing-price">
            {plan.price.replace("{price}", price)}
          </p>
        )}

        {view ? (
          <>
            <p className="text-sm">
              <span className="text-muted">{billing.statusLabel}: </span>
              <strong data-testid="billing-status">{statusLabel}</strong>
            </p>
            {view.kind === "planner" ? <PlannerDetails view={view} /> : <CoupleDetails view={view} />}
          </>
        ) : (
          <Notice tone="error">{billing.statusUnavailable}</Notice>
        )}

        {view?.kind === "planner" && view.action === "subscribe" ? (
          <form action={startCheckoutAction} className="space-y-2">
            {/* A closed campaign key only; the action resolves it again (never a number of days). */}
            {trial ? <input type="hidden" name={BILLING_CAMPAIGN_PARAM} value={trial.campaign} /> : null}
            <SubmitButton
              label={trial ? billing.planner.startTrial : billing.planner.subscribe}
              pendingLabel={billing.planner.subscribing}
            />
            {trial ? <p className="text-muted text-sm">{billing.planner.trialNote}</p> : null}
            <p className="text-muted text-sm">{billing.promoNote}</p>
            <p className="text-muted text-sm">{billing.priceNote}</p>
          </form>
        ) : null}
        {view?.kind === "planner" && view.action === "manage" ? (
          <form action={openPortalAction}>
            <SubmitButton
              label={billing.planner.manage}
              pendingLabel={billing.planner.managing}
              variant={view.state === "problem" ? "primary" : "secondary"}
            />
          </form>
        ) : null}
        {view?.kind === "couple" && view.action === "buy" ? (
          <form action={startCheckoutAction} className="space-y-2">
            <SubmitButton label={billing.couple.buy} pendingLabel={billing.couple.buying} />
            <p className="text-muted text-sm">{billing.promoNote}</p>
            <p className="text-muted text-sm">{billing.priceNote}</p>
          </form>
        ) : null}
      </div>

      <p className="text-muted text-sm">{billing.processorNote}</p>
    </section>
  );
}
