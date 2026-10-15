import { getCurrentAccountType } from "@/lib/accounts/session";
import { getCurrentUser } from "@/lib/auth/session";
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
 */
export default async function WeddingLayout({ children, params }: LayoutProps<"/app/weddings/[weddingId]">) {
  const { weddingId } = await params;
  const user = await getCurrentUser();
  const weddings = user ? await loadSwitcherWeddings(await createSupabaseServerClient(), user.id) : null;
  const canCreate = user ? (await getCurrentAccountType(user.id)) === "planner" : false;

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
