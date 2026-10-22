import Link from "next/link";

import { getCurrentAccountType } from "@/lib/accounts/session";
import { getCurrentUser } from "@/lib/auth/session";
import { getMessages } from "@/lib/i18n";

/**
 * The link from a wedding section back to the wedding home (UX-01A). A couple's
 * home is "Mi boda"; planners and not-yet-typed accounts get the neutral label.
 * Presentation only: both reads are request-memoized (the wedding layout already
 * made them), so this adds no request, and the page keeps its own checks.
 */
export async function BackToWeddingLink({ weddingId, className }: { weddingId: string; className: string }) {
  const user = await getCurrentUser();
  const accountType = user ? await getCurrentAccountType(user.id) : null;
  const copy = getMessages().wedding.home;

  return (
    <Link href={`/app/weddings/${weddingId}`} className={className}>
      {accountType === "couple" ? copy.backToCouple : copy.backTo}
    </Link>
  );
}
