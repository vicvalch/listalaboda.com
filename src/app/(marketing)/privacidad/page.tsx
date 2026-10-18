import type { Metadata } from "next";

import { LegalDocument } from "@/components/legal/LegalDocument";
import { getMessages } from "@/lib/i18n";
import { SUPPORT_EMAIL } from "@/lib/legal/links";
import { marketingMetadata } from "@/lib/marketing/metadata";

const copy = getMessages().legal.privacy;

/**
 * The privacy policy (Batch 1). Static and not indexed yet. V1 product
 * policy, pending legal review: it describes only what the product does today
 * (no analytics, no open/click tracking, deletion on request by email).
 */
export const metadata: Metadata = marketingMetadata(copy.metadata);

export default function PrivacyPage() {
  return (
    <LegalDocument title={copy.title} intro={copy.intro} sections={copy.sections} values={{ supportEmail: SUPPORT_EMAIL }} />
  );
}
