import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { secondaryButtonClass } from "@/components/ui/styles";
import { accountTypeOnboardingPath, afterAccountTypePath } from "@/lib/accounts/account-type";
import { AccountTypeUnavailableError, getCurrentAccountType } from "@/lib/accounts/session";
import { requireUser } from "@/lib/auth/session";
import { getMessages } from "@/lib/i18n";

import { logoutAction } from "../../app/actions";
import { AccountTypeForm } from "./AccountTypeForm";

export const metadata: Metadata = { title: getMessages().accountType.title };

/**
 * First authenticated entry (ACCOUNT-01, ADR-020): the one-time choice
 * between a wedding planner and a couple account. Signed out → /login; an
 * account that already has a type never sees the choice again and continues
 * to its destination. `next` only says where to continue afterwards.
 */
export default async function AccountTypePage({ searchParams }: PageProps<"/onboarding/account-type">) {
  const params = await searchParams;
  const next = afterAccountTypePath(typeof params.next === "string" ? params.next : undefined);
  const user = await requireUser(accountTypeOnboardingPath(next));
  const accountType = await getCurrentAccountType(user.id);
  if (accountType === undefined) throw new AccountTypeUnavailableError();
  // Outside any try/catch: redirect() throws Next's control-flow signal.
  if (accountType !== null) redirect(next);

  const { accountType: copy, app } = getMessages();
  return (
    <div className="space-y-8">
      <header className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{copy.title}</h1>
        <p className="text-muted">{copy.intro}</p>
      </header>
      <AccountTypeForm next={next} />
      <div className="flex flex-wrap items-center justify-center gap-3 border-t border-border pt-6 text-sm">
        {user.email ? (
          <p className="text-muted max-w-full truncate">
            <span className="sr-only">{app.nav.signedInAs} </span>
            {user.email}
          </p>
        ) : null}
        <form action={logoutAction}>
          <button type="submit" className={`${secondaryButtonClass} min-h-9 px-3 py-1.5`}>
            {app.nav.logout}
          </button>
        </form>
      </div>
    </div>
  );
}
