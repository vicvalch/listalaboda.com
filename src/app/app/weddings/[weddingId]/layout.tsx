import { headers } from "next/headers";

import { requireWeddingEntry } from "@/lib/accounts/session";
import { safeNextPath } from "@/lib/auth/redirect";
import { getCurrentUser } from "@/lib/auth/session";
import { REQUEST_PATH_HEADER } from "@/lib/supabase/proxy";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadSwitcherWeddings } from "@/lib/weddings/switcher";

import { WeddingSwitcher } from "./WeddingSwitcher";

/**
 * Wedding workspace frame (LB-24C, ADR-017): a slim switcher above every
 * wedding page when the caller belongs to 2+ weddings. Not a security
 * boundary: each page still runs its own user and membership checks. The
 * switcher reads only the caller's memberships (one request); if that read
 * fails, the page renders without it. Only a planner's switcher offers
 * creating a wedding (ACCOUNT-01, ADR-020 §5); a couple with several weddings
 * (an account from before account types) can still move between them.
 *
 * It also re-applies the account-type entry rule for THIS wedding (SIT-01):
 * client navigation between weddings re-renders this layout but not the
 * `/app` shell, so an untyped account enters only the wedding it has just
 * joined through an invite; any other goes to the one-time choice.
 */
export default async function WeddingLayout({ children, params }: LayoutProps<"/app/weddings/[weddingId]">) {
  const { weddingId } = await params;
  const user = await getCurrentUser();
  const requestedPath = safeNextPath((await headers()).get(REQUEST_PATH_HEADER) ?? `/app/weddings/${weddingId}`);
  const accountType = user ? await requireWeddingEntry(user.id, weddingId, requestedPath) : null;
  const weddings = user ? await loadSwitcherWeddings(await createSupabaseServerClient(), user.id) : null;
  const canCreate = accountType === "planner";

  return (
    <>
      {weddings ? (
        <div className="mb-6 print:hidden">
          <WeddingSwitcher weddings={weddings} currentId={weddingId} canCreate={canCreate} />
        </div>
      ) : null}
      {children}
    </>
  );
}
