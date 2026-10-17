import type { Metadata } from "next";
import Link from "next/link";

import { cardClass, primaryButtonClass } from "@/components/ui/styles";
import { requireAccountType } from "@/lib/accounts/session";
import { BILLING_CANCEL_PATH, BILLING_PATH } from "@/lib/billing/plans";
import { getMessages } from "@/lib/i18n";

export const metadata: Metadata = { title: getMessages().billing.cancel.title };

/** Where Stripe Checkout returns when the person leaves without paying (BILLING-01). Changes nothing. */
export default async function BillingCancelPage() {
  await requireAccountType(BILLING_CANCEL_PATH);
  const { cancel } = getMessages().billing;
  return (
    <section className={`${cardClass} mx-auto max-w-xl space-y-4`}>
      <h1 className="text-2xl font-semibold tracking-tight">{cancel.title}</h1>
      <p>{cancel.body}</p>
      <Link href={BILLING_PATH} className={primaryButtonClass}>
        {cancel.back}
      </Link>
    </section>
  );
}
