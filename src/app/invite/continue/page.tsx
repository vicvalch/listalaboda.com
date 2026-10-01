import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import {
  cardClass,
  primaryButtonClass,
  secondaryButtonClass,
  textLinkClass,
} from "@/components/ui/styles";
import { INVITE_CONTINUE_PATH, loginPath } from "@/lib/auth/redirect";
import { getCurrentUser } from "@/lib/auth/session";
import { getMessages } from "@/lib/i18n";
import { INVITE_HANDOFF_COOKIE } from "@/lib/membership-invites/handoff";
import { isWellFormedMembershipInviteToken } from "@/lib/membership-invites/token";

import { AcceptInviteForm } from "./AcceptInviteForm";
import { switchAccountAction } from "./actions";

export const metadata: Metadata = { title: getMessages().inviteAccept.title };

export const dynamic = "force-dynamic";

/**
 * Resumes a pending invite from the httpOnly handoff cookie. Renders no
 * token: the page only knows whether one is pending. Rendered per request
 * (it reads cookies), never cached.
 *
 * - no / malformed pending invite → generic invalid state
 * - signed out → /login?next=/invite/continue (signup is linked from there)
 * - signed in → explicit "Unirme a la boda" confirmation (a POST)
 */
export default async function InviteContinuePage() {
  const { common, inviteAccept, inviteInvalid } = getMessages();
  const token = (await cookies()).get(INVITE_HANDOFF_COOKIE)?.value;
  const user = await getCurrentUser();

  if (!token || !isWellFormedMembershipInviteToken(token)) {
    return (
      <Shell>
        <section className="space-y-4 text-center" aria-labelledby="invite-invalid-title">
          <h1 id="invite-invalid-title" className="text-2xl font-semibold tracking-tight">
            {inviteInvalid.title}
          </h1>
          <p className="text-muted">{inviteInvalid.body}</p>
          <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:justify-center">
            {user ? (
              <Link href="/app" className={primaryButtonClass}>
                {common.goToMyWeddings}
              </Link>
            ) : (
              <>
                <Link href="/login" className={primaryButtonClass}>
                  {common.login}
                </Link>
                <Link href="/" className={secondaryButtonClass}>
                  {common.goHome}
                </Link>
              </>
            )}
          </div>
        </section>
      </Shell>
    );
  }

  if (!user) redirect(loginPath(INVITE_CONTINUE_PATH));

  return (
    <Shell>
      <section className="space-y-5" aria-labelledby="invite-accept-title">
        <header className="space-y-2">
          <h1 id="invite-accept-title" className="text-2xl font-semibold tracking-tight">
            {inviteAccept.title}
          </h1>
          <p className="text-muted">{inviteAccept.body}</p>
        </header>
        {user.email ? (
          <p className="text-sm">
            {inviteAccept.signedInAs} <span className="font-semibold break-all">{user.email}</span>
          </p>
        ) : null}
        <AcceptInviteForm />
        <form action={switchAccountAction} className="text-sm">
          {inviteAccept.notYou}{" "}
          <button type="submit" className={textLinkClass}>
            {inviteAccept.switchAccount}
          </button>
        </form>
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { common } = getMessages();
  return (
    <main className="flex flex-1 flex-col items-center px-4 py-10 sm:py-16">
      <Link href="/" className="mb-8 text-xl font-semibold tracking-tight">
        {common.brand}
      </Link>
      <div className={`w-full max-w-md ${cardClass}`}>{children}</div>
    </main>
  );
}
