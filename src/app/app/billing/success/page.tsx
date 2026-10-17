import type { Metadata } from "next";
import Link from "next/link";

import { Notice } from "@/components/ui/Notice";
import { cardClass, primaryButtonClass, secondaryButtonClass } from "@/components/ui/styles";
import { requireAccountType } from "@/lib/accounts/session";
import { loadBillingView } from "@/lib/billing/billing-page";
import { BILLING_PATH, BILLING_SUCCESS_PATH } from "@/lib/billing/plans";
import { isBillingAvailable } from "@/lib/billing/runtime";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import { ActivationRefresh } from "./ActivationRefresh";

export const metadata: Metadata = { title: getMessages().billing.success.pendingTitle };

/**
 * Where Stripe Checkout returns (BILLING-01, ADR-021 §10). Reaching this URL
 * proves NOTHING: anyone can open it. It never writes and reads no query
 * parameter; it shows what the DATABASE says. Until the verified webhook has
 * activated the entitlement it only says the payment is being confirmed, and
 * re-reads the page a few times (bounded).
 */
export default async function BillingSuccessPage() {
  const { user, accountType } = await requireAccountType(BILLING_SUCCESS_PATH);
  const { billing } = getMessages();
  const copy = billing.success;
  const supabase = await createSupabaseServerClient();
  const view = await loadBillingView(supabase, user.id, accountType, isBillingAvailable());
  const confirmed = view !== null && (view.state === "active" || view.state === "trialing");

  return (
    <section className={`${cardClass} mx-auto max-w-xl space-y-4`} data-testid="billing-success">
      {confirmed ? (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">{copy.confirmedTitle}</h1>
          <Notice tone="success">{accountType === "planner" ? copy.plannerConfirmed : copy.coupleConfirmed}</Notice>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">{copy.pendingTitle}</h1>
          <p>{copy.pendingBody}</p>
          <ActivationRefresh hint={copy.pendingHint} slow={copy.slow} />
        </>
      )}
      <div className="flex flex-wrap gap-3">
        <Link href={BILLING_PATH} className={confirmed ? secondaryButtonClass : primaryButtonClass}>
          {copy.back}
        </Link>
        {confirmed ? (
          <Link href="/app" className={primaryButtonClass}>
            {copy.home}
          </Link>
        ) : null}
      </div>
    </section>
  );
}
