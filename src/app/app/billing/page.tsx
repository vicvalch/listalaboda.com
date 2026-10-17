import type { Metadata } from "next";

import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { cardClass } from "@/components/ui/styles";
import { requireAccountType } from "@/lib/accounts/session";
import { loadBillingView } from "@/lib/billing/billing-page";
import { BILLING_PATH, parseBillingError } from "@/lib/billing/plans";
import type { CoupleBillingView, PlannerBillingView } from "@/lib/billing/presentation";
import { isBillingAvailable } from "@/lib/billing/runtime";
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
 * here (`requireAccountType` → the account-type choice).
 */
export default async function BillingPage({ searchParams }: PageProps<"/app/billing">) {
  const { user, accountType } = await requireAccountType(BILLING_PATH);
  const { billing } = getMessages();
  const available = isBillingAvailable();
  const supabase = await createSupabaseServerClient();
  const view = await loadBillingView(supabase, user.id, accountType, available);
  const error = parseBillingError((await searchParams).error);

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
            <SubmitButton label={billing.planner.subscribe} pendingLabel={billing.planner.subscribing} />
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
            <p className="text-muted text-sm">{billing.priceNote}</p>
          </form>
        ) : null}
      </div>

      <p className="text-muted text-sm">{billing.processorNote}</p>
    </section>
  );
}
