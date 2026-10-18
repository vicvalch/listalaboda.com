import type { Metadata } from "next";

import { LegalDocument } from "@/components/legal/LegalDocument";
import { displayPrice } from "@/lib/billing/display-prices";
import { getMessages } from "@/lib/i18n";
import { SUPPORT_EMAIL } from "@/lib/legal/links";
import { marketingMetadata } from "@/lib/marketing/metadata";

const copy = getMessages().legal.terms;

/**
 * The Terms (Batch 1), including the directly linkable refund and
 * cancellation section. Static, like the other marketing pages, and not
 * indexed yet. V1 product policy, pending legal review: the prices come from
 * the display prices, so a price change can't leave a stale copy here.
 */
export const metadata: Metadata = marketingMetadata(copy.metadata);

export default function TermsPage() {
  return (
    <LegalDocument
      title={copy.title}
      intro={copy.intro}
      sections={copy.sections}
      values={{ supportEmail: SUPPORT_EMAIL, plannerPrice: displayPrice("planner"), couplePrice: displayPrice("couple") }}
    />
  );
}
